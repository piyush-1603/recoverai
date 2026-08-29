/**
 * /scripts/test-retry-exhaustion.ts
 *
 * Validation test for Retry Limit Exhaustion enforcement (Rule 4 vs Rule 2).
 * Verifies that a transient gateway failure transitions from Rule 5 (auto_retry) on pass 1
 * to Rule 4 (stop_unrecoverable due to exhaustion) on pass 2, NOT Rule 2 (compliance flag).
 *
 * Run via: npm run test:retry-exhaustion  OR  npx tsx --tsconfig tsconfig.scripts.json scripts/test-retry-exhaustion.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide } from '../lib/policy-engine';
import { executeAction } from '../lib/action-executor';

function hr(char = '─', len = 70): string {
  return char.repeat(len);
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

  // Target a transient gateway error with expectedRecoveryOutcome='never_recovers'
  const testTx = await prisma.transaction.findFirst({
    where: {
      source: 'gateway',
      reasonCode: 'gateway_technical_error',
      expectedRecoveryOutcome: 'never_recovers',
    },
  });

  if (!testTx) {
    console.log('  No suitable transaction found. Run `npm run seed` first.');
    process.exit(1);
  }

  // Reset to clean 0-retry state for isolated verification
  const cleanTx = await prisma.transaction.update({
    where: { id: testTx.id },
    data: {
      retryCount: 0,
      nudgeCount: 0,
      status: 'failed',
      recovered: false,
      resolvedAt: null,
    },
  });

  console.log('  Target Transaction:');
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

  const pass1Execution = await executeAction(pass1Decision, cleanTx);

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

  const pass2Execution = await executeAction(pass2Decision, txAfterPass1);

  const txAfterPass2 = await prisma.transaction.findUniqueOrThrow({
    where: { id: cleanTx.id },
  });

  console.log(`\n  DB Mutation After Pass 2: retryCount=${txAfterPass2.retryCount}, status=${txAfterPass2.status}, resolvedAt=${txAfterPass2.resolvedAt ? 'Set ✓' : 'Null'}`);

  // Distinctness checks:
  const isStopUnrecoverable = pass2Decision.action === 'stop_unrecoverable';
  const isRule4Reason = pass2Decision.reason === 'exhausted retry and nudge limits';
  const isNotRule2 = !pass2Decision.reason.includes('flagged reason code');
  const isBlockedFalse = pass2Decision.blockedByCompliance === false;
  const isDBUnrecoverable = txAfterPass2.status === 'unrecoverable';

  console.log('\n  Rule Differentiation Analysis:');
  console.log(`    • Fired Rule 4 (Limits Exhausted) : ${isRule4Reason ? '✓ YES ("exhausted retry and nudge limits")' : '✗ NO'}`);
  console.log(`    • Fired Rule 2 (Compliance Flag)  : ${!isNotRule2 ? 'YES' : '✓ NO (distinct reason & compliance flag)'}`);
  console.log(`    • blockedByCompliance             : ${isBlockedFalse ? 'false (correct for Rule 4)' : 'true'}`);

  const pass2Valid =
    isStopUnrecoverable && isRule4Reason && isNotRule2 && isBlockedFalse && isDBUnrecoverable;

  console.log(`  Pass 2 Validation                 : ${pass2Valid ? '✓ PASS (Routed via Rule 4)' : '✗ FAIL'}\n`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(hr());
  const overallPassed = pass1Valid && pass2Valid;
  if (overallPassed) {
    console.log('  ✅ TEST RESULT: PASS');
    console.log('     Confirmed Pass 1 matches Rule 5 (transient auto-retry within limit).');
    console.log('     Confirmed Pass 2 matches Rule 4 (exhausted retry and nudge limits).');
    console.log('     Confirmed distinctly isolated from Rule 2 (compliance flagged codes).');
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
