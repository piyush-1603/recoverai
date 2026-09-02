/**
 * /scripts/test-p2p-workflow.ts
 *
 * End-to-end test of the Promise-to-Pay workflow.
 * Creates a P2P commitment, sends a reminder, triggers collection, and
 * verifies the full lifecycle with audit logging.
 *
 * Usage: npx tsx --tsconfig tsconfig.scripts.json scripts/test-p2p-workflow.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import {
  createP2P,
  sendP2PReminder,
  triggerP2PCollection,
  cancelP2P,
  getP2PById,
  getAllP2Ps,
  getP2PAuditLog,
} from '../lib/p2p-engine';

const DIVIDER = '═'.repeat(70);
const THIN = '─'.repeat(70);

function log(label: string, value: any) {
  console.log(`  ${label.padEnd(24)} ${typeof value === 'object' ? JSON.stringify(value, null, 2) : value}`);
}

async function main() {
  console.log('\n' + DIVIDER);
  console.log('  PROMISE-TO-PAY (P2P) WORKFLOW — END-TO-END TEST');
  console.log(DIVIDER + '\n');

  // ── Test 1: Create a P2P commitment ──
  console.log('▸ Step 1: Creating P2P commitment...');
  const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);

  const p2p = await createP2P({
    customerId: 'cust_test_p2p_001',
    amountPaise: 149900, // ₹1,499.00
    promisedPaymentTime: twoHoursFromNow.toISOString(),
  });

  log('P2P ID:', p2p.id);
  log('Status:', p2p.status);
  log('Amount:', `₹${(p2p.amountPaise / 100).toLocaleString('en-IN')}`);
  log('Promised Time:', p2p.promisedPaymentTime.toISOString());
  console.log('  ✅ P2P record created successfully\n');

  // ── Test 2: Send reminder ──
  console.log(THIN);
  console.log('▸ Step 2: Sending 1-hour pre-due reminder...');
  const reminded = await sendP2PReminder(p2p.id);

  log('Status:', reminded.status);
  log('Payment Link:', reminded.paymentLinkUrl || '(none)');
  log('Reminder Sent At:', reminded.reminderSentAt?.toISOString() || '(none)');
  console.log('  ✅ Reminder dispatched\n');

  // ── Test 3: Trigger payment collection ──
  console.log(THIN);
  console.log('▸ Step 3: Triggering payment collection at promised time...');
  const collected = await triggerP2PCollection(p2p.id);

  log('Final Status:', collected.status);
  log('Resolved At:', collected.resolvedAt?.toISOString() || '(pending)');
  if (collected.status === 'completed') {
    console.log('  ✅ Payment collected successfully — revenue recovered');
  } else if (collected.status === 'failed_escalated') {
    log('CRM Task:', collected.crmTaskId || '(none)');
    log('Failure Reason:', collected.failureReason || '(none)');
    console.log('  ⚠️  Payment failed — escalated to human AR');
  }
  console.log();

  // ── Test 4: Create and cancel a P2P ──
  console.log(THIN);
  console.log('▸ Step 4: Testing P2P cancellation...');
  const cancelTarget = await createP2P({
    customerId: 'cust_test_p2p_002',
    amountPaise: 50000, // ₹500.00
    promisedPaymentTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  });

  const cancelled = await cancelP2P(cancelTarget.id, 'Customer withdrew commitment during call');
  log('Status:', cancelled.status);
  log('Reason:', cancelled.failureReason || '(none)');
  console.log('  ✅ P2P cancelled successfully\n');

  // ── Test 5: Query all P2Ps ──
  console.log(THIN);
  console.log('▸ Step 5: Querying all P2P records...');
  const allP2Ps = await getAllP2Ps();
  console.log(`  Found ${allP2Ps.length} P2P record(s):`);
  for (const r of allP2Ps) {
    console.log(`    [${r.status.padEnd(18)}] ${r.id} — ₹${(r.amountPaise / 100).toLocaleString('en-IN')} — ${r.customerId}`);
  }
  console.log();

  // ── Test 6: Verify audit trail ──
  console.log(THIN);
  console.log('▸ Step 6: Verifying audit trail for P2P #1...');
  const events = await getP2PAuditLog(p2p.id);
  console.log(`  Found ${events.length} audit event(s):`);
  for (const e of events) {
    console.log(`    [${e.action.padEnd(28)}] ${e.result.padEnd(24)} ${e.detail.substring(0, 80)}...`);
  }

  console.log('\n' + DIVIDER);
  console.log('  ALL P2P WORKFLOW TESTS COMPLETED');
  console.log(DIVIDER + '\n');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌ P2P test failed:', err);
  process.exit(1);
});
