/**
 * /scripts/test-webhook-conflict-guard.ts
 *
 * Validation test for Webhook Terminal State Conflict Guard.
 *
 * Verifies that when a late or conflicting `payment.failed` webhook arrives
 * for a transaction that has already reached the terminal `recovered` state,
 * the webhook handler logs the anomaly in AuditLog (`action: 'webhook_late_failure_ignored'`)
 * without downgrading the transaction's status.
 *
 * Run via: npx tsx --tsconfig tsconfig.scripts.json scripts/test-webhook-conflict-guard.ts
 */

import 'dotenv/config';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { POST } from '../app/api/webhook/route';
import { NextRequest } from 'next/server';

function hr(char = '─', len = 70): string {
  return char.repeat(len);
}

async function main() {
  console.log('\n' + hr('═'));
  console.log('  🛡️  TEST: TERMINAL STATE CONFLICT GUARD (LATE FAILURE PREVENTION)');
  console.log(hr('═'));

  const webhookSecret =
    process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET || 'test_webhook_secret_123';

  // 1. Create a transaction that is ALREADY recovered
  const externalPaymentId = `plink_guard_test_${Date.now()}`;
  const recoveredTx = await prisma.transaction.create({
    data: {
      externalPaymentId,
      amountPaise: 99900,
      status: 'recovered',
      reasonCode: 'payment_timed_out',
      source: 'gateway',
      type: 'payment',
      customerId: 'cust_guard_test',
      retryCount: 1,
      nudgeCount: 0,
      recovered: true,
      resolvedAt: new Date(),
      expectedRecoveryOutcome: 'recovers_on_retry',
      simulatedRecoveryAmountPaise: 99900,
    },
  });

  console.log('  Initial Terminal State:');
  console.log(`    • Transaction ID     : ${recoveredTx.id}`);
  console.log(`    • External Payment ID: ${recoveredTx.externalPaymentId}`);
  console.log(`    • Status             : ${recoveredTx.status} (recovered=${recoveredTx.recovered})`);
  console.log(`    • Resolved At        : ${recoveredTx.resolvedAt?.toISOString()}\n`);

  // 2. Simulate late inbound payment.failed webhook
  const eventId = `evt_late_failure_${Date.now()}`;
  const webhookPayload = JSON.stringify({
    entity: 'event',
    account_id: 'acc_test_guard',
    event: 'payment.failed',
    event_id: eventId,
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: `pay_failed_attempt_${Date.now()}`,
          amount: recoveredTx.amountPaise,
          currency: 'INR',
          status: 'failed',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Card declined by issuing bank',
          notes: {
            transactionId: recoveredTx.id,
          },
        },
      },
      payment_link: {
        entity: {
          id: recoveredTx.externalPaymentId,
          status: 'partially_paid',
          notes: {
            transactionId: recoveredTx.id,
          },
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  });

  const signature = crypto
    .createHmac('sha256', webhookSecret)
    .update(webhookPayload)
    .digest('hex');

  const req = new NextRequest('http://localhost:3000/api/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': eventId,
    },
    body: webhookPayload,
  });

  console.log('  📡 Simulating late payment.failed webhook invocation...');
  const res = await POST(req);
  const resBody = await res.json();

  console.log(`    • HTTP Status Returned : ${res.status}`);
  console.log(`    • Webhook Response     : ${JSON.stringify(resBody)}\n`);

  // 3. Inspect Transaction state in DB
  const finalTx = await prisma.transaction.findUniqueOrThrow({
    where: { id: recoveredTx.id },
  });

  const latestAuditLog = await prisma.auditLog.findUniqueOrThrow({
    where: { eventId },
  });

  console.log('  State After Late Failure Webhook:');
  console.log(`    • Status in DB         : ${finalTx.status} (Expected: "recovered")`);
  console.log(`    • Recovered in DB      : ${finalTx.recovered} (Expected: true)`);
  console.log(`    • AuditLog Action      : ${latestAuditLog.action}`);
  console.log(`    • AuditLog Result      : ${latestAuditLog.result}`);
  console.log(`    • AuditLog Reason      : "${latestAuditLog.reason}"\n`);

  const statePreserved = finalTx.status === 'recovered' && finalTx.recovered === true;
  const auditConflictLogged =
    latestAuditLog.action === 'webhook_late_failure_ignored' &&
    latestAuditLog.result === 'state_conflict_ignored';

  const passed = res.status === 200 && statePreserved && auditConflictLogged;

  // Cleanup test record
  await prisma.auditLog.deleteMany({ where: { transactionId: recoveredTx.id } });
  await prisma.transaction.delete({ where: { id: recoveredTx.id } });

  console.log(hr());
  if (passed) {
    console.log('  ✅ TEST RESULT: PASS');
    console.log('     • Confirmed terminal state preserved (status remains "recovered").');
    console.log('     • Confirmed late failure recorded as anomaly in AuditLog without mutating state.');
    console.log('     • Confirmed 200 OK returned to webhook sender.');
  } else {
    console.log('  ❌ TEST RESULT: FAIL');
  }
  console.log(hr('═') + '\n');

  if (!passed) {
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('Test execution failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
