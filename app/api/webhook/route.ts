/**
 * /app/api/webhook/route.ts
 *
 * Next.js API route that handles incoming Razorpay webhooks.
 *
 * Supported Events:
 *  - payment.captured / payment_link.paid -> marks transaction as recovered
 *  - payment.failed -> records failed attempt
 *
 * Features:
 *  - Mandatory HMAC-SHA256 signature verification via Razorpay SDK helper
 *  - Idempotent processing via unique Razorpay eventId in AuditLog
 *  - Fast 200 response to prevent webhook retries
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { verifyWebhookSignature } from '@/lib/razorpay';
import { writeEvent } from '@/lib/audit-logger';

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-razorpay-signature');
    const webhookSecret =
      process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;

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
    const eventId: string =
      req.headers.get('x-razorpay-event-id') ||
      payload.event_id ||
      payload.id ||
      `evt_${Date.now()}`;

    console.log(`[Webhook] Received event: ${eventType} (Event ID: ${eventId})`);

    // 3. Idempotency Check via AuditLog
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

    // 4. Extract Payment / Link Identifiers
    const paymentEntity = payload.payload?.payment?.entity;
    const paymentLinkEntity = payload.payload?.payment_link?.entity;
    const orderEntity = payload.payload?.order?.entity;

    const externalId =
      paymentLinkEntity?.id ||
      paymentEntity?.order_id ||
      orderEntity?.id ||
      paymentEntity?.id;

    const customTxId =
      paymentEntity?.notes?.transactionId ||
      paymentLinkEntity?.notes?.transactionId ||
      orderEntity?.notes?.transactionId;

    // 5. Locate Matching Transaction
    let transaction = null;
    if (externalId) {
      transaction = await prisma.transaction.findFirst({
        where: { externalPaymentId: externalId },
      });
    }

    if (!transaction && customTxId) {
      transaction = await prisma.transaction.findUnique({
        where: { id: customTxId },
      });
    }

    if (!transaction) {
      console.warn(
        `[Webhook] No matching transaction found for externalId: ${externalId}, txId: ${customTxId}`,
      );
      // Still log to audit log to record receipt
      return NextResponse.json(
        { status: 'ok', message: 'No matching transaction in system' },
        { status: 200 },
      );
    }

    // 6. Terminal State & Conflict Handling
    const isAlreadyRecovered = transaction.status === 'recovered' || transaction.recovered === true;

    let auditAction = eventType;
    let auditReason = `Webhook event received: ${eventType}`;
    let auditResult = 'processed';

    if (eventType === 'payment.captured' || eventType === 'payment_link.paid') {
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: 'recovered',
          recovered: true,
          resolvedAt: transaction.resolvedAt || new Date(),
        },
      });
      auditAction = 'webhook_payment_captured';
      auditReason = `Payment successfully captured via Razorpay (${paymentEntity?.id || externalId})`;
      auditResult = 'recovered';
    } else if (eventType === 'payment.failed') {
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
        await prisma.transaction.update({
          where: { id: transaction.id },
          data: {
            status: 'failed',
            recovered: false,
          },
        });
        auditAction = 'webhook_payment_failed';
        auditReason = `Payment failed: ${errorDesc}`;
        auditResult = 'payment_failed';
      }
    }

    // 7. Write Audit Log Entry with Actor 'webhook' (Idempotency Key = eventId)
    await writeEvent(
      transaction.id,
      'webhook',
      auditAction,
      auditReason,
      auditResult,
      eventId,
    );

    console.log(
      `[Webhook] Successfully processed ${eventType} for transaction ${transaction.id}`,
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
