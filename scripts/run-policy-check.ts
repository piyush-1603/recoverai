/**
 * /scripts/run-policy-check.ts
 *
 * CLI script: verifies fresh dataset baseline, diagnoses each transaction via pure
 * policy engine, executes actions through action executor, writes idempotent audit logs,
 * and prints detailed per-transaction details and aggregate recovery summaries.
 *
 * NOTE: This simulation MUTATES transaction state (status, retryCount, nudgeCount, etc.).
 * To run clean benchmark experiments, always run 'npm run seed' beforehand.
 *
 * Run: npm run policy-check  OR  npx ts-node --project tsconfig.scripts.json scripts/run-policy-check.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide } from '../lib/policy-engine';
import { executeAction } from '../lib/action-executor';
import { writeEvent } from '../lib/audit-logger';

// ── Formatting helpers ───────────────────────────────────────────────────────

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function bar(label: string, value: string | number, width = 28): string {
  return `  ${label.padEnd(width)} ${value}`;
}

function hr(char = '─', len = 64): string {
  return char.repeat(len);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();

  console.log('\n' + hr('═'));
  console.log('  🔍  RECOVERY ENGINE — POLICY CHECK SIMULATION');
  console.log(hr('═'));
  console.log(`  Run timestamp: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  console.log('  ⚠️  STATEFUL NOTICE: This script executes actions and mutates database state.');
  console.log('      To reset to a clean evaluation baseline at any time, run: npm run seed\n');

  // 1. Pre-Run Fresh State Verification
  const allDbTransactions = await prisma.transaction.findMany({
    orderBy: { createdAt: 'asc' },
  });

  const totalCount = allDbTransactions.length;
  const isCountExact = totalCount === 55;

  const mutatedRetries = allDbTransactions.filter((t) => t.retryCount > 0);
  const mutatedNudges = allDbTransactions.filter((t) => t.nudgeCount > 0);
  const mutatedRecovered = allDbTransactions.filter((t) => t.recovered === true);
  const invalidStatus = allDbTransactions.filter(
    (t) => t.status !== 'failed' && t.status !== 'pending',
  );

  const isFresh =
    isCountExact &&
    mutatedRetries.length === 0 &&
    mutatedNudges.length === 0 &&
    mutatedRecovered.length === 0 &&
    invalidStatus.length === 0;

  if (!isFresh) {
    console.log(hr('!'));
    console.log('  ❌ PRECONDITION FAILED: DATASET IS NOT FRESH');
    console.log(hr('!'));
    console.log(bar('  Transaction count', `${totalCount}/55 ${isCountExact ? '✓' : '✗'}`));
    console.log(bar('  Transactions with retryCount > 0', `${mutatedRetries.length} (expected 0)`));
    console.log(bar('  Transactions with nudgeCount > 0', `${mutatedNudges.length} (expected 0)`));
    console.log(bar('  Transactions already recovered', `${mutatedRecovered.length} (expected 0)`));
    console.log(bar('  Transactions with non-failed status', `${invalidStatus.length} (expected 0)`));
    console.log('\n  👉 Fix: Run `npm run seed` to re-initialize a fresh 55-transaction dataset.');
    console.log(hr('═') + '\n');
    process.exit(1);
  }

  // 2. Load Policy Configuration
  const policyConfig = (await prisma.policyConfig.findFirst()) ?? {
    afaThresholdPaise: 1500000,
    maxRetries: 1,
    maxNudges: 2,
    nudgeWindowStartHour: 10,
    nudgeWindowEndHour: 21,
  };

  // Determine current IST hour accurately
  const istHourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  const currentHour = parseInt(istHourStr, 10);

  console.log('  Policy Configuration:');
  console.log(bar('AFA Threshold', rupees(policyConfig.afaThresholdPaise)));
  console.log(bar('Max Retries', policyConfig.maxRetries));
  console.log(bar('Max Nudges', policyConfig.maxNudges));
  console.log(bar('Nudge Window', `${policyConfig.nudgeWindowStartHour}:00 – ${policyConfig.nudgeWindowEndHour}:00 IST`));
  console.log(bar('Current Evaluation Hour', `${currentHour}:00 IST`));

  // 3. Process Transactions
  type ActionBucket = {
    count: number;
    totalAmountPaise: number;
    recoveredCount: number;
    recoveredAmountPaise: number;
  };

  const actionBuckets: Record<string, ActionBucket> = {};
  const unrecoverableList: Array<{
    id: string;
    externalPaymentId: string | null;
    amountPaise: number;
    reasonCode: string;
    reason: string;
  }> = [];

  let totalAtRiskPaise = 0;
  let totalRecoveredPaise = 0;
  let totalRecoveredCount = 0;

  const txRows: Array<{
    payId: string;
    source: string;
    type: string;
    reasonCode: string;
    amount: string;
    retryCount: number;
    nudgeCount: number;
    action: string;
    outcome: string;
    reason: string;
  }> = [];

  for (const tx of allDbTransactions) {
    totalAtRiskPaise += tx.amountPaise;

    const decision = diagnoseAndDecide(tx, policyConfig, currentHour);
    const result = await executeAction(decision, tx);

    await writeEvent(
      tx.id,
      'action_executor',
      decision.action,
      decision.reason,
      result.outcome,
    );

    if (!actionBuckets[decision.action]) {
      actionBuckets[decision.action] = {
        count: 0,
        totalAmountPaise: 0,
        recoveredCount: 0,
        recoveredAmountPaise: 0,
      };
    }
    const bucket = actionBuckets[decision.action];
    bucket.count += 1;
    bucket.totalAmountPaise += tx.amountPaise;

    if (result.recovered && result.recoveredAmountPaise !== null) {
      bucket.recoveredCount += 1;
      bucket.recoveredAmountPaise += result.recoveredAmountPaise;
      totalRecoveredPaise += result.recoveredAmountPaise;
      totalRecoveredCount += 1;
    }

    if (decision.action === 'stop_unrecoverable') {
      unrecoverableList.push({
        id: tx.id,
        externalPaymentId: tx.externalPaymentId,
        amountPaise: tx.amountPaise,
        reasonCode: tx.reasonCode,
        reason: decision.reason,
      });
    }

    txRows.push({
      payId: (tx.externalPaymentId ?? tx.id).slice(0, 20),
      source: tx.source,
      type: tx.type,
      reasonCode: tx.reasonCode,
      amount: rupees(tx.amountPaise),
      retryCount: tx.retryCount,
      nudgeCount: tx.nudgeCount,
      action: decision.action,
      outcome: result.outcome,
      reason: decision.reason,
    });
  }

  // 4. Policy Coverage Evaluation
  const autoRetryCount = actionBuckets['auto_retry']?.count || 0;
  const sendNudgeCount = actionBuckets['send_nudge']?.count || 0;
  const requestApprovalCount = actionBuckets['request_approval']?.count || 0;
  const stopUnrecoverableCount = actionBuckets['stop_unrecoverable']?.count || 0;

  const policyCoveragePass =
    autoRetryCount > 0 &&
    (sendNudgeCount > 0 || currentHour < policyConfig.nudgeWindowStartHour || currentHour >= policyConfig.nudgeWindowEndHour) &&
    requestApprovalCount > 0 &&
    stopUnrecoverableCount > 0;

  // 5. Print Validation Summary Section
  console.log('\n' + hr());
  console.log('  🛡️  EXPERIMENT VALIDATION');
  console.log(hr());
  console.log(bar('Seed validation', 'PASS'));
  console.log(bar('Transaction count', `${totalCount}/55 (PASS)`));
  console.log(bar('Fresh state', 'PASS (Pre-run retries=0, nudges=0, recovered=false)'));
  console.log(
    bar(
      'Policy coverage',
      policyCoveragePass
        ? 'PASS (auto_retry, send_nudge, request_approval, stop_unrecoverable active)'
        : 'FAIL',
    ),
  );

  // 6. Print Per-Transaction Detail Table
  console.log('\n' + hr());
  console.log('  📝  PER-TRANSACTION EVALUATION DETAIL');
  console.log(hr());

  const colPayId = 22;
  const colSrc = 10;
  const colType = 14;
  const colReason = 32;
  const colAmt = 12;
  const colR = 3;
  const colN = 3;
  const colAction = 20;
  const colOutcome = 26;

  console.log(
    '  ' +
    'PAYMENT_ID'.padEnd(colPayId) +
    'SOURCE'.padEnd(colSrc) +
    'TYPE'.padEnd(colType) +
    'REASON_CODE'.padEnd(colReason) +
    'AMOUNT'.padStart(colAmt) +
    '  ' +
    'R'.padStart(colR) +
    'N'.padStart(colN) +
    '  ' +
    'ACTION'.padEnd(colAction) +
    'OUTCOME'.padEnd(colOutcome),
  );
  console.log(
    '  ' +
    '─'.repeat(colPayId + colSrc + colType + colReason + colAmt + colR + colN + colAction + colOutcome + 4),
  );

  for (const row of txRows) {
    console.log(
      '  ' +
      row.payId.padEnd(colPayId) +
      row.source.padEnd(colSrc) +
      row.type.padEnd(colType) +
      row.reasonCode.padEnd(colReason) +
      row.amount.padStart(colAmt) +
      '  ' +
      String(row.retryCount).padStart(colR) +
      String(row.nudgeCount).padStart(colN) +
      '  ' +
      row.action.padEnd(colAction) +
      row.outcome.padEnd(colOutcome),
    );
  }
  console.log('  (R = retryCount, N = nudgeCount prior to action execution)');

  // 7. Aggregate Summary
  console.log('\n' + hr());
  console.log('  📊  AGGREGATE RECOVERY SUMMARY');
  console.log(hr());
  console.log(bar('Total transactions processed', totalCount));
  console.log(bar('Total at-risk amount', rupees(totalAtRiskPaise)));
  console.log(bar('Total simulated recovered', rupees(totalRecoveredPaise)));

  const recoveryRate =
    totalAtRiskPaise > 0
      ? ((totalRecoveredPaise / totalAtRiskPaise) * 100).toFixed(1)
      : '0.0';
  console.log(bar('Recovery rate', `${recoveryRate}%`));
  console.log(bar('Transactions recovered', `${totalRecoveredCount}/${totalCount}`));

  console.log('\n' + hr());
  console.log('  📋  BREAKDOWN BY ACTION TAKEN\n');

  const actionOrder = [
    'auto_retry',
    'send_nudge',
    'request_approval',
    'stop_unrecoverable',
    'no_action',
  ];

  for (const action of actionOrder) {
    const bucket = actionBuckets[action];
    if (!bucket) continue;

    const recRate =
      bucket.count > 0
        ? ((bucket.recoveredCount / bucket.count) * 100).toFixed(0)
        : '0';

    console.log(`  ▸ ${action.toUpperCase().replace(/_/g, ' ')}`);
    console.log(bar('    Count', bucket.count));
    console.log(bar('    At-risk amount', rupees(bucket.totalAmountPaise)));
    console.log(bar('    Recovered amount', rupees(bucket.recoveredAmountPaise)));
    console.log(bar('    Recovery rate', `${recRate}% (${bucket.recoveredCount}/${bucket.count})`));
    console.log();
  }

  // 8. Honest Exceptions List
  if (unrecoverableList.length > 0) {
    console.log(hr());
    console.log('  🚫  UNRECOVERABLE TRANSACTIONS (Honest Exceptions List)\n');

    let totalUnrecoverablePaise = 0;
    for (const u of unrecoverableList) {
      totalUnrecoverablePaise += u.amountPaise;
      console.log(
        `  • ${(u.externalPaymentId ?? u.id).padEnd(24)} ${rupees(u.amountPaise).padStart(14)}`,
      );
      console.log(`    reason_code : ${u.reasonCode}`);
      console.log(`    policy note : ${u.reason}`);
      console.log();
    }

    console.log(bar('  Total unrecoverable', `${unrecoverableList.length} txns / ${rupees(totalUnrecoverablePaise)}`));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n' + hr('═'));
  console.log(`  ✅  Simulation completed successfully in ${elapsed}s`);
  console.log(hr('═') + '\n');
}

main()
  .catch((e) => {
    console.error('\n❌ Policy check failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
