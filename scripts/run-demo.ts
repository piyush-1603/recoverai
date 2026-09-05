/**
 * /scripts/run-demo.ts
 *
 * Real AI API Execution Pipeline for Recovery Engine.
 *
 * Enforces REAL LLM calls through the multi-provider advisory layer in
 * lib/claude-agent.ts (Google Gemini primary, Anthropic and OpenAI as fallbacks).
 * Explicitly verifies isRealApi === true on every call, reports the provider and
 * model that actually answered, and measures exact wall-clock execution time.
 *
 * Run via: npm run demo  OR  npx tsx --tsconfig tsconfig.scripts.json scripts/run-demo.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide } from '../lib/policy-engine';
import {
  recommendAction,
  describeConfiguredProviders,
  ClaudeRecommendation,
} from '../lib/claude-agent';
import { executeAction, auditReasonSuffix } from '../lib/action-executor';
import { writeEvent, describeAdvisor, type AuditMetadata } from '../lib/audit-logger';
import { seedDatabase } from '../data/seed-transactions';

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

function bar(label: string, value: string | number, width = 34): string {
  return `  ${label.padEnd(width)} ${value}`;
}

function hr(char = '─', len = 74): string {
  return char.repeat(len);
}

async function runDemo() {
  const startTime = Date.now();

  console.log('\n' + hr('═'));
  console.log('  🚀  RECOVERY ENGINE — FULL DEMO PIPELINE');
  console.log('      (Real AI Advisory Reasoning + Deterministic Policy Engine Authority)');
  console.log(hr('═'));
  console.log(`  Execution Time : ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\n`);

  // Pre-flight check for a live AI provider. Asks the advisory layer itself which
  // providers are configured rather than re-testing env keys here, so this can
  // never disagree with what recommendAction() will actually attempt.
  const providerChain = describeConfiguredProviders();

  if (providerChain.length === 0) {
    console.error('\n' + hr('!'));
    console.error('  ❌ FATAL PRECONDITION: No AI provider key is set in .env!');
    console.error('  Real AI execution is strictly enforced.');
    console.error('  Please add GEMINI_API_KEY (primary), ANTHROPIC_API_KEY, or OPENAI_API_KEY to .env.');
    console.error(hr('!') + '\n');
    process.exit(1);
  }

  // 1. Seed Database (65 Transactions with Tiers)
  await seedDatabase();

  // 2. Load Policy Config & Determine Hour
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

  // Support hour override via CLI arg (--hour=15) or env var (EVALUATION_HOUR=15), defaulting to 15:00 IST (Daytime Compliant Window)
  const argHour =
    process.argv.find((a) => a.startsWith('--hour='))?.split('=')[1] ||
    process.env.EVALUATION_HOUR;
  let currentHour = 15;
  if (argHour !== undefined) {
    const parsed = parseInt(argHour, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 23) {
      console.error(`\n❌ Error: Invalid --hour value "${argHour}". Must be an integer between 0 and 23.`);
      process.exit(1);
    }
    currentHour = parsed;
  }

  console.log('  ⚙️  Active Policy Engine Configuration:');
  console.log(bar('• AFA 2FA Threshold', rupees(policyConfig.afaThresholdPaise)));
  console.log(bar('• VIP Max Retries', `${policyConfig.vipMaxRetries ?? 3} attempts`));
  console.log(bar('• Standard Max Retries', `${policyConfig.standardMaxRetries ?? 1} attempt`));
  console.log(bar('• Trial Max Retries', `${policyConfig.trialMaxRetries ?? 1} attempt`));
  console.log(bar('• Nudge Compliance Window', `${policyConfig.nudgeWindowStartHour}:00 – ${policyConfig.nudgeWindowEndHour}:00 IST`));
  console.log(bar('• Evaluation Hour', `${currentHour}:00 IST (Daytime Compliant Window)`));
  console.log(
    bar(
      '• AI Advisory Chain',
      providerChain.map((p, i) => `${i === 0 ? 'primary' : 'fallback'}: ${p.provider} (${p.model})`).join(' → '),
    ),
  );
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
    isRealApi: boolean;
  }> = [];

  let totalAtRiskPaise = 0;
  let totalRecoveredPaise = 0;
  let totalRecoveredCount = 0;
  let aiMatchedCount = 0;
  let aiOverriddenCount = 0;
  let aiCachedCount = 0;
  let aiDegradedCount = 0;

  // Which provider/model combinations actually answered, tallied from the live
  // responses. Reported in the summary so the run states what really served it
  // instead of asserting a provider up front.
  const observedAdvisors = new Map<string, number>();

  console.log(`  🤖 Dispatching real ${providerChain[0].provider} advisory calls for ${transactions.length} transactions...\n`);

  // Process sequentially to guarantee 100% rate-limit compliance and clean output logging
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    const globalIdx = i + 1;
    totalAtRiskPaise += tx.amountPaise;

    // Step A: Real Live AI Call with try/catch resilience
    const advisoryStart = Date.now();
    let aiRec: ClaudeRecommendation | null = null;
    let advisoryElapsed = 0;
    try {
      aiRec = await recommendAction(tx as any, policyConfig);
      advisoryElapsed = Date.now() - advisoryStart;
      if (!aiRec.isRealApi) {
        throw new Error(`Transaction ${tx.id} did not execute via real AI API!`);
      }
      if (aiRec.cached) {
        aiCachedCount++;
      }
    } catch (err: any) {
      advisoryElapsed = Date.now() - advisoryStart;
      aiDegradedCount++;
      console.warn(`    ⚠️  [AI Advisory Degraded] Transaction ${tx.id}: ${err?.message || err}. Proceeding with deterministic policy authority...`);
      aiRec = null;
    }

    // Step B: Pure Deterministic Policy Diagnosis (Authoritative)
    const policyDecision = diagnoseAndDecide(tx as any, policyConfig, currentHour);

    // Step C: Action Execution (Only Policy Engine decision is executed)
    const result = await executeAction(policyDecision, tx, 'simulate');
    // Empty on the simulate path; carries the real API error if a live call ever
    // fails here, so the executor's note can never be silently dropped.
    const executorNote = auditReasonSuffix(result);
    const txIdStr = (tx.externalPaymentId || tx.id).padEnd(24);

    // Structured facts for the ledger, so the dashboard reads columns instead of
    // parsing the reason prose. `advisoryElapsed` is already measured above, so
    // provider latency is recorded rather than estimated.
    const meta: AuditMetadata = {
      amountPaise: tx.amountPaise,
      recoveredAmountPaise: result.recoveredAmountPaise,
      simulated: result.simulated,
      ruleId: policyDecision.ruleId,
      channel: result.channel,
      messagingCostPaise: result.messagingCostPaise,
      razorpayEntityId: result.externalPaymentId ?? tx.externalPaymentId,
      providerLatencyMs: advisoryElapsed,
      aiRecommendedAction: aiRec?.recommendedAction ?? null,
      aiReasoning: aiRec?.reasoning ?? null,
      extra: {
        outcome: result.outcome,
        executionMode: 'simulate',
        currentHourIst: currentHour,
        resolvedStatus: result.persistedState?.status ?? null,
        holdReason: result.persistedState?.holdReason ?? null,
        deferredUntil: result.persistedState?.deferredUntil?.toISOString() ?? null,
        blockedByCompliance: policyDecision.blockedByCompliance,
        advisoryCached: aiRec?.cached ?? null,
      },
    };

    if (!aiRec) {
      console.log(
        `  [${String(globalIdx).padStart(2)}/${transactions.length}] ${txIdStr} | ${advisoryElapsed}ms | AI: DEGRADED (Offline) | Policy: ${policyDecision.action.padEnd(17)} | ⚙️  POLICY AUTHORITY`
      );
      await writeEvent(
        tx.id,
        'policy_engine',
        policyDecision.action,
        `AI advisory unavailable — policy engine independently enforced "${policyDecision.action}" per rule: ${policyDecision.reason}${executorNote}`,
        'advisory_unavailable',
        undefined,
        policyDecision.policyVersion,
        null,
        null,
        meta,
      );
    } else {
      const isMatch = aiRec.recommendedAction === policyDecision.action;
      const advisorKey = `${aiRec.provider} (${aiRec.model})`;
      observedAdvisors.set(advisorKey, (observedAdvisors.get(advisorKey) ?? 0) + 1);
      const advisor = describeAdvisor(aiRec.provider, aiRec.model);
      const statusTag = isMatch ? '✓ MATCH' : '⚡ OVERRIDE';
      const cacheTag = aiRec.cached ? ' [cached]' : '';

      console.log(
        `  [${String(globalIdx).padStart(2)}/${transactions.length}] ${txIdStr} | ${advisoryElapsed}ms | RealAPI: ${aiRec.isRealApi}${cacheTag} | ${aiRec.provider}: ${aiRec.recommendedAction.padEnd(17)} | Policy: ${policyDecision.action.padEnd(17)} | ${statusTag}`
      );

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
          meta,
        );
      } else {
        aiOverriddenCount++;
        await writeEvent(
          tx.id,
          'policy_engine_override',
          policyDecision.action,
          `${advisor} recommended "${aiRec.recommendedAction}" (${aiRec.reasoning}) but policy engine enforced "${policyDecision.action}" per rule: ${policyDecision.reason}${executorNote}`,
          result.outcome,
          undefined,
          policyDecision.policyVersion,
          aiRec.provider,
          aiRec.model,
          meta,
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
          isRealApi: aiRec.isRealApi,
        });
      }
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
        type: tx.type,
        amountPaise: tx.amountPaise,
        reasonCode: tx.reasonCode || 'checkout_abandonment',
        reason: policyDecision.reason,
      });
    }
  }

  // 4. Output Summary Report
  const totalTimeSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
  const observedSummary = Array.from(observedAdvisors.entries())
    .map(([advisor, count]) => `${count}× ${advisor}`)
    .join(', ');

  console.log('\n' + hr('═'));
  console.log('  📊  DEMO AGGREGATE RECOVERY RESULTS');
  console.log(hr('═'));
  console.log(bar('Total Transactions Processed', transactions.length));
  console.log(bar('Total Wall-Clock Runtime', `${totalTimeSeconds}s (live AI advisory + policy execution)`));
  console.log(bar('Total At-Risk Volume', rupees(totalAtRiskPaise)));
  console.log(bar('Total Recovered Revenue', rupees(totalRecoveredPaise)));

  const recoveryRate =
    totalAtRiskPaise > 0
      ? ((totalRecoveredPaise / totalAtRiskPaise) * 100).toFixed(1)
      : '0.0';
  console.log(bar('Aggregate Recovery Rate', `${recoveryRate}%`));
  console.log(bar('Transactions Recovered', `${totalRecoveredCount}/${transactions.length}`));

  console.log('\n' + hr('─'));
  console.log('  🤖  REAL AI REASONING & POLICY ENFORCEMENT SUMMARY');
  console.log(hr('─'));
  console.log(bar('Served By (observed, not assumed)', observedSummary || 'none'));
  const answeredCount = transactions.length - aiDegradedCount;
  const advisorySummaryStr =
    aiDegradedCount > 0
      ? `${transactions.length} evaluated (${answeredCount} AI-assisted, ${aiCachedCount} cached, ${aiDegradedCount} degraded offline), ${aiMatchedCount} matched policy, ${aiOverriddenCount} overridden by policy engine`
      : `${transactions.length} total (${aiCachedCount > 0 ? `${aiCachedCount} cached, ` : ''}100% real API calls), ${aiMatchedCount} matched policy, ${aiOverriddenCount} overridden by policy engine`;

  console.log(
    bar(
      'AI Recommendations',
      advisorySummaryStr,
    ),
  );

  // 5. Detail of Overridden Cases
  if (overriddenCases.length > 0) {
    console.log('\n  ⚡ Detailed Policy Override Log (Real AI Advisory vs Policy Engine):\n');
    for (let i = 0; i < overriddenCases.length; i++) {
      const oc = overriddenCases[i];
      console.log(`  [Override #${i + 1}] ${(oc.externalPaymentId || oc.transactionId).padEnd(26)} ${rupees(oc.amountPaise).padStart(12)}  [Tier: ${oc.customerTier.toUpperCase()}]`);
      console.log(`    • AI Wanted        : ${oc.aiAction.toUpperCase()} — via ${oc.advisor} (Real API Call ✓)`);
      console.log(`      Genuine Reasoning: "${oc.aiReasoning}"`);
      console.log(`    • Policy Enforced  : ${oc.policyAction.toUpperCase()}`);
      console.log(`      Rule Rationale   : "${oc.policyReason}"`);
      console.log(`    • Action Executed  : ${oc.executedAction.toUpperCase()} (Policy Authority Maintained ✓)`);
      console.log();
    }
  }

  // 6. Action Breakdown
  console.log(hr('─'));
  console.log('  📋  BREAKDOWN BY ACTION EXECUTED\n');

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

  // 7. Honest Exceptions
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

  console.log('\n' + hr('═'));
  console.log(`  ✅  DEMO COMPLETED IN ${totalTimeSeconds}s`);
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
