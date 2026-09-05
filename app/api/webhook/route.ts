/**
 * /app/api/webhook/route.ts
 *
 * Next.js API route that handles incoming Razorpay webhooks.
 *
 * Supported events (see EVENT_SEMANTICS):
 *  - payment.captured / payment_link.paid / order.paid / subscription.charged
 *      -> money collected; transaction becomes 'recovered'
 *  - payment.failed
 *      -> attempt failed; transaction returns to 'failed' (never downgrades a
 *         transaction that is already recovered)
 *  - payment_link.cancelled / payment_link.expired
 *      -> the recovery channel is gone; the 'awaiting_gateway_capture' hold is
 *         released and the transaction returns to 'failed' for re-evaluation
 *  - refund.processed
 *      -> a recovery was REVERSED. A full refund clears `recovered` and marks the
 *         transaction 'unrecoverable', because money that went back to the
 *         customer must stop counting towards recovered GMV. A partial refund is
 *         recorded in the ledger with the net figure and leaves the state alone.
 *  - anything else -> acknowledged and logged as unhandled, with no state change
 *
 * Features:
 *  - Mandatory HMAC-SHA256 signature verification via Razorpay SDK helper
 *  - Idempotent processing via unique Razorpay eventId in AuditLog. Where Razorpay
 *    supplies no event id, one is DERIVED FROM THE BODY CONTENT rather than the
 *    clock: a wall-clock fallback made every redelivery look like a brand new
 *    event, which is precisely the case idempotency exists to stop.
 *  - The state mutation and its ledger row are committed in a single
 *    `prisma.$transaction`, so a crash between them cannot leave a recovered
 *    transaction with no evidence, or evidence of a recovery that never landed.
 *
 * Response contract (deliberate — Razorpay retries on non-2xx):
 *  - 200 for outcomes that are settled and must NOT be retried: successful
 *    processing, a duplicate event already in the ledger, and a validly-signed
 *    event with no matching transaction (nothing to do, retrying won't help).
 *  - 400 for a missing/invalid signature or missing secret — unauthenticated,
 *    so it is rejected outright rather than acknowledged.
 *  - 500 for a validly-signed, new event that failed mid-processing. This is
 *    intentional: it asks Razorpay to redeliver so the event is not silently
 *    lost, and the eventId idempotency guard makes redelivery safe.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { prisma } from '@/lib/prisma';
import { verifyWebhookSignature } from '@/lib/razorpay';
import { buildAuditData, isDuplicateEventError, type AuditMetadata } from '@/lib/audit-logger';

/** Events that confirm money was collected. */
const RECOVERY_EVENTS = new Set([
  'payment.captured',
  'payment_link.paid',
  'order.paid',
  'subscription.charged',
]);

/** Events that mean the outbound recovery channel is dead but the debt remains. */
const CHANNEL_CLOSED_EVENTS = new Set([
  'payment_link.cancelled',
  'payment_link.expired',
]);

/** Events that reverse a previously confirmed recovery. */
const REVERSAL_EVENTS = new Set(['refund.processed']);

type ResolvedEntity = {
  /** Razorpay ids to try against `Transaction.externalPaymentId`, most specific first. */
  candidateIds: string[];
  /** Our own transaction id, if any entity carried it in `notes`. */
  notesTransactionId: string | null;
  /** The single id most representative of this event, for `AuditLog.razorpayEntityId`. */
  primaryEntityId: string | null;
  /** Amount this event concerns, in paise, where the payload states one. */
  amountPaise: number | null;
};

/**
 * Pull identifiers out of a Razorpay webhook body.
 *
 * Razorpay nests the subject under `payload.<entity>.entity`, and which key that
 * is depends entirely on the event: `payment`, `payment_link`, `order`,
 * `subscription`, or `refund`. Reading only the first three — as this route did —
 * meant a `subscription.charged` or `refund.processed` event could never be
 * matched to a transaction and was silently acknowledged as a no-op.
 *
 * For refunds the useful id is `payment_id`, not the `rfnd_…` id: the refund is a
 * new object, but the transaction we hold is keyed on the payment being reversed.
 */
function resolveEntity(payload: any): ResolvedEntity {
  const payment = payload?.payload?.payment?.entity;
  const paymentLink = payload?.payload?.payment_link?.entity;
  const order = payload?.payload?.order?.entity;
  const subscription = payload?.payload?.subscription?.entity;
  const refund = payload?.payload?.refund?.entity;

  const candidateIds = [
    paymentLink?.id, // plink_… — what auto_retry stores on the transaction
    subscription?.id, // sub_…
    refund?.payment_id, // the payment a refund reverses
    payment?.order_id, // order_… carried on a payment
    order?.id, // order_…
    payment?.id, // pay_…
    refund?.id, // rfnd_… (last resort)
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  const notesTransactionId =
    payment?.notes?.transactionId ||
    paymentLink?.notes?.transactionId ||
    order?.notes?.transactionId ||
    subscription?.notes?.transactionId ||
    refund?.notes?.transactionId ||
    null;

  const amountRaw =
    refund?.amount ??
    paymentLink?.amount_paid ??
    payment?.amount ??
    paymentLink?.amount ??
    order?.amount ??
    null;

  return {
    candidateIds: [...new Set(candidateIds)],
    notesTransactionId,
    primaryEntityId:
      payment?.id ?? paymentLink?.id ?? subscription?.id ?? refund?.id ?? order?.id ?? null,
    amountPaise: typeof amountRaw === 'number' ? amountRaw : null,
  };
}

/**
 * Idempotency key for the event.
 *
 * Razorpay sends `x-razorpay-event-id` on live deliveries, but test payloads and
 * some replay tooling omit it. The previous fallback was `evt_${Date.now()}`,
 * which is unique per *call* rather than per *event* — so the same body posted
 * twice produced two distinct keys and was processed twice, defeating the guard
 * entirely. Hashing the body makes a redelivery of identical content collide with
 * the original by construction.
 */
function resolveEventId(req: NextRequest, payload: any, rawBody: string): string {
  const supplied =
    req.headers.get('x-razorpay-event-id') || payload?.event_id || payload?.id;
  if (typeof supplied === 'string' && supplied.length > 0) return supplied;
  return `evt_sha_${crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 40)}`;
}

import { proxyOrNull } from '@/lib/proxy-or-handle';

export async function POST(req: NextRequest) {
  const proxy = await proxyOrNull(req);
  if (proxy) return proxy;
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-razorpay-signature');

    // 1. Signature Verification with candidate secrets
    const candidateSecrets = [
      process.env.RAZORPAY_WEBHOOK_SECRET,
      process.env.RAZORPAY_KEY_SECRET,
    ].filter(Boolean) as string[];

    if (!signature || candidateSecrets.length === 0) {
      console.warn('[Webhook] Missing x-razorpay-signature header or secret');
      return NextResponse.json(
        { error: 'Missing signature or webhook secret configuration' },
        { status: 400 },
      );
    }

    let isValid = false;
    for (const secret of candidateSecrets) {
      if (verifyWebhookSignature(rawBody, signature, secret)) {
        isValid = true;
        break;
      }
    }

    if (!isValid) {
      console.warn('[Webhook] Invalid webhook signature (did not match configured secrets)');
      return NextResponse.json(
        { error: 'Invalid webhook signature' },
        { status: 400 },
      );
    }

    // 2. Parse Event Payload
    const payload = JSON.parse(rawBody);
    const eventType: string = payload.event || 'unknown';
    const eventId = resolveEventId(req, payload, rawBody);

    console.log(`[Webhook] Received event: ${eventType} (Event ID: ${eventId})`);

    // 3. Idempotency fast path. This is only a fast path — two concurrent
    //    deliveries can both pass it. The authoritative guard is the unique
    //    constraint on AuditLog.eventId inside the transaction below.
    const existingLog = await prisma.auditLog.findUnique({
      where: { eventId },
    });

    if (existingLog) {
      console.log(`[Webhook] Duplicate event ${eventId} already processed.`);
      return NextResponse.json(
        { status: 'ok', message: 'Event already processed' },
        { status: 200 },
      );
    }

    // 4. Extract identifiers across every entity shape Razorpay may send
    const entity = resolveEntity(payload);

    // 5. Locate Matching Transaction
    let transaction = null;
    if (entity.candidateIds.length > 0) {
      transaction = await prisma.transaction.findFirst({
        where: { externalPaymentId: { in: entity.candidateIds } },
      });
    }

    if (!transaction && entity.notesTransactionId) {
      transaction = await prisma.transaction.findUnique({
        where: { id: entity.notesTransactionId },
      });
    }

    if (!transaction) {
      console.warn(
        `[Webhook] No matching transaction for candidates [${entity.candidateIds.join(', ')}], ` +
          `txId: ${entity.notesTransactionId}`,
      );
      // Receipt is recorded to the server log only. AuditLog.transactionId is a
      // required foreign key, so an unmatched event has nothing to attach a row
      // to. Acknowledged with 200 because redelivery would fail identically.
      return NextResponse.json(
        { status: 'ok', message: 'No matching transaction in system' },
        { status: 200 },
      );
    }

    // 6. Decide the state transition and the ledger row together
    const now = new Date();
    const isAlreadyRecovered =
      transaction.status === 'recovered' || transaction.recovered === true;

    let auditAction = `webhook_${eventType.replace(/\./g, '_')}`;
    let auditReason = `Webhook event received: ${eventType}`;
    let auditResult = 'acknowledged_no_action';
    let stateUpdate: Record<string, any> | null = null;
    let recoveredAmountPaise: number | null = null;

    if (RECOVERY_EVENTS.has(eventType)) {
      stateUpdate = {
        status: 'recovered',
        recovered: true,
        resolvedAt: transaction.resolvedAt || now,
        // The money is in. Nothing is being waited on any more.
        holdReason: null,
        deferredUntil: null,
      };
      auditAction = 'webhook_payment_captured';
      auditReason = `Payment successfully captured via Razorpay (${
        entity.primaryEntityId || entity.candidateIds[0]
      })`;
      auditResult = 'recovered';
      recoveredAmountPaise = entity.amountPaise ?? transaction.amountPaise;
    } else if (eventType === 'payment.failed') {
      const paymentEntity = payload?.payload?.payment?.entity;
      const errorDesc =
        paymentEntity?.error_description ||
        paymentEntity?.error_reason ||
        'Payment failed on gateway';

      if (isAlreadyRecovered) {
        // State Guard: Do NOT downgrade an already-recovered transaction
        auditAction = 'webhook_late_failure_ignored';
        auditReason = `Late payment.failed webhook received (${errorDesc}) for already-recovered transaction. State preserved as recovered.`;
        auditResult = 'state_conflict_ignored';
        console.warn(
          `[Webhook] State Conflict: Received payment.failed for already-recovered transaction ${transaction.id}. Preserving recovered state.`,
        );
      } else {
        stateUpdate = {
          status: 'failed',
          recovered: false,
          holdReason: null,
          deferredUntil: null,
        };
        auditAction = 'webhook_payment_failed';
        auditReason = `Payment failed: ${errorDesc}`;
        auditResult = 'payment_failed';
      }
    } else if (CHANNEL_CLOSED_EVENTS.has(eventType)) {
      if (isAlreadyRecovered) {
        // A link can be cancelled after it was paid; that does not un-collect money.
        auditAction = 'webhook_late_channel_close_ignored';
        auditReason = `${eventType} received for already-recovered transaction. State preserved as recovered.`;
        auditResult = 'state_conflict_ignored';
      } else {
        // The link the customer was going to pay on no longer exists, so the
        // 'awaiting_gateway_capture' hold is a lie. Release it and put the
        // transaction back in front of the policy engine.
        stateUpdate = {
          status: 'failed',
          recovered: false,
          holdReason: null,
          deferredUntil: null,
        };
        auditAction = 'webhook_payment_link_closed';
        auditReason = `Recovery channel closed (${eventType}) — payment link ${
          entity.primaryEntityId ?? 'unknown'
        } is no longer payable. Hold released for re-evaluation.`;
        auditResult = 'recovery_channel_closed';
      }
    } else if (REVERSAL_EVENTS.has(eventType)) {
      const refundPaise = entity.amountPaise ?? transaction.amountPaise;
      const isFullReversal = refundPaise >= transaction.amountPaise;

      if (isFullReversal) {
        // Money that went back to the customer is not recovered revenue. Leaving
        // `recovered` true here would keep a reversed payment inside the recovered
        // GMV figure permanently.
        stateUpdate = {
          status: 'unrecoverable',
          recovered: false,
          resolvedAt: transaction.resolvedAt || now,
          holdReason: null,
          deferredUntil: null,
        };
        auditAction = 'webhook_refund_processed';
        auditReason =
          `Refund of ₹${(refundPaise / 100).toFixed(2)} processed against ` +
          `${entity.primaryEntityId ?? 'payment'} — full reversal. Recovery revoked and ` +
          `excluded from recovered revenue.`;
        auditResult = 'recovery_reversed';
        recoveredAmountPaise = 0;
      } else {
        // Partial refund. The transaction is still substantially recovered, so the
        // state stands; the net figure is recorded on the ledger row instead.
        // NOTE: `Transaction` carries no net-recovered column, so the net amount
        // lives on the audit row alone. Reporting reads it from there.
        auditAction = 'webhook_refund_partial';
        auditReason =
          `Partial refund of ₹${(refundPaise / 100).toFixed(2)} against ` +
          `${entity.primaryEntityId ?? 'payment'} (original ₹${(
            transaction.amountPaise / 100
          ).toFixed(2)}). Recovery retained; net recovered reduced.`;
        auditResult = 'recovery_partially_reversed';
        recoveredAmountPaise = transaction.amountPaise - refundPaise;
      }
    } else {
      // Unknown event. Acknowledged, but recorded honestly as unhandled rather
      // than as 'processed' — which previously implied an effect it never had.
      auditAction = 'webhook_event_unhandled';
      auditReason = `Webhook event received but not handled by policy: ${eventType}`;
      auditResult = 'acknowledged_no_action';
      console.log(`[Webhook] Unhandled event type ${eventType} — acknowledged with no state change.`);
    }

    const meta: AuditMetadata = {
      amountPaise: transaction.amountPaise,
      recoveredAmountPaise,
      simulated: false, // a signed webhook is by definition a real gateway event
      channel: 'gateway_link',
      razorpayEntityId: entity.primaryEntityId,
      extra: {
        eventType,
        matchedBy: entity.candidateIds.includes(transaction.externalPaymentId ?? '')
          ? 'externalPaymentId'
          : 'notes.transactionId',
        stateChanged: stateUpdate !== null,
      },
    };

    // 7. Commit the state change and its ledger row atomically.
    //    Previously the update was committed first and the audit row written
    //    afterwards, so a failure in between produced a recovered transaction
    //    with no evidence of why. Both now succeed or neither does.
    const auditData = buildAuditData(
      transaction.id,
      'webhook',
      auditAction,
      auditReason,
      auditResult,
      eventId,
      'v1',
      null,
      null,
      meta,
    );

    try {
      const ops: any[] = [];
      if (stateUpdate) {
        ops.push(
          prisma.transaction.update({ where: { id: transaction.id }, data: stateUpdate }),
        );
      }
      ops.push(prisma.auditLog.create({ data: auditData }));
      await prisma.$transaction(ops);
    } catch (err: any) {
      // Lost the race against a concurrent delivery of the same event. The other
      // request committed the identical work, so this is a settled duplicate.
      if (isDuplicateEventError(err)) {
        console.log(`[Webhook] Concurrent duplicate for ${eventId} — already committed.`);
        return NextResponse.json(
          { status: 'ok', message: 'Event already processed' },
          { status: 200 },
        );
      }
      throw err;
    }

    console.log(
      `[Webhook] Successfully processed ${eventType} for transaction ${transaction.id}` +
        `${stateUpdate ? ` -> ${stateUpdate.status}` : ' (no state change)'}`,
    );

    return NextResponse.json(
      { status: 'ok', eventId, transactionId: transaction.id },
      { status: 200 },
    );
  } catch (error: any) {
    console.error('[Webhook] Internal error processing webhook:', error);
    // A validly-signed, new event that could not be processed must be retried
    // by Razorpay. Explicit duplicate and unknown-transaction paths above
    // already return 200 as intentionally handled outcomes.
    return NextResponse.json(
      { status: 'error', message: error?.message || 'Internal webhook error' },
      { status: 500 },
    );
  }
}
