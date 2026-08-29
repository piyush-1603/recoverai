/**
 * /scripts/test-off-window.ts
 *
 * Validation test for TRAI SMS compliance window enforcement.
 * Evaluates customer 'insufficient_funds' transactions with forced currentHour = 23 (11 PM IST).
 *
 * Prints the exact raw decision objects for complete auditability.
 *
 * Run via: npm run test:off-window  OR  npx tsx --tsconfig tsconfig.scripts.json scripts/test-off-window.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide, PolicyDecision } from '../lib/policy-engine';

function hr(char = '─', len = 70): string {
  return char.repeat(len);
}

async function runOffWindowTest() {
  console.log('\n' + hr('═'));
  console.log('  🧪  TEST 3: TRAI COMPLIANCE OFF-WINDOW NUDGE DEFERRAL');
  console.log(hr('═'));

  const policyConfig = (await prisma.policyConfig.findFirst()) ?? {
    afaThresholdPaise: 1500000,
    maxRetries: 1,
    maxNudges: 2,
    nudgeWindowStartHour: 10,
    nudgeWindowEndHour: 21,
  };

  const forcedHour = 23; // 11:00 PM IST (Strictly outside 10:00 - 21:00)

  console.log(`  Configured Compliant Window : ${policyConfig.nudgeWindowStartHour}:00 – ${policyConfig.nudgeWindowEndHour}:00 IST`);
  console.log(`  Simulated Execution Hour    : ${forcedHour}:00 IST (Off-Window)\n`);

  // Load customer insufficient_funds transactions
  const transactions = await prisma.transaction.findMany({
    where: {
      source: 'customer',
      reasonCode: 'insufficient_funds',
    },
    orderBy: { createdAt: 'asc' },
  });

  if (transactions.length === 0) {
    console.log('⚠️  No customer insufficient_funds transactions found in DB. Run `npm run seed` first.');
    process.exit(1);
  }

  console.log(`  Evaluating ${transactions.length} customer insufficient_funds transactions at hour=23...\n`);

  let allPassed = true;
  const decisions: Array<{
    id: string;
    amount: string;
    decision: PolicyDecision;
    passed: boolean;
  }> = [];

  for (const tx of transactions) {
    const decision = diagnoseAndDecide(
      {
        ...tx,
        status: 'failed',
        retryCount: 0,
        nudgeCount: 0,
      },
      policyConfig,
      forcedHour,
    );

    const isActionNoAction = decision.action === 'no_action';
    const isReasonCorrect = decision.reason === 'outside compliant nudge window (TRAI SMS timing rules), deferred to next window';
    const isBlocked = decision.blockedByCompliance === true;
    const isApprovalFalse = decision.requiresApproval === false;

    const passed = isActionNoAction && isReasonCorrect && isBlocked && isApprovalFalse;
    if (!passed) {
      allPassed = false;
    }

    decisions.push({
      id: tx.externalPaymentId ?? tx.id,
      amount: `₹${(tx.amountPaise / 100).toFixed(2)}`,
      decision,
      passed,
    });
  }

  // Print raw decision objects for first 3 samples + summary table
  console.log('  🔍 Sample Raw Decision Objects Returned by policyEngine:');
  for (let i = 0; i < Math.min(3, decisions.length); i++) {
    const d = decisions[i];
    console.log(`\n  Sample [${i + 1}/${decisions.length}] - ${d.id} (${d.amount}):`);
    console.log(JSON.stringify(d.decision, null, 4));
  }

  console.log('\n  ' + hr('─'));
  console.log('  ' + 'TRANSACTION_ID'.padEnd(24) + 'ACTION'.padEnd(16) + 'COMPLIANCE_BLOCKED'.padEnd(20) + 'STATUS');
  console.log('  ' + hr('─'));

  for (const r of decisions) {
    console.log(
      '  ' +
      r.id.padEnd(24) +
      r.decision.action.padEnd(16) +
      String(r.decision.blockedByCompliance).padEnd(20) +
      (r.passed ? '✓ PASS' : '✗ FAIL'),
    );
  }

  console.log('\n' + hr());
  if (allPassed) {
    console.log('  ✅ TEST RESULT: PASS');
    console.log(`     All ${transactions.length}/${transactions.length} transactions returned:`);
    console.log(`     • action: "no_action" (NOT "send_nudge")`);
    console.log(`     • blockedByCompliance: true`);
    console.log(`     • reason: "outside compliant nudge window (TRAI SMS timing rules), deferred to next window"`);
  } else {
    console.log('  ❌ TEST RESULT: FAIL');
  }
  console.log(hr('═') + '\n');

  if (!allPassed) {
    process.exit(1);
  }
}

runOffWindowTest()
  .catch((e) => {
    console.error('Test execution error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
