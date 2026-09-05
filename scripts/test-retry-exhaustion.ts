/**
 * /scripts/test-retry-exhaustion.ts
 *
 * Validation test for Retry Limit Exhaustion enforcement (Rule 4 vs Rule 2).
 * Verifies that a transient gateway failure transitions from Rule 5 (auto_retry) on pass 1
 * to Rule 4 (stop_unrecoverable due to exhaustion) on pass 2, NOT Rule 2 (compliance flag).
 *
 * BASELINE SAFETY: this test drives a transaction all the way to
 * status='unrecoverable', so it operates on a throwaway record it creates and
 * removes in a `finally` block. It previously mutated a real seeded row
 * (pay_test_gw_027) and left it unrecoverable, which inflated the dashboard's
 * honest-exceptions count from 6 to 7 until someone restored the baseline.
 * The throwaway is flagged isDemoArtifact so it is excluded from headline
 * metrics even while it exists, and a post-run integrity check asserts no real
 * row was touched.
 *
 * Run via: npm run test:retry-exhaustion
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide } from '../lib/policy-engine';
import { executeAction } from '../lib/action-executor';

function hr(char = '─', len = 70): string {
  return char.repeat(len);
}

/** Snapshot of everything the headline metrics are computed from. */
async function baselineSnapshot() {
  const [transactions, recovered, unrecoverable, auditRows] = await Promise.all([
    prisma.transaction.count({ where: { isDemoArtifact: false } }),
    prisma.transaction.count({ where: { isDemoArtifact: false, recovered: true } }),
    prisma.transaction.count({ where: { isDemoArtifact: false, status: 'unrecoverable' } }),
    prisma.auditLog.count({ where: { transaction: { isDemoArtifact: false } } }),
  ]);
  return { transactions, recovered, unrecoverable, auditRows };
}

async function runRetryExhaustionTest() {
  console.log('\n' + hr('═'));
  console.log('  🧪  TEST 4: RETRY LIMIT EXHAUSTION (RULE 4 vs RULE 2 ROUTING)');
  console.log(hr('═'));

  const policyConfig = (await prisma.policyConfig.findFirst()) ?? {
    afaThresholdPaise: 1500000,
    maxRetries: 1,
    maxNudges: 2,
    nudgeWindowStartHour: 10,
    nudgeWindowEndHour: 21,
  };

  console.log(`  Policy Max Retries : ${policyConfig.maxRetries}`);
  console.log(`  Policy Max Nudges  : ${policyConfig.maxNudges}\n`);

  const before = await baselineSnapshot();
  console.log(`  Baseline before run: ${before.transactions} txns, ${before.recovered} recovered, ${before.unrecoverable} unrecoverable, ${before.auditRows} audit rows\n`);

  // A throwaway record shaped like a transient gateway failure that never
  // recovers — so pass 1 retries within limit and pass 2 exhausts. Mirrors the
  // seeded pay_test_gw_027 shape without touching it.
  const cleanTx = await prisma.transaction.create({
    data: {
      externalPaymentId: `pay_test_exhaustion_${Date.now()}`,
      amountPaise: 149900,
      status: 'failed',
      reasonCode: 'gateway_technical_error', // NOT a flagged compliance code
      source: 'gateway',
      type: 'payment',
      customerId: 'cust_test_exhaustion',
      customerTier: 'standard', // standard tier -> maxRetries 1
      retryCount: 0,
      nudgeCount: 0,
      recovered: false,
      expectedRecoveryOutcome: 'never_recovers',
      simulatedRecoveryAmountPaise: 0,
      isDemoArtifact: true,
    },
  });

  let overallPassed = false;

  try {
    console.log('  Target Transaction (throwaway, isDemoArtifact=true):');
    console.log(`    • ID            : ${cleanTx.id}`);
    console.log(`    • External ID   : ${cleanTx.externalPaymentId}`);
    console.log(`    • Source        : ${cleanTx.source} (transient gateway source)`);
    console.log(`    • Reason Code   : ${cleanTx.reasonCode} (NOT a flagged compliance risk code)`);
    console.log(`    • Initial State : retryCount=${cleanTx.retryCount}, status=${cleanTx.status}\n`);

    const currentHour = 14; // 2:00 PM IST

    // ── PASS 1: Initial Attempt (retryCount = 0) ─────────────────────────────
    console.log('  ──────────────────────────────────────────────────────────────────');
    console.log('  🔄 PASS 1 (Initial Retry: retryCount = 0 < maxRetries)');
    console.log('  ──────────────────────────────────────────────────────────────────');

    const pass1Decision = diagnoseAndDecide(cleanTx, policyConfig, currentHour);
    console.log('  Raw Pass 1 Decision Object:');
    console.log(JSON.stringify(pass1Decision, null, 4));

    await executeAction(pass1Decision, cleanTx);

    const txAfterPass1 = await prisma.transaction.findUniqueOrThrow({
      where: { id: cleanTx.id },
    });

    console.log(`\n  DB Mutation After Pass 1: retryCount=${txAfterPass1.retryCount}, status=${txAfterPass1.status}`);

    const pass1Valid =
      pass1Decision.action === 'auto_retry' &&
      pass1Decision.reason.includes('auto-retry within limit') &&
      txAfterPass1.retryCount === 1 &&
      (txAfterPass1.status === 'failed' || txAfterPass1.status === 'pending');

    console.log(`  Pass 1 Validation       : ${pass1Valid ? '✓ PASS (Routed via Rule 5)' : '✗ FAIL'}\n`);

    // ── PASS 2: Second Attempt (retryCount = 1 >= maxRetries) ────────────────
    console.log('  ──────────────────────────────────────────────────────────────────');
    console.log('  🛑 PASS 2 (Second Evaluation: retryCount = 1 >= maxRetries)');
    console.log('  ──────────────────────────────────────────────────────────────────');

    const pass2Decision = diagnoseAndDecide(txAfterPass1, policyConfig, currentHour);
    console.log('  Raw Pass 2 Decision Object:');
    console.log(JSON.stringify(pass2Decision, null, 4));

    await executeAction(pass2Decision, txAfterPass1);

    const txAfterPass2 = await prisma.transaction.findUniqueOrThrow({
      where: { id: cleanTx.id },
    });

    console.log(`\n  DB Mutation After Pass 2: retryCount=${txAfterPass2.retryCount}, status=${txAfterPass2.status}, resolvedAt=${txAfterPass2.resolvedAt ? 'Set ✓' : 'Null'}`);

    // Distinctness checks:
    const isStopUnrecoverable = pass2Decision.action === 'stop_unrecoverable';
    const isRule4Reason =
      pass2Decision.reason === 'exhausted retry limits' ||
      pass2Decision.reason === 'exhausted retry and nudge limits';
    const isNotRule2 = !pass2Decision.reason.includes('flagged reason code');
    const isBlockedFalse = pass2Decision.blockedByCompliance === false;
    const isDBUnrecoverable = txAfterPass2.status === 'unrecoverable';

    console.log('\n  Rule Differentiation Analysis:');
    console.log(`    • Fired Rule 4 (Limits Exhausted) : ${isRule4Reason ? `✓ YES ("${pass2Decision.reason}")` : '✗ NO'}`);
    console.log(`    • Fired Rule 2 (Compliance Flag)  : ${!isNotRule2 ? 'YES' : '✓ NO (distinct reason & compliance flag)'}`);
    console.log(`    • blockedByCompliance             : ${isBlockedFalse ? 'false (correct for Rule 4)' : 'true'}`);

    const pass2Valid =
      isStopUnrecoverable && isRule4Reason && isNotRule2 && isBlockedFalse && isDBUnrecoverable;

    console.log(`  Pass 2 Validation                 : ${pass2Valid ? '✓ PASS (Routed via Rule 4)' : '✗ FAIL'}\n`);

    // ── Baseline isolation check ─────────────────────────────────────────────
    // The throwaway is now unrecoverable. Prove that fact did not reach the
    // official dataset — this is the assertion that would have caught the
    // 6-exceptions-becomes-7 regression this rewrite fixes.
    console.log('  ──────────────────────────────────────────────────────────────────');
    console.log('  🔒 BASELINE ISOLATION CHECK');
    console.log('  ──────────────────────────────────────────────────────────────────');

    const during = await baselineSnapshot();
    const isolationOk =
      during.transactions === before.transactions &&
      during.recovered === before.recovered &&
      during.unrecoverable === before.unrecoverable &&
      during.auditRows === before.auditRows;

    console.log(`    • Real transactions   : ${before.transactions} -> ${during.transactions}`);
    console.log(`    • Real recovered      : ${before.recovered} -> ${during.recovered}`);
    console.log(`    • Real unrecoverable  : ${before.unrecoverable} -> ${during.unrecoverable}  (this is the honest-exceptions figure)`);
    console.log(`    • Real audit rows     : ${before.auditRows} -> ${during.auditRows}`);
    console.log(`    Isolation Result      : ${isolationOk ? '✓ PASS (no real row touched)' : '✗ FAIL (baseline mutated!)'}\n`);

    overallPassed = pass1Valid && pass2Valid && isolationOk;
  } finally {
    // Cleanup in `finally` so a mid-test throw cannot leave an unrecoverable
    // record behind.
    await prisma.auditLog.deleteMany({ where: { transactionId: cleanTx.id } });
    await prisma.transaction.delete({ where: { id: cleanTx.id } }).catch(() => {});
    console.log('  🧹 Cleanup: throwaway transaction and its audit rows deleted.');
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(hr());
  if (overallPassed) {
    console.log('  ✅ TEST RESULT: PASS');
    console.log('     Confirmed Pass 1 matches Rule 5 (transient auto-retry within limit).');
    console.log('     Confirmed Pass 2 matches Rule 4 (exhausted retry and nudge limits).');
    console.log('     Confirmed distinctly isolated from Rule 2 (compliance flagged codes).');
    console.log('     Confirmed the official baseline was left untouched.');
  } else {
    console.log('  ❌ TEST RESULT: FAIL');
  }
  console.log(hr('═') + '\n');

  if (!overallPassed) {
    process.exit(1);
  }
}

runRetryExhaustionTest()
  .catch((e) => {
    console.error('Test execution error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
