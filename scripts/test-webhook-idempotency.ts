/**
 * /scripts/test-webhook-idempotency.ts
 *
 * Direct test for Webhook Signature Verification and Idempotency deduplication.
 *
 * Verifies:
 *  1. Forged/invalid signatures are rejected with HTTP 400.
 *  2. Valid HMAC-SHA256 signed webhook creates exactly 1 AuditLog row and recovers the transaction.
 *  3. Replay attack / re-sent duplicate webhook is caught by eventId idempotency key
 *     and does NOT insert a second AuditLog row (count stays exactly 1).
 *
 * Run via: npx tsx --tsconfig tsconfig.scripts.json scripts/test-webhook-idempotency.ts
 */

import 'dotenv/config';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { POST } from '../app/api/webhook/route';
import { NextRequest } from 'next/server';

function hr(char = '─', len = 70): string {
  return char.repeat(len);
}

async function runWebhookIdempotencyTest() {
  console.log('\n' + hr('═'));
  console.log('  🛡️  TEST 2 & 5: WEBHOOK SIGNATURE VERIFICATION & IDEMPOTENCY');
  console.log(hr('═'));

  const webhookSecret =
    process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || 'test_webhook_secret_123';

  // 1. Pick a transaction to test webhook recovery on
  const testTx = await prisma.transaction.findFirst({
    where: { status: 'failed' },
  });

  if (!testTx) {
    console.log('  No failed transaction found. Run `npm run seed` first.');
    process.exit(1);
  }

  console.log('  Target Transaction:');
  console.log(`    • ID          : ${testTx.id}`);
  console.log(`    • External ID : ${testTx.externalPaymentId}`);
  console.log(`    • Amount      : ₹${(testTx.amountPaise / 100).toFixed(2)}`);
  console.log(`    • Status      : ${testTx.status}\n`);

  // Clear any existing audit logs for this transaction to have a clean baseline
  await prisma.auditLog.deleteMany({
    where: { transactionId: testTx.id },
  });

  const baselineLogCount = await prisma.auditLog.count({
    where: { transactionId: testTx.id },
  });
  console.log(`  Initial AuditLog row count for transaction: ${baselineLogCount}\n`);

  // ── STEP 1: Forged / Invalid Signature Rejection ─────────────────────────
  console.log('  ──────────────────────────────────────────────────────────────────');
  console.log('  🔒 STEP 1: Forged Signature Rejection Test (Security Gate)');
  console.log('  ──────────────────────────────────────────────────────────────────');

  const testEventId = `evt_test_${Date.now()}`;
  const webhookPayload = JSON.stringify({
    entity: 'event',
    account_id: 'acc_test_123456',
    event: 'payment.captured',
    event_id: testEventId,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: `pay_test_${Date.now()}`,
          amount: testTx.amountPaise,
          currency: 'INR',
          status: 'captured',
          order_id: null,
          notes: {
            transactionId: testTx.id,
          },
        },
      },
      payment_link: {
        entity: {
          id: testTx.externalPaymentId,
          status: 'paid',
          notes: {
            transactionId: testTx.id,
          },
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  const badSignature = 'forged_hmac_sha256_signature_abc123';
  const badReq = new NextRequest('http://localhost:3000/api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': badSignature,
      'x-razorpay-event-id': testEventId,
    },
    body: webhookPayload,
  });

  const badResponse = await POST(badReq);
  const badResponseBody = await badResponse.json();

  console.log(`    Response Status : ${badResponse.status} (Expected 400)`);
  console.log(`    Response Body   : ${JSON.stringify(badResponseBody)}`);

  const step1Passed =
    badResponse.status === 400 && badResponseBody.error === 'Invalid webhook signature';
  console.log(`    Step 1 Result   : ${step1Passed ? '✓ PASS (Forged payload rejected)' : '✗ FAIL'}\n`);

  // ── STEP 2: Legitimate Signed Webhook Execution ──────────────────────────
  console.log('  ──────────────────────────────────────────────────────────────────');
  console.log('  ✅ STEP 2: Valid Signed Webhook Execution (Pass 1)');
  console.log('  ──────────────────────────────────────────────────────────────────');

  // Compute genuine HMAC-SHA256 signature
  const validSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(webhookPayload)
    .digest('hex');

  const validReq1 = new NextRequest('http://localhost:3000/api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': validSignature,
      'x-razorpay-event-id': testEventId,
    },
    body: webhookPayload,
  });

  const validResponse1 = await POST(validReq1);
  const validResponseBody1 = await validResponse1.json();

  console.log(`    Response Status : ${validResponse1.status} (Expected 200)`);
  console.log(`    Response Body   : ${JSON.stringify(validResponseBody1)}`);

  const countAfterPass1 = await prisma.auditLog.count({
    where: { transactionId: testTx.id },
  });

  const txAfterPass1 = await prisma.transaction.findUniqueOrThrow({
    where: { id: testTx.id },
  });

  console.log(`    AuditLog Count  : ${countAfterPass1} (Before: ${baselineLogCount}, After: ${countAfterPass1})`);
  console.log(`    TX Status       : ${txAfterPass1.status} (recovered=${txAfterPass1.recovered})`);

  const step2Passed =
    validResponse1.status === 200 &&
    countAfterPass1 === baselineLogCount + 1 &&
    txAfterPass1.status === 'recovered' &&
    txAfterPass1.recovered === true;

  console.log(`    Step 2 Result   : ${step2Passed ? '✓ PASS (Processed & 1 AuditLog created)' : '✗ FAIL'}\n`);

  // ── STEP 3: Webhook Replay / Duplicate Idempotency Test ───────────────────
  console.log('  ──────────────────────────────────────────────────────────────────');
  console.log('  🔁 STEP 3: Duplicate Webhook Replay Test (Pass 2 - Idempotency)');
  console.log('  ──────────────────────────────────────────────────────────────────');

  // Send the EXACT SAME request a second time
  const validReq2 = new NextRequest('http://localhost:3000/api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': validSignature,
      'x-razorpay-event-id': testEventId,
    },
    body: webhookPayload,
  });

  const validResponse2 = await POST(validReq2);
  const validResponseBody2 = await validResponse2.json();

  console.log(`    Response Status : ${validResponse2.status} (Expected 200)`);
  console.log(`    Response Body   : ${JSON.stringify(validResponseBody2)}`);

  const countAfterPass2 = await prisma.auditLog.count({
    where: { transactionId: testTx.id },
  });

  console.log(`    AuditLog Count  : ${countAfterPass2} (Expected ${countAfterPass1} - NO duplicate row inserted)`);

  const step3Passed =
    validResponse2.status === 200 &&
    validResponseBody2.message === 'Event already processed' &&
    countAfterPass2 === countAfterPass1;

  console.log(`    Step 3 Result   : ${step3Passed ? '✓ PASS (Deduplicated, 0 new rows written)' : '✗ FAIL'}\n`);

  // ── Summary Table ────────────────────────────────────────────────────────
  console.log(hr());
  console.log('  📊 SUMMARY OF AUDIT LOG ROWS FOR TRANSACTION:');
  const logs = await prisma.auditLog.findMany({
    where: { transactionId: testTx.id },
    orderBy: { timestamp: 'asc' },
  });
  for (const l of logs) {
    console.log(`    • Event ID : ${l.eventId}`);
    console.log(`      Actor    : ${l.actor}`);
    console.log(`      Action   : ${l.action}`);
    console.log(`      Result   : ${l.result}`);
    console.log(`      Reason   : ${l.reason}`);
  }

  const overallPassed = step1Passed && step2Passed && step3Passed;
  console.log('\n' + hr());
  if (overallPassed) {
    console.log('  ✅ TEST RESULT: PASS');
    console.log('     • Signature Verification: Verified genuine HMAC-SHA256 check.');
    console.log('     • Rejection Gate: Bad signatures return HTTP 400.');
    console.log('     • Idempotency Gate: Duplicate webhooks return HTTP 200 and write 0 duplicate rows.');
  } else {
    console.log('  ❌ TEST RESULT: FAIL');
  }
  console.log(hr('═') + '\n');

  if (!overallPassed) {
    process.exit(1);
  }
}

runWebhookIdempotencyTest()
  .catch((e) => {
    console.error('Test execution error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
