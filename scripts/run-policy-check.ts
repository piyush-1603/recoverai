/**
 * /scripts/run-policy-check.ts
 *
 * Simulates policy diagnosis and execution across all seeded transactions.
 * Includes sequential live AI advisory reasoning (provider resolved at runtime
 * by lib/claude-agent.ts), policy authority verification, and detailed
 * AI vs Policy override reporting.
 *
 * Run via: npm run policy-check  OR  npx tsx --tsconfig tsconfig.scripts.json scripts/run-policy-check.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide } from '../lib/policy-engine';
import { recommendAction, describeConfiguredProviders } from '../lib/claude-agent';
import { executeAction, auditReasonSuffix } from '../lib/action-executor';
import { writeEvent, describeAdvisor } from '../lib/audit-logger';

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function bar(label: string, value: string | number, width = 32): string {
  return `  ${label.padEnd(width)} ${value}`;
}

function hr(char = '─', len = 72): string {
  return char.repeat(len);
}

async function runPolicyCheck() {
  console.log('\n' + hr('═'));
  console.log('  🧪  RECOVERY ENGINE — POLICY CHECK & AI OVERRIDE BENCHMARK');
  console.log(hr('═') + '\n');

  // 1. Pre-flight Freshness & Integrity Check
  const totalCount = await prisma.transaction.count();
  const allDbTransactions = await prisma.transaction.findMany({
    orderBy: { createdAt: 'asc' },
  });

  const isCountExact = totalCount === 65 || totalCount === 55;
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
    console.log(bar('  Transaction count', `${totalCount}/65 ${isCountExact ? '✓' : '✗'}`));
    console.log(bar('  Transactions with retryCount > 0', `${mutatedRetries.length} (expected 0)`));
    console.log(bar('  Transactions with nudgeCount > 0', `${mutatedNudges.length} (expected 0)`));
    console.log(bar('  Transactions already recovered', `${mutatedRecovered.length} (expected 0)`));
    console.log(bar('  Transactions with non-failed/pending status', `${invalidStatus.length} (expected 0)`));
    console.log('\n  👉 Fix: Run `npm run seed` to re-initialize a fresh 65-transaction dataset.');
    console.log(hr('═') + '\n');
    process.exit(1);
  }

  // 2. Load Policy Configuration
  const policyConfig = (await prisma.policyConfig.findFirst()) ?? {
    afaThresholdPaise: 1500000,
    maxRetries: 1,
    vipMaxRetries: 3,
    standardMaxRetries: 1,
    trialMaxRetries: 1,
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

  console.log('  Policy Configuration:');
  console.log(bar('AFA Threshold', rupees(policyConfig.afaThresholdPaise)));
  console.log(bar('VIP Max Retries', `${policyConfig.vipMaxRetries ?? 3} attempts`));
  console.log(bar('Standard Max Retries', `${policyConfig.standardMaxRetries ?? 1} attempt`));
  console.log(bar('Nudge Window', `${policyConfig.nudgeWindowStartHour}:00 – ${policyConfig.nudgeWindowEndHour}:00 IST`));
  console.log(bar('Current Evaluation Hour', `${currentHour}:00 IST`));
  const providerChain = describeConfiguredProviders();
  console.log(
    bar(
      'AI Advisory Chain',
      providerChain.length
        ? providerChain.map((p) => `${p.provider} (${p.model})`).join(' → ')
        : 'none configured',
    ),
  );

  // 3. Process Transactions Sequentially with the live AI advisory layer
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

  const overriddenCases: Array<{
    transactionId: string;
    externalPaymentId: string | null;
    customerTier: string;
    amountPaise: number;
    aiAction: string;
    aiReasoning: string;
    advisor: string;
    policyAction: string;
    policyReason: string;
    executedAction: string;
  }> = [];

  let totalAtRiskPaise = 0;
  let totalRecoveredPaise = 0;
  let totalRecoveredCount = 0;
  let aiMatchedCount = 0;
  let aiOverriddenCount = 0;

  // Provider/model combinations that actually answered, tallied from live responses.
  const observedAdvisors = new Map<string, number>();

  for (const tx of allDbTransactions) {
    totalAtRiskPaise += tx.amountPaise;

    // Step A: Live AI Advisory Recommendation (provider resolved at runtime)
    const aiRec = await recommendAction(tx as any, policyConfig);
    const advisorKey = `${aiRec.provider} (${aiRec.model})`;
    observedAdvisors.set(advisorKey, (observedAdvisors.get(advisorKey) ?? 0) + 1);
    const advisor = describeAdvisor(aiRec.provider, aiRec.model);

    // Step B: Pure Deterministic Policy Diagnosis (Authoritative)
    const policyDecision = diagnoseAndDecide(tx as any, policyConfig, currentHour);

    const isMatch = aiRec.recommendedAction === policyDecision.action;

    // Step C: Action Execution (Only Policy Engine decision is executed)
    const result = await executeAction(policyDecision, tx, 'simulate');
    // Empty on the simulate path; carries the real API error if a live call ever
    // fails here, so the executor's note can never be silently dropped.
    const executorNote = auditReasonSuffix(result);

    if (isMatch) {
      aiMatchedCount++;
      await writeEvent(
        tx.id,
        'ai_agent+policy_engine',
        policyDecision.action,
        `${advisor} recommended "${aiRec.recommendedAction}" (${aiRec.reasoning}) — Confirmed by policy: ${policyDecision.reason}${executorNote}`,
        result.outcome,
        undefined,
        policyDecision.policyVersion,
        aiRec.provider,
        aiRec.model,
      );
    } else {
      aiOverriddenCount++;
      await writeEvent(
        tx.id,
        'policy_engine_override',
        'override',
        `${advisor} recommended "${aiRec.recommendedAction}" (${aiRec.reasoning}) but policy engine enforced "${policyDecision.action}" per rule: ${policyDecision.reason}${executorNote}`,
        'ai_recommendation_overridden',
        undefined,
        policyDecision.policyVersion,
        aiRec.provider,
        aiRec.model,
      );

      overriddenCases.push({
        transactionId: tx.id,
        externalPaymentId: tx.externalPaymentId,
        customerTier: tx.customerTier,
        amountPaise: tx.amountPaise,
        aiAction: aiRec.recommendedAction,
        aiReasoning: aiRec.reasoning,
        advisor: advisorKey,
        policyAction: policyDecision.action,
        policyReason: policyDecision.reason,
        executedAction: policyDecision.action,
      });
    }

    if (!actionBuckets[policyDecision.action]) {
      actionBuckets[policyDecision.action] = {
        count: 0,
        totalAmountPaise: 0,
        recoveredCount: 0,
        recoveredAmountPaise: 0,
      };
    }
    const bucket = actionBuckets[policyDecision.action];
    bucket.count += 1;
    bucket.totalAmountPaise += tx.amountPaise;

    if (result.recovered && result.recoveredAmountPaise !== null) {
      bucket.recoveredCount += 1;
      bucket.recoveredAmountPaise += result.recoveredAmountPaise;
      totalRecoveredPaise += result.recoveredAmountPaise;
      totalRecoveredCount += 1;
    }

    if (policyDecision.action === 'stop_unrecoverable') {
      unrecoverableList.push({
        id: tx.id,
        externalPaymentId: tx.externalPaymentId,
        amountPaise: tx.amountPaise,
        reasonCode: tx.reasonCode || 'checkout_abandonment',
        reason: policyDecision.reason,
      });
    }
  }

  // 4. Print Summary & Overrides
  console.log('\n' + hr('─'));
  console.log('  🤖  AI RECOMMENDATIONS & POLICY OVERRIDE SUMMARY');
  console.log(hr('─'));
  console.log(
    bar(
      'Served By (observed)',
      Array.from(observedAdvisors.entries()).map(([a, c]) => `${c}× ${a}`).join(', ') || 'none',
    ),
  );
  console.log(
    bar(
      'AI Recommendations',
      `${allDbTransactions.length} total, ${aiMatchedCount} matched policy, ${aiOverriddenCount} overridden by policy engine`,
    ),
  );

  if (overriddenCases.length > 0) {
    console.log('\n  ⚡ Detailed Policy Override Log (AI vs Policy Engine Decisions):\n');
    for (let i = 0; i < overriddenCases.length; i++) {
      const oc = overriddenCases[i];
      console.log(`  [Override #${i + 1}] ${(oc.externalPaymentId || oc.transactionId).padEnd(26)} ${rupees(oc.amountPaise).padStart(12)}  [Tier: ${oc.customerTier.toUpperCase()}]`);
      console.log(`    • AI Wanted        : ${oc.aiAction.toUpperCase()} — via ${oc.advisor}`);
      console.log(`      Reasoning        : "${oc.aiReasoning}"`);
      console.log(`    • Policy Enforced  : ${oc.policyAction.toUpperCase()}`);
      console.log(`      Rule Rationale   : "${oc.policyReason}"`);
      console.log(`    • Action Executed  : ${oc.executedAction.toUpperCase()} (Policy Authority Maintained ✓)`);
      console.log();
    }
  }

  console.log(hr());
  console.log('  📊  AGGREGATE RECOVERY RESULTS');
  console.log(hr());
  console.log(bar('Total Transactions Evaluated', allDbTransactions.length));
  console.log(bar('Total At-Risk Volume', rupees(totalAtRiskPaise)));
  console.log(bar('Total Recovered Revenue', rupees(totalRecoveredPaise)));

  const recoveryRate =
    totalAtRiskPaise > 0
      ? ((totalRecoveredPaise / totalAtRiskPaise) * 100).toFixed(1)
      : '0.0';
  console.log(bar('Aggregate Recovery Rate', `${recoveryRate}%`));
  console.log(bar('Transactions Recovered', `${totalRecoveredCount}/${allDbTransactions.length}`));

  // 5. Honest Exceptions
  if (unrecoverableList.length > 0) {
    console.log('\n' + hr('─'));
    console.log('  🚫  EXCEPTIONS LIST (Unrecoverable & Compliance Flags)\n');

    let totalUnrecoverablePaise = 0;
    for (const u of unrecoverableList) {
      totalUnrecoverablePaise += u.amountPaise;
      console.log(
        `  • ${(u.externalPaymentId ?? u.id).padEnd(28)} ${rupees(u.amountPaise).padStart(12)}`,
      );
      console.log(`    Reason Code : ${u.reasonCode}`);
      console.log(`    Policy Note : ${u.reason}`);
      console.log();
    }
    console.log(bar('  Total Unrecoverable', `${unrecoverableList.length} txns / ${rupees(totalUnrecoverablePaise)}`));
  }

  console.log('\n' + hr('═'));
  console.log('  ✅  POLICY CHECK & AI BENCHMARK COMPLETE');
  console.log(hr('═') + '\n');
}

runPolicyCheck()
  .catch((e) => {
    console.error('Execution error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
