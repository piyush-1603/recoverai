/**
 * /scripts/run-demo.ts
 *
 * One-Command Full Demo Execution Script for Judges & Stakeholders.
 *
 * Workflow:
 *  1. Resets database & seeds 65 transactions (55 payment + 10 cart abandonment).
 *  2. Evaluates every transaction through the pure policy engine (8-rule priority hierarchy).
 *  3. Executes actions through the action executor (state mutation gatekeeper).
 *  4. Writes immutable, idempotent audit log entries for every action.
 *  5. Prints aggregate metrics, action breakdowns, and honest exceptions list.
 *  6. Leaves database populated so /app/dashboard displays real metrics immediately.
 *
 * Run via: npm run demo  OR  npx tsx --tsconfig tsconfig.scripts.json scripts/run-demo.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide } from '../lib/policy-engine';
import { executeAction } from '../lib/action-executor';
import { writeEvent } from '../lib/audit-logger';
import { seedDatabase } from '../data/seed-transactions';

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function bar(label: string, value: string | number, width = 32): string {
  return `  ${label.padEnd(width)} ${value}`;
}

function hr(char = '─', len = 70): string {
  return char.repeat(len);
}

async function runDemo() {
  const startTime = Date.now();

  console.log('\n' + hr('═'));
  console.log('  🚀  RECOVERY ENGINE — FULL JUDGE DEMO PIPELINE');
  console.log(hr('═'));
  console.log(`  Execution Time : ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\n`);

  // 1. Seed Database (65 Transactions)
  await seedDatabase();

  // 2. Load Policy Config & Determine Hour
  const policyConfig = (await prisma.policyConfig.findFirst()) ?? {
    afaThresholdPaise: 1500000,
    maxRetries: 1,
    maxNudges: 2,
    nudgeWindowStartHour: 10,
    nudgeWindowEndHour: 21,
  };

  const istHourStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    hour12: false,
  }).format(new Date());
  const currentHour = parseInt(istHourStr, 10);

  console.log('  ⚙️  Policy Engine Active Ruleset:');
  console.log(bar('  • AFA Threshold', rupees(policyConfig.afaThresholdPaise)));
  console.log(bar('  • Max Auto-Retries', policyConfig.maxRetries));
  console.log(bar('  • Max Nudges', policyConfig.maxNudges));
  console.log(bar('  • Nudge Compliance Window', `${policyConfig.nudgeWindowStartHour}:00 – ${policyConfig.nudgeWindowEndHour}:00 IST`));
  console.log(bar('  • Current Evaluation Hour', `${currentHour}:00 IST`));
  console.log();

  // 3. Load All Fresh Transactions
  const transactions = await prisma.transaction.findMany({
    orderBy: { createdAt: 'asc' },
  });

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
    type: string;
    amountPaise: number;
    reasonCode: string;
    reason: string;
  }> = [];

  let totalAtRiskPaise = 0;
  let totalRecoveredPaise = 0;
  let totalRecoveredCount = 0;

  console.log(`  🔄 Processing ${transactions.length} transactions across policy engine...`);

  for (const tx of transactions) {
    totalAtRiskPaise += tx.amountPaise;

    const decision = diagnoseAndDecide(tx, policyConfig, currentHour);
    const result = await executeAction(decision, tx, 'simulate');

    await writeEvent(
      tx.id,
      'action_executor',
      decision.action,
      result.note || decision.reason,
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
        type: tx.type,
        amountPaise: tx.amountPaise,
        reasonCode: tx.reasonCode || 'checkout_abandonment',
        reason: decision.reason,
      });
    }
  }

  // 4. Output Summary Report
  console.log('\n' + hr('═'));
  console.log('  📊  DEMO AGGREGATE RECOVERY RESULTS');
  console.log(hr('═'));
  console.log(bar('Total Transactions Processed', transactions.length));
  console.log(bar('Total At-Risk Volume', rupees(totalAtRiskPaise)));
  console.log(bar('Total Recovered Revenue', rupees(totalRecoveredPaise)));

  const recoveryRate =
    totalAtRiskPaise > 0
      ? ((totalRecoveredPaise / totalAtRiskPaise) * 100).toFixed(1)
      : '0.0';
  console.log(bar('Aggregate Recovery Rate', `${recoveryRate}%`));
  console.log(bar('Transactions Recovered', `${totalRecoveredCount}/${transactions.length}`));

  console.log('\n' + hr('─'));
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
    console.log(bar('    • Count', bucket.count));
    console.log(bar('    • At-Risk Amount', rupees(bucket.totalAmountPaise)));
    console.log(bar('    • Recovered Amount', rupees(bucket.recoveredAmountPaise)));
    console.log(bar('    • Success Rate', `${recRate}% (${bucket.recoveredCount}/${bucket.count})`));
    console.log();
  }

  // 5. Honest Exceptions
  if (unrecoverableList.length > 0) {
    console.log(hr('─'));
    console.log('  🚫  EXCEPTIONS LIST (Unrecoverable & Compliance Flags)\n');

    let totalUnrecoverablePaise = 0;
    for (const u of unrecoverableList) {
      totalUnrecoverablePaise += u.amountPaise;
      console.log(
        `  • ${(u.externalPaymentId ?? u.id).padEnd(28)} ${rupees(u.amountPaise).padStart(12)}  [${u.type}]`,
      );
      console.log(`    Reason Code : ${u.reasonCode}`);
      console.log(`    Policy Note : ${u.reason}`);
      console.log();
    }
    console.log(bar('  Total Unrecoverable', `${unrecoverableList.length} txns / ${rupees(totalUnrecoverablePaise)}`));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n' + hr('═'));
  console.log(`  ✅  DEMO COMPLETED IN ${elapsed}s`);
  console.log('  👉 Database populated! Open http://localhost:3000/dashboard to view live UI.');
  console.log(hr('═') + '\n');
}

runDemo()
  .catch((e) => {
    console.error('Demo execution failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
