/**
 * /scripts/test-demo-baseline-isolation.ts
 *
 * Verifies the two dashboard demo buttons cannot degrade the frozen headline
 * baseline (₹2,47,958 recovered / 44 recoveries / ₹4,24,437 at-risk / 65 txns).
 *
 * For each button it captures the headline metrics exactly as /api/audit computes
 * them, fires the real server action path, and asserts every headline figure is
 * byte-identical afterwards — while still asserting a genuine audit row was
 * written (the demo must remain real, just isolated).
 *
 * Run via: npm run test:demo-isolation
 */

import 'dotenv/config';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/demo-trigger/route';
import { prisma } from '../lib/prisma';

function hr(char = '─', len = 74) {
  return char.repeat(len);
}
function rupees(paise: number) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

let failures = 0;
function assert(label: string, condition: boolean, detail: string) {
  if (!condition) failures++;
  console.log(`  ${condition ? '✓ PASS' : '✗ FAIL'}  ${label.padEnd(44)} ${detail}`);
}

/** Recomputes the headline exactly as app/api/audit/route.ts does. */
async function headline() {
  const transactions = await prisma.transaction.findMany({ where: { isDemoArtifact: false } });
  const exceptions = await prisma.transaction.count({
    where: { status: 'unrecoverable', isDemoArtifact: false },
  });
  let totalAtRiskPaise = 0;
  let totalRecoveredPaise = 0;
  let recoveredCount = 0;
  for (const tx of transactions) {
    totalAtRiskPaise += tx.amountPaise;
    if (tx.recovered && tx.simulatedRecoveryAmountPaise) {
      totalRecoveredPaise += tx.simulatedRecoveryAmountPaise;
      recoveredCount++;
    }
  }
  return {
    totalTransactions: transactions.length,
    totalAtRiskPaise,
    totalRecoveredPaise,
    recoveredCount,
    unrecoverableCount: exceptions,
    recoveryRate:
      totalAtRiskPaise > 0 ? Number(((totalRecoveredPaise / totalAtRiskPaise) * 100).toFixed(1)) : 0,
  };
}

function show(label: string, h: Awaited<ReturnType<typeof headline>>) {
  console.log(`  ${label}`);
  console.log(`    transactions ${String(h.totalTransactions).padStart(3)}   at-risk ${rupees(h.totalAtRiskPaise).padStart(14)}   recovered ${rupees(h.totalRecoveredPaise).padStart(14)}   count ${String(h.recoveredCount).padStart(2)}   rate ${h.recoveryRate}%   exceptions ${h.unrecoverableCount}`);
}

async function fireButton(kind: 'live' | 'compliance', secret: string) {
  const body = kind === 'compliance' ? { hourOverride: 2 } : {};
  const response = await POST(
    new NextRequest('http://localhost:3000/api/demo-trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-demo-secret': secret },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, payload: await response.json() };
}

async function exerciseButton(kind: 'live' | 'compliance', secret: string) {
  console.log('\n' + hr('─'));
  console.log(`  BUTTON: ${kind === 'compliance' ? 'OFF-WINDOW COMPLIANCE TEST' : 'TRIGGER LIVE DEMO EVENT'}`);
  console.log(hr('─'));

  const before = await headline();
  show('BEFORE', before);

  const { status, payload } = await fireButton(kind, secret);

  const after = await headline();
  show('AFTER ', after);
  console.log();

  assert(`${kind}: request succeeded`, status === 200, `HTTP ${status}`);
  assert(`${kind}: transaction count unchanged`, after.totalTransactions === before.totalTransactions, `${before.totalTransactions} -> ${after.totalTransactions}`);
  assert(`${kind}: at-risk volume unchanged`, after.totalAtRiskPaise === before.totalAtRiskPaise, `${rupees(before.totalAtRiskPaise)} -> ${rupees(after.totalAtRiskPaise)}`);
  assert(`${kind}: recovered revenue unchanged`, after.totalRecoveredPaise === before.totalRecoveredPaise, `${rupees(before.totalRecoveredPaise)} -> ${rupees(after.totalRecoveredPaise)}`);
  assert(`${kind}: recovery count unchanged`, after.recoveredCount === before.recoveredCount, `${before.recoveredCount} -> ${after.recoveredCount}`);
  assert(`${kind}: recovery rate unchanged`, after.recoveryRate === before.recoveryRate, `${before.recoveryRate}% -> ${after.recoveryRate}%`);
  assert(`${kind}: exception count unchanged`, after.unrecoverableCount === before.unrecoverableCount, `${before.unrecoverableCount} -> ${after.unrecoverableCount}`);

  // The demo must still be REAL, not a no-op.
  const target = await prisma.transaction.findUnique({ where: { id: payload.transactionId } });
  assert(`${kind}: target is a flagged demo artifact`, target?.isDemoArtifact === true, `isDemoArtifact=${target?.isDemoArtifact}`);
  assert(`${kind}: target is NOT part of the 65-txn benchmark`, target?.externalPaymentId?.startsWith('pay_demo_') === true, `${target?.externalPaymentId}`);
  assert(`${kind}: policy engine produced a decision`, Boolean(payload.decision?.action), `action="${payload.decision?.action}"`);
  assert(`${kind}: an audit row was written`, (await prisma.auditLog.count({ where: { transactionId: payload.transactionId } })) > 0, 'ledger entry present');

  if (kind === 'compliance') {
    assert('compliance: routed to no_action (TRAI window)', payload.decision?.action === 'no_action', `action="${payload.decision?.action}"`);
    assert('compliance: flagged blockedByCompliance', payload.decision?.blockedByCompliance === true, `${payload.decision?.blockedByCompliance}`);
  }

  return { before, after, payload };
}

async function run() {
  console.log('\n' + hr('═'));
  console.log('  🧪  DEMO BUTTON / BASELINE ISOLATION TEST (P6)');
  console.log(hr('═'));

  const secret = process.env.DEMO_TRIGGER_SECRET;
  if (!secret) {
    console.error('  ❌ DEMO_TRIGGER_SECRET is not set; cannot exercise the trigger.');
    process.exit(1);
  }

  const opening = await headline();

  await exerciseButton('compliance', secret);
  await exerciseButton('live', secret);

  // Repeated clicks must not accumulate demo rows.
  console.log('\n' + hr('─'));
  console.log('  REPEAT-CLICK IDEMPOTENCE (3 more clicks of each)');
  console.log(hr('─'));
  for (let i = 0; i < 3; i++) {
    await fireButton('compliance', secret);
    await fireButton('live', secret);
  }
  const demoRows = await prisma.transaction.count({ where: { isDemoArtifact: true } });
  const closing = await headline();
  assert('demo artifacts do not accumulate', demoRows === 2, `${demoRows} demo rows (expected exactly 2)`);
  assert('headline still identical after 8 clicks', JSON.stringify(closing) === JSON.stringify(opening), 'all figures stable');
  show('OPENING', opening);
  show('CLOSING', closing);

  console.log('\n' + hr('─'));
  console.log('  DEMO ARTIFACTS ON DISK (excluded from headline, visible in ledger)');
  console.log(hr('─'));
  const artifacts = await prisma.transaction.findMany({ where: { isDemoArtifact: true } });
  for (const a of artifacts) {
    const rows = await prisma.auditLog.count({ where: { transactionId: a.id } });
    console.log(`  ${a.externalPaymentId?.padEnd(24)} ${rupees(a.amountPaise).padStart(11)}  source=${a.source.padEnd(9)} status=${a.status.padEnd(10)} auditRows=${rows}`);
  }

  console.log('\n' + hr('═'));
  if (failures === 0) {
    console.log('  ✅ TEST RESULT: PASS — both demo buttons are fully isolated from the baseline.');
  } else {
    console.log(`  ❌ TEST RESULT: FAIL — ${failures} assertion(s) failed.`);
  }
  console.log(hr('═') + '\n');
  if (failures > 0) process.exit(1);
}

run()
  .catch((e) => {
    console.error('Test execution error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
