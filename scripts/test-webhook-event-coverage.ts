/**
 * /scripts/test-webhook-event-coverage.ts
 *
 * Covers the Razorpay webhook event types the route learned to handle:
 * subscription.charged, payment_link.cancelled, payment_link.expired,
 * refund.processed (full and partial), and an unrecognised event.
 *
 * Before this, only payment.captured / payment_link.paid / payment.failed were
 * handled; every other event fell through to a generic "processed" audit row with
 * no state change — so a `subscription.charged` for a recovered subscription, or a
 * refund that reversed a recovery, left the transaction claiming money it did not
 * have. These are the cases that assert the difference.
 *
 * Every transaction created here is `isDemoArtifact: true` and is deleted in the
 * finally block, so the frozen 65-scenario benchmark is never touched.
 *
 * Run via: npm run test:webhook-events
 */

import 'dotenv/config';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { POST } from '../app/api/webhook/route';

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
const RUN = Date.now();
const createdTxIds: string[] = [];

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS  ${label.padEnd(58)} ${detail}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label.padEnd(58)} ${detail}`);
  }
}

function hr(char = '─', len = 84) {
  return char.repeat(len);
}

/** Creates an isolated demo transaction in a given starting state. */
async function makeTx(opts: {
  key: string;
  externalPaymentId: string;
  status: string;
  recovered?: boolean;
  amountPaise?: number;
  type?: string;
  holdReason?: string | null;
}) {
  const tx = await prisma.transaction.create({
    data: {
      externalPaymentId: opts.externalPaymentId,
      amountPaise: opts.amountPaise ?? 249900,
      status: opts.status,
      recovered: opts.recovered ?? false,
      resolvedAt: opts.recovered ? new Date() : null,
      reasonCode: 'gateway_technical_error',
      source: 'gateway',
      type: opts.type ?? 'payment',
      customerId: `cust_webhook_events_${opts.key}`,
      expectedRecoveryOutcome: 'recovers_on_retry',
      simulatedRecoveryAmountPaise: opts.amountPaise ?? 249900,
      holdReason: opts.holdReason ?? null,
      deferredUntil: opts.holdReason ? new Date(Date.now() + 86_400_000) : null,
      isDemoArtifact: true,
    },
  });
  createdTxIds.push(tx.id);
  return tx;
}

/** Posts a signed webhook body through the real route handler. */
async function fire(body: Record<string, unknown>, eventId: string) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac('sha256', SECRET!).update(raw).digest('hex');
  const res = await POST(
    new NextRequest('http://localhost:3000/api/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      },
      body: raw,
    }),
  );
  return { status: res.status, json: await res.json() };
}

async function latestAudit(transactionId: string) {
  return prisma.auditLog.findFirst({
    where: { transactionId },
    orderBy: { timestamp: 'desc' },
  });
}

async function run() {
  if (!SECRET) throw new Error('A Razorpay webhook secret is required for this test.');

  console.log('\n' + hr('═'));
  console.log('  🧪  TEST: RAZORPAY WEBHOOK EVENT COVERAGE');
  console.log(hr('═') + '\n');

  // ── 1. subscription.charged → recovered ────────────────────────────────────
  console.log('  [1] subscription.charged on an open subscription\n');
  {
    const tx = await makeTx({
      key: 'sub',
      externalPaymentId: `sub_cov_${RUN}`,
      status: 'pending',
      type: 'subscription',
      amountPaise: 1799900,
      holdReason: 'awaiting_customer_afa',
    });
    const res = await fire(
      {
        event: 'subscription.charged',
        payload: {
          subscription: { entity: { id: tx.externalPaymentId, notes: { transactionId: tx.id } } },
          payment: { entity: { id: `pay_cov_sub_${RUN}`, amount: tx.amountPaise } },
        },
      },
      `evt_cov_sub_${RUN}`,
    );
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const audit = await latestAudit(tx.id);

    assert('HTTP 200', res.status === 200, `got ${res.status}`);
    assert('matched via subscription entity id', audit !== null, `auditRows=${audit ? 1 : 0}`);
    assert('status → recovered', after?.status === 'recovered', `status=${after?.status}`);
    assert('recovered flag set', after?.recovered === true, `recovered=${after?.recovered}`);
    assert('AFA hold released', after?.holdReason === null, `holdReason=${after?.holdReason}`);
    assert(
      'recoveredAmountPaise on ledger row',
      audit?.recoveredAmountPaise === tx.amountPaise,
      `${audit?.recoveredAmountPaise}`,
    );
    assert(
      'razorpayEntityId captured',
      audit?.razorpayEntityId === `pay_cov_sub_${RUN}`,
      `${audit?.razorpayEntityId}`,
    );
    assert('marked as a live (non-simulated) event', audit?.simulated === false);
  }

  // ── 2. payment_link.cancelled → hold released, back to failed ─────────────
  console.log('\n  [2] payment_link.cancelled while awaiting gateway capture\n');
  {
    const tx = await makeTx({
      key: 'cancel',
      externalPaymentId: `plink_cov_cancel_${RUN}`,
      status: 'pending',
      holdReason: 'awaiting_gateway_capture',
    });
    const res = await fire(
      {
        event: 'payment_link.cancelled',
        payload: {
          payment_link: { entity: { id: tx.externalPaymentId, notes: { transactionId: tx.id } } },
        },
      },
      `evt_cov_cancel_${RUN}`,
    );
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const audit = await latestAudit(tx.id);

    assert('HTTP 200', res.status === 200, `got ${res.status}`);
    assert('status → failed', after?.status === 'failed', `status=${after?.status}`);
    assert(
      'stale awaiting_gateway_capture hold cleared',
      after?.holdReason === null && after?.deferredUntil === null,
      `holdReason=${after?.holdReason}`,
    );
    assert(
      'audit result = recovery_channel_closed',
      audit?.result === 'recovery_channel_closed',
      `${audit?.result}`,
    );
    assert('not marked recovered', after?.recovered === false);
  }

  // ── 3. payment_link.expired → same closure path ───────────────────────────
  console.log('\n  [3] payment_link.expired while awaiting gateway capture\n');
  {
    const tx = await makeTx({
      key: 'expire',
      externalPaymentId: `plink_cov_expire_${RUN}`,
      status: 'pending',
      holdReason: 'awaiting_gateway_capture',
    });
    const res = await fire(
      {
        event: 'payment_link.expired',
        payload: { payment_link: { entity: { id: tx.externalPaymentId } } },
      },
      `evt_cov_expire_${RUN}`,
    );
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    assert('HTTP 200', res.status === 200, `got ${res.status}`);
    assert('status → failed', after?.status === 'failed', `status=${after?.status}`);
    assert('hold cleared', after?.holdReason === null);
  }

  // ── 4. payment_link.cancelled AFTER payment → must not un-recover ─────────
  console.log('\n  [4] payment_link.cancelled arriving after the money landed\n');
  {
    const tx = await makeTx({
      key: 'latecancel',
      externalPaymentId: `plink_cov_late_${RUN}`,
      status: 'recovered',
      recovered: true,
    });
    const res = await fire(
      {
        event: 'payment_link.cancelled',
        payload: { payment_link: { entity: { id: tx.externalPaymentId } } },
      },
      `evt_cov_late_${RUN}`,
    );
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const audit = await latestAudit(tx.id);

    assert('HTTP 200', res.status === 200, `got ${res.status}`);
    assert('recovered state PRESERVED', after?.status === 'recovered' && after?.recovered === true);
    assert(
      'logged as a state conflict, not applied',
      audit?.result === 'state_conflict_ignored',
      `${audit?.result}`,
    );
  }

  // ── 5. refund.processed (full) → recovery revoked ─────────────────────────
  console.log('\n  [5] refund.processed, full amount — reverses the recovery\n');
  {
    const tx = await makeTx({
      key: 'refundfull',
      externalPaymentId: `pay_cov_refund_full_${RUN}`,
      status: 'recovered',
      recovered: true,
      amountPaise: 549900,
    });
    const res = await fire(
      {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: `rfnd_cov_full_${RUN}`,
              payment_id: tx.externalPaymentId,
              amount: 549900,
            },
          },
        },
      },
      `evt_cov_refund_full_${RUN}`,
    );
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const audit = await latestAudit(tx.id);

    assert('HTTP 200', res.status === 200, `got ${res.status}`);
    assert('matched via refund.payment_id', audit !== null);
    assert(
      'recovered flag CLEARED — refunded money is not recovered revenue',
      after?.recovered === false,
      `recovered=${after?.recovered}`,
    );
    assert('status → unrecoverable', after?.status === 'unrecoverable', `status=${after?.status}`);
    assert(
      'audit result = recovery_reversed',
      audit?.result === 'recovery_reversed',
      `${audit?.result}`,
    );
    assert('net recovered recorded as 0', audit?.recoveredAmountPaise === 0, `${audit?.recoveredAmountPaise}`);
  }

  // ── 6. refund.processed (partial) → recovery retained, net recorded ───────
  console.log('\n  [6] refund.processed, partial amount — recovery retained\n');
  {
    const tx = await makeTx({
      key: 'refundpart',
      externalPaymentId: `pay_cov_refund_part_${RUN}`,
      status: 'recovered',
      recovered: true,
      amountPaise: 400000,
    });
    const res = await fire(
      {
        event: 'refund.processed',
        payload: {
          refund: {
            entity: { id: `rfnd_cov_part_${RUN}`, payment_id: tx.externalPaymentId, amount: 100000 },
          },
        },
      },
      `evt_cov_refund_part_${RUN}`,
    );
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const audit = await latestAudit(tx.id);

    assert('HTTP 200', res.status === 200, `got ${res.status}`);
    assert('recovered state retained', after?.status === 'recovered' && after?.recovered === true);
    assert(
      'audit result = recovery_partially_reversed',
      audit?.result === 'recovery_partially_reversed',
      `${audit?.result}`,
    );
    assert(
      'net recovered = ₹4,000 − ₹1,000 = ₹3,000',
      audit?.recoveredAmountPaise === 300000,
      `${audit?.recoveredAmountPaise}`,
    );
  }

  // ── 7. Unknown event → acknowledged, no state change, honest label ────────
  console.log('\n  [7] An event the policy does not handle\n');
  {
    const tx = await makeTx({
      key: 'unknown',
      externalPaymentId: `pay_cov_unknown_${RUN}`,
      status: 'failed',
    });
    const res = await fire(
      {
        event: 'payment.dispute.created',
        payload: { payment: { entity: { id: tx.externalPaymentId } } },
      },
      `evt_cov_unknown_${RUN}`,
    );
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const audit = await latestAudit(tx.id);

    assert('HTTP 200 (acknowledged, not retried)', res.status === 200, `got ${res.status}`);
    assert('status unchanged', after?.status === 'failed', `status=${after?.status}`);
    assert(
      'labelled webhook_event_unhandled, not "processed"',
      audit?.action === 'webhook_event_unhandled',
      `${audit?.action}`,
    );
    assert(
      'result = acknowledged_no_action',
      audit?.result === 'acknowledged_no_action',
      `${audit?.result}`,
    );
  }

  // ── 8. Content-derived idempotency when Razorpay sends no event id ────────
  console.log('\n  [8] Replay with NO x-razorpay-event-id header\n');
  {
    const tx = await makeTx({
      key: 'noeventid',
      externalPaymentId: `plink_cov_noid_${RUN}`,
      status: 'pending',
      holdReason: 'awaiting_gateway_capture',
    });
    const raw = JSON.stringify({
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { id: tx.externalPaymentId } },
        payment: { entity: { id: `pay_cov_noid_${RUN}`, amount: tx.amountPaise } },
      },
    });
    const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    const post = () =>
      POST(
        new NextRequest('http://localhost:3000/api/webhook', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
          body: raw,
        }),
      );

    const first = await post();
    const second = await post();
    const rows = await prisma.auditLog.count({ where: { transactionId: tx.id } });
    const after = await prisma.transaction.findUnique({ where: { id: tx.id } });
    const audit = await latestAudit(tx.id);

    assert('first delivery HTTP 200', first.status === 200, `got ${first.status}`);
    assert('replay HTTP 200', second.status === 200, `got ${second.status}`);
    assert('status → recovered', after?.status === 'recovered', `status=${after?.status}`);
    assert(
      'exactly ONE ledger row for two identical deliveries',
      rows === 1,
      `auditRows=${rows}`,
    );
    assert(
      'idempotency key derived from body content',
      Boolean(audit?.eventId?.startsWith('evt_sha_')),
      `${audit?.eventId}`,
    );
  }

  console.log('\n' + hr());
  console.log(`  ${failed === 0 ? '✅' : '❌'} TEST RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`);
  console.log(hr('═') + '\n');
  if (failed > 0) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Demo artifacts only — nothing from the frozen benchmark is in this list.
    if (createdTxIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { transactionId: { in: createdTxIds } } });
      await prisma.transaction.deleteMany({ where: { id: { in: createdTxIds } } });
    }
    await prisma.$disconnect();
  });
