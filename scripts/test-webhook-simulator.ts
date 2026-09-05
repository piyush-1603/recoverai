/**
 * /scripts/test-webhook-simulator.ts
 *
 * Validates that /api/test-webhook-simulator correctly constructs, signs,
 * and reconciles a simulated payment webhook through the real pipeline.
 */

import 'dotenv/config';
import { NextRequest } from 'next/server';
import { POST as executeSimulator } from '../app/api/test-webhook-simulator/route';
import { prisma } from '../lib/prisma';

function hr(char = '─', len = 70): string {
  return char.repeat(len);
}

function assert(label: string, condition: boolean, detail = '') {
  console.log(`  ${condition ? '✓ PASS' : '✗ FAIL'}  ${label.padEnd(46)} ${detail}`);
  if (!condition) {
    throw new Error(`Assertion failed: ${label} (${detail})`);
  }
}

async function run() {
  console.log('\n' + hr('═'));
  console.log('  🧪  1-CLICK WEBHOOK SIMULATOR VERIFICATION TEST');
  console.log(hr('═'));

  // 1. Create a dedicated test demo transaction
  const demoTx = await prisma.transaction.create({
    data: {
      externalPaymentId: `plink_test_sim_${Date.now().toString(36)}`,
      amountPaise: 249900,
      status: 'pending',
      reasonCode: 'payment_timed_out',
      source: 'gateway',
      type: 'payment',
      customerTier: 'vip',
      customerId: 'cust_test_sim_judge',
      retryCount: 1,
      nudgeCount: 0,
      recovered: false,
      expectedRecoveryOutcome: 'recovers_on_retry',
      simulatedRecoveryAmountPaise: 249900,
      isDemoArtifact: true,
    },
  });

  console.log(`  Target Transaction Created : ${demoTx.externalPaymentId} (#${demoTx.id.slice(-8)})`);
  console.log(`  Initial Status             : ${demoTx.status} (recovered: ${demoTx.recovered})\n`);

  // 2. Invoke the simulator
  const request = new NextRequest('http://localhost:3000/api/test-webhook-simulator', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transactionId: demoTx.id,
      event: 'payment_link.paid',
    }),
  });

  const response = await executeSimulator(request);
  const data = await response.json();

  console.log('  Simulator Response:', JSON.stringify(data, null, 2));

  assert('simulator returns HTTP 200', response.status === 200, `HTTP ${response.status}`);
  assert('simulator reports success', data.success === true, `success=${data.success}`);
  assert('signature was verified', data.signatureVerified === true, 'HMAC-SHA256 valid');
  assert('transaction marked recovered in response', data.transaction?.recovered === true, 'recovered=true');

  // 3. Confirm database state
  const reloaded = await prisma.transaction.findUnique({
    where: { id: demoTx.id },
  });

  assert('database transaction marked recovered', reloaded?.recovered === true, `recovered=${reloaded?.recovered}`);
  assert('database status is recovered', reloaded?.status === 'recovered', `status="${reloaded?.status}"`);

  // 4. Confirm audit ledger row
  const auditRow = await prisma.auditLog.findFirst({
    where: { transactionId: demoTx.id, action: 'webhook_payment_captured' },
    orderBy: { timestamp: 'desc' },
  });

  assert('audit ledger records webhook capture', Boolean(auditRow), `action="${auditRow?.action}"`);
  assert('audit ledger marks recovered outcome', auditRow?.result === 'recovered' || auditRow?.result === 'webhook_confirmed_recovered', `result="${auditRow?.result}"`);

  // 5. Cleanup test artifact
  await prisma.auditLog.deleteMany({ where: { transactionId: demoTx.id } });
  await prisma.transaction.delete({ where: { id: demoTx.id } });

  console.log('\n  🧹 Cleanup completed. Benchmark dataset preserved intact.');
  console.log(hr('═'));
  console.log('  ✅ WEBHOOK SIMULATOR TEST: PASS\n');
}

run().catch((err) => {
  console.error('\n  ❌ Test failed:', err);
  process.exit(1);
});
