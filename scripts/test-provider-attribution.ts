/**
 * /scripts/test-provider-attribution.ts
 *
 * Verifies AI provider attribution is RESOLVED AT RUNTIME, never hardcoded (P5).
 *
 * Three things are asserted:
 *   1. describeConfiguredProviders() reports the real configured chain, in the
 *      same precedence recommendAction() uses, and honours GEMINI_MODEL /
 *      ANTHROPIC_MODEL / OPENAI_MODEL overrides — proving no literal provider
 *      name or model id is baked into the reporting path.
 *   2. describeAdvisor() renders honest ledger prose for every provider and
 *      degrades to a bare 'AI' rather than inventing attribution.
 *   3. An audit row written with a live recommendation's provider/model persists
 *      both columns AND names the provider in the reason text, while remaining
 *      parseable by the dashboard's override-signal regexes.
 *
 * Baseline-safe: operates on a throwaway transaction it creates and deletes itself.
 *
 * Run via: npm run test:provider-attribution
 */

import 'dotenv/config';
import {
  describeConfiguredProviders,
  PROVIDER_GEMINI,
  PROVIDER_ANTHROPIC,
  PROVIDER_OPENAI,
} from '../lib/claude-agent';
import { writeEvent, describeAdvisor } from '../lib/audit-logger';
import { prisma } from '../lib/prisma';

function hr(char = '─', len = 74) {
  return char.repeat(len);
}

let failures = 0;
function assert(label: string, condition: boolean, detail: string) {
  if (!condition) failures++;
  console.log(`  ${condition ? '✓ PASS' : '✗ FAIL'}  ${label.padEnd(48)} ${detail}`);
}

/** Mirrors app/dashboard/page.tsx policySignal() so ledger prose stays UI-parseable. */
function policySignal(reason: string, action: string) {
  return {
    ai: reason.match(/recommended [“"]([^”"]+)[”"]/)?.[1] ?? 'recommendation',
    enforced: reason.match(/policy engine enforced [“"]([^”"]+)[”"]/)?.[1] ?? action,
  };
}

/** Runs fn with env vars temporarily replaced, restoring them afterwards. */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function run() {
  console.log('\n' + hr('═'));
  console.log('  🧪  AI PROVIDER ATTRIBUTION TEST (P5)');
  console.log(hr('═'));

  // ── 1. Provider chain is read from the environment, not hardcoded ─────────
  console.log('\n' + hr('─'));
  console.log('  1. CONFIGURED CHAIN RESOLUTION');
  console.log(hr('─'));

  const liveChain = describeConfiguredProviders();
  console.log(`  Live chain: ${liveChain.map((p) => `${p.provider} (${p.model})`).join(' → ') || 'none'}`);
  console.log();

  assert('a provider is configured in .env', liveChain.length > 0, `${liveChain.length} provider(s)`);
  assert('Gemini is the primary provider', liveChain[0]?.provider === PROVIDER_GEMINI, `first = ${liveChain[0]?.provider}`);

  // A custom GEMINI_MODEL must flow straight through. If a literal were baked
  // into the reporting path this assertion is what would catch it.
  const custom = withEnv({ GEMINI_MODEL: 'gemini-probe-9.9-custom' }, describeConfiguredProviders);
  assert('GEMINI_MODEL override is honoured', custom[0]?.model === 'gemini-probe-9.9-custom', `${custom[0]?.model}`);

  // GOOGLE_API_KEY alone must count as configured (recommendAction accepts it).
  const googleOnly = withEnv(
    { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: 'probe-key', ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined },
    describeConfiguredProviders,
  );
  assert('GOOGLE_API_KEY alone resolves Gemini', googleOnly.length === 1 && googleOnly[0].provider === PROVIDER_GEMINI, `${googleOnly.length} provider(s)`);

  // Placeholder keys must NOT be treated as configured, for ANY provider. An
  // unsubstituted .env.example value that registers as a provider makes
  // pre-flight pass and then fails every call with a misleading network error.
  const placeholder = withEnv(
    { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, ANTHROPIC_API_KEY: 'sk-ant-your_key_here', OPENAI_API_KEY: undefined },
    describeConfiguredProviders,
  );
  assert('placeholder ANTHROPIC_API_KEY is ignored', placeholder.length === 0, `${placeholder.length} provider(s)`);

  const geminiPlaceholder = withEnv(
    { GEMINI_API_KEY: 'your_gemini_api_key_here', GOOGLE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined },
    describeConfiguredProviders,
  );
  assert('placeholder GEMINI_API_KEY is ignored', geminiPlaceholder.length === 0, `${geminiPlaceholder.length} provider(s)`);

  const googlePlaceholder = withEnv(
    { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: 'your_gemini_api_key_here', ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined },
    describeConfiguredProviders,
  );
  assert('placeholder GOOGLE_API_KEY is ignored', googlePlaceholder.length === 0, `${googlePlaceholder.length} provider(s)`);

  const openaiPlaceholder = withEnv(
    { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: 'sk-your_openai_key_here' },
    describeConfiguredProviders,
  );
  assert('placeholder OPENAI_API_KEY is ignored', openaiPlaceholder.length === 0, `${openaiPlaceholder.length} provider(s)`);

  // A whole .env.example copied verbatim must report zero providers, so the
  // pre-flight failure names the real problem.
  const allPlaceholders = withEnv(
    { GEMINI_API_KEY: 'your_gemini_api_key_here', GOOGLE_API_KEY: undefined, ANTHROPIC_API_KEY: 'sk-ant-your_key_here', OPENAI_API_KEY: 'sk-your_openai_key_here' },
    describeConfiguredProviders,
  );
  assert('unedited .env.example configures nothing', allPlaceholders.length === 0, `${allPlaceholders.length} provider(s)`);

  const blankKey = withEnv(
    { GEMINI_API_KEY: '   ', GOOGLE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined },
    describeConfiguredProviders,
  );
  assert('whitespace-only key is ignored', blankKey.length === 0, `${blankKey.length} provider(s)`);

  // Full precedence order: Gemini → Anthropic → OpenAI.
  const allThree = withEnv(
    { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_MODEL: undefined, ANTHROPIC_MODEL: undefined, OPENAI_MODEL: undefined },
    describeConfiguredProviders,
  );
  assert(
    'precedence is Gemini → Anthropic → OpenAI',
    allThree.map((p) => p.provider).join(',') === [PROVIDER_GEMINI, PROVIDER_ANTHROPIC, PROVIDER_OPENAI].join(','),
    allThree.map((p) => p.provider).join(' → '),
  );

  const noKeys = withEnv(
    { GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined },
    describeConfiguredProviders,
  );
  assert('total outage reports an empty chain', noKeys.length === 0, `${noKeys.length} provider(s)`);

  // ── 2. Ledger prose names whoever actually answered ───────────────────────
  console.log('\n' + hr('─'));
  console.log('  2. LEDGER ATTRIBUTION PROSE');
  console.log(hr('─'));

  assert('Gemini attribution', describeAdvisor(PROVIDER_GEMINI, 'gemini-3.5-flash-lite') === 'AI (Google Gemini · gemini-3.5-flash-lite)', describeAdvisor(PROVIDER_GEMINI, 'gemini-3.5-flash-lite'));
  assert('Anthropic fallback attribution', describeAdvisor(PROVIDER_ANTHROPIC, 'claude-3-5-haiku-latest') === 'AI (Anthropic Claude · claude-3-5-haiku-latest)', describeAdvisor(PROVIDER_ANTHROPIC, 'claude-3-5-haiku-latest'));
  assert('OpenAI fallback attribution', describeAdvisor(PROVIDER_OPENAI, 'gpt-4o-mini') === 'AI (OpenAI GPT · gpt-4o-mini)', describeAdvisor(PROVIDER_OPENAI, 'gpt-4o-mini'));
  assert('no provider invents nothing', describeAdvisor(null, null) === 'AI', describeAdvisor(null, null));
  assert('provider without model still attributes', describeAdvisor(PROVIDER_GEMINI, null) === 'AI (Google Gemini)', describeAdvisor(PROVIDER_GEMINI, null));

  // ── 3. Persistence + dashboard parseability ───────────────────────────────
  console.log('\n' + hr('─'));
  console.log('  3. AUDIT ROW PERSISTENCE & UI PARSEABILITY');
  console.log(hr('─'));

  const throwaway = await prisma.transaction.create({
    data: {
      externalPaymentId: `pay_test_attribution_${Date.now()}`,
      amountPaise: 49900,
      status: 'failed',
      reasonCode: 'payment_timed_out',
      source: 'gateway',
      type: 'payment',
      customerId: 'cust_test_attribution',
      customerTier: 'standard',
      retryCount: 0,
      nudgeCount: 0,
      recovered: false,
      expectedRecoveryOutcome: 'recovers_on_retry',
      simulatedRecoveryAmountPaise: 49900,
      isDemoArtifact: true,
    },
  });

  try {
    // Stand in for a live recommendation. The point under test is the write path:
    // whatever provider/model the advisory layer reports must reach both the
    // dedicated columns and the human-readable reason.
    const rec = { provider: PROVIDER_GEMINI, model: 'gemini-3.5-flash-lite', recommendedAction: 'send_nudge', reasoning: 'Standard tier, single decline, nudge is proportionate.' };
    const advisor = describeAdvisor(rec.provider, rec.model);

    const overrideRow = await writeEvent(
      throwaway.id,
      'policy_engine_override',
      'override',
      `${advisor} recommended "${rec.recommendedAction}" (${rec.reasoning}) but policy engine enforced "auto_retry" per rule: transient gateway error, auto-retry within limit`,
      'ai_recommendation_overridden',
      undefined,
      'v1',
      rec.provider,
      rec.model,
      {
        ruleId: 'R5_TRANSIENT_RETRY',
        aiRecommendedAction: rec.recommendedAction,
        aiReasoning: rec.reasoning,
        amountPaise: 49900,
      },
    );

    assert('provider column persisted', overrideRow?.provider === PROVIDER_GEMINI, `${overrideRow?.provider}`);
    assert('model column persisted', overrideRow?.model === 'gemini-3.5-flash-lite', `${overrideRow?.model}`);
    assert('reason names the real provider', overrideRow?.reason.includes(PROVIDER_GEMINI) === true, 'provider present in prose');
    assert('reason names the real model', overrideRow?.reason.includes('gemini-3.5-flash-lite') === true, 'model present in prose');
    assert('reason claims no other provider', !/anthropic|openai/i.test(overrideRow?.reason ?? ''), 'no cross-provider claim');

    // The structured route: what the dashboard reads now. Asserted alongside the
    // regex below so the prose-parsing fallback can be retired without losing
    // coverage of the advisory-vs-policy distinction it was extracting.
    const structured = await prisma.auditLog.findFirst({ where: { transactionId: throwaway.id } });
    assert(
      'aiRecommendedAction column persisted',
      structured?.aiRecommendedAction === 'send_nudge',
      `${structured?.aiRecommendedAction}`,
    );
    assert(
      'enforced action readable from the action column',
      structured?.action === 'override' && structured?.actor === 'policy_engine_override',
      `${structured?.actor}/${structured?.action}`,
    );
    assert('ruleId column persisted', structured?.ruleId === 'R5_TRANSIENT_RETRY', `${structured?.ruleId}`);
    assert('aiReasoning column persisted', structured?.aiReasoning === rec.reasoning, 'reasoning stored verbatim');

    const signal = policySignal(overrideRow?.reason ?? '', overrideRow?.action ?? '');
    assert('dashboard still extracts AI action', signal.ai === 'send_nudge', `ai="${signal.ai}"`);
    assert('dashboard still extracts enforced action', signal.enforced === 'auto_retry', `enforced="${signal.enforced}"`);

    // Re-read through the API's own query shape to prove the columns survive the trip.
    const reread = await prisma.auditLog.findFirst({ where: { transactionId: throwaway.id } });
    assert('columns survive a fresh read', reread?.provider === PROVIDER_GEMINI && reread?.model === 'gemini-3.5-flash-lite', `${reread?.provider} / ${reread?.model}`);

    console.log('\n  Reason as persisted:');
    console.log(`    ${overrideRow?.reason}`);
  } finally {
    await prisma.auditLog.deleteMany({ where: { transactionId: throwaway.id } });
    await prisma.transaction.delete({ where: { id: throwaway.id } }).catch(() => {});
    console.log('\n  🧹 Cleanup: throwaway transaction and its audit rows deleted.');
  }

  console.log('\n' + hr('─'));
  console.log('  SCOPE NOTE');
  console.log(hr('─'));
  console.log('  The live match/override branches of /api/demo-trigger reach a real provider');
  console.log('  over the network, so they are exercised by `npm run demo`, not here. The');
  console.log('  degraded (no-provider) branch is covered by `npm run test:advisory-unavailable`,');
  console.log('  which asserts provider/model stay NULL rather than being guessed.');

  console.log('\n' + hr('═'));
  if (failures === 0) {
    console.log('  ✅ TEST RESULT: PASS — provider attribution is resolved at runtime, never hardcoded.');
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
