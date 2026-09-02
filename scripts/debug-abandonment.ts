/**
 * /scripts/debug-abandonment.ts
 *
 * Verifies the 4 checkout-abandonment sub-rules of the policy engine, and dumps
 * how the seeded `checkout_abandon` rows currently classify.
 *
 * The 4 sub-rules under test (Rule 8, lib/policy-engine.ts):
 *  1. Too Soon (< 1h)            -> no_action          ("too soon, avoiding premature nudge")
 *  2. In-Window Active (1-24h)   -> send_nudge         ("cart abandonment recovery nudge, within compliant window")
 *  3. Off-Window Active (1-24h)  -> no_action + blocked ("outside compliant nudge window (TRAI SMS timing rules)...")
 *  4. Expired (> 24h, or nudges spent) -> stop_unrecoverable ("abandonment recovery window expired")
 *
 * WHY A SYNTHETIC PROBE MATRIX:
 * The seeded rows age in real time. Once the seed is more than 24 hours old,
 * every row falls into sub-rule 4 and the live dataset can no longer exercise
 * sub-rules 1-3 at all. So correctness is proved against a deterministic probe
 * matrix (fixed `now`, controlled abandonedAt offsets, pure function calls, no
 * DB writes), and the seeded pass then reports which sub-rules the real data
 * happens to cover right now — rather than claiming coverage it doesn't have.
 *
 * Probes use source='customer' with a non-card, non-insufficient_funds reason
 * code so that priority rules 4-7 cannot preempt Rule 8.
 *
 * Baseline-safe: reads only, writes nothing.
 *
 * Run via: npm run test:abandonment
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide, TransactionInput, PolicyConfigInput } from '../lib/policy-engine';

function hr(char = '─', len = 75): string {
  return char.repeat(len);
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

let failures = 0;
function assert(label: string, condition: boolean, detail: string) {
  if (!condition) failures++;
  console.log(`  ${condition ? '✓ PASS' : '✗ FAIL'}  ${label.padEnd(46)} ${detail}`);
}

/** The four sub-rules, keyed so probe coverage can be tallied. */
const SUB_RULE = {
  TOO_SOON: '1. <1h -> no_action',
  IN_WINDOW: '2. 1-24h in-window -> send_nudge',
  OFF_WINDOW: '3. 1-24h off-window -> no_action (blocked)',
  EXPIRED: '4. expired -> stop_unrecoverable',
} as const;

type SubRule = (typeof SUB_RULE)[keyof typeof SUB_RULE];

/** A fixed anchor instant so probe outcomes never drift with wall-clock time. */
const ANCHOR = new Date('2026-06-15T09:30:00.000Z');

function probeTx(hoursAgo: number, nudgeCount = 0): TransactionInput {
  return {
    id: `probe_${hoursAgo}h_n${nudgeCount}`,
    status: 'pending',
    reasonCode: '', // not a card code, not insufficient_funds -> rules 6/7 stay out
    type: 'checkout_abandon',
    amountPaise: 249900,
    source: 'customer', // not gateway/razorpay -> rules 4/5 stay out
    retryCount: 0,
    nudgeCount,
    customerTier: 'standard',
    abandonedAt: new Date(ANCHOR.getTime() - hoursAgo * 60 * 60 * 1000),
  };
}

async function main() {
  console.log('\n' + hr('═'));
  console.log('  🛒  CHECKOUT ABANDONMENT: SUB-RULE VERIFICATION & DEBUG DUMP');
  console.log(hr('═'));

  const policyConfig: PolicyConfigInput = (await prisma.policyConfig.findFirst()) ?? {
    afaThresholdPaise: 1500000,
    maxRetries: 1,
    maxNudges: 2,
    nudgeWindowStartHour: 10,
    nudgeWindowEndHour: 21,
  };

  const { nudgeWindowStartHour: winStart, nudgeWindowEndHour: winEnd, maxNudges } = policyConfig;

  // ── PART 1: Deterministic synthetic probe matrix ───────────────────────────
  console.log('\n' + hr('─'));
  console.log('  🧪 PART 1: DETERMINISTIC SUB-RULE PROBES (pure function, no DB writes)');
  console.log(hr('─'));
  console.log(`  Anchor time: ${ANCHOR.toISOString()}   Nudge window: ${winStart}:00–${winEnd}:00 IST\n`);

  const probes: Array<{
    label: string;
    hoursAgo: number;
    hour: number;
    nudgeCount?: number;
    subRule: SubRule;
    action: string;
    reason: string;
    blocked: boolean;
  }> = [
    // Sub-rule 1 — premature.
    { label: 'abandoned 30 min ago', hoursAgo: 0.5, hour: 15, subRule: SUB_RULE.TOO_SOON, action: 'no_action', reason: 'too soon, avoiding premature nudge', blocked: false },
    { label: 'abandoned 59 min ago', hoursAgo: 0.98, hour: 15, subRule: SUB_RULE.TOO_SOON, action: 'no_action', reason: 'too soon, avoiding premature nudge', blocked: false },

    // Sub-rule 2 — active and inside the compliant window.
    { label: 'active 5h, hour 15 (midday)', hoursAgo: 5, hour: 15, subRule: SUB_RULE.IN_WINDOW, action: 'send_nudge', reason: 'cart abandonment recovery nudge, within compliant window', blocked: false },
    { label: `active 5h, hour ${winStart} (window opens)`, hoursAgo: 5, hour: winStart, subRule: SUB_RULE.IN_WINDOW, action: 'send_nudge', reason: 'cart abandonment recovery nudge, within compliant window', blocked: false },
    { label: `active 5h, hour ${winEnd - 1} (last legal hour)`, hoursAgo: 5, hour: winEnd - 1, subRule: SUB_RULE.IN_WINDOW, action: 'send_nudge', reason: 'cart abandonment recovery nudge, within compliant window', blocked: false },
    { label: 'boundary: exactly 1h old', hoursAgo: 1, hour: 15, subRule: SUB_RULE.IN_WINDOW, action: 'send_nudge', reason: 'cart abandonment recovery nudge, within compliant window', blocked: false },
    { label: 'boundary: exactly 24h old', hoursAgo: 24, hour: 15, subRule: SUB_RULE.IN_WINDOW, action: 'send_nudge', reason: 'cart abandonment recovery nudge, within compliant window', blocked: false },

    // Sub-rule 3 — active but outside TRAI SMS hours; must defer, not send.
    { label: 'active 5h, hour 23 (night)', hoursAgo: 5, hour: 23, subRule: SUB_RULE.OFF_WINDOW, action: 'no_action', reason: 'outside compliant nudge window (TRAI SMS timing rules), deferred to next window', blocked: true },
    { label: `active 5h, hour ${winStart - 1} (before open)`, hoursAgo: 5, hour: winStart - 1, subRule: SUB_RULE.OFF_WINDOW, action: 'no_action', reason: 'outside compliant nudge window (TRAI SMS timing rules), deferred to next window', blocked: true },
    { label: `active 5h, hour ${winEnd} (window shuts)`, hoursAgo: 5, hour: winEnd, subRule: SUB_RULE.OFF_WINDOW, action: 'no_action', reason: 'outside compliant nudge window (TRAI SMS timing rules), deferred to next window', blocked: true },

    // Sub-rule 4 — expired by age, or by exhausted nudges inside the window.
    { label: 'expired: 30h old', hoursAgo: 30, hour: 15, subRule: SUB_RULE.EXPIRED, action: 'stop_unrecoverable', reason: 'abandonment recovery window expired', blocked: false },
    { label: 'boundary: 24.5h old', hoursAgo: 24.5, hour: 15, subRule: SUB_RULE.EXPIRED, action: 'stop_unrecoverable', reason: 'abandonment recovery window expired', blocked: false },
    { label: `active 5h but ${maxNudges} nudges spent`, hoursAgo: 5, hour: 15, nudgeCount: maxNudges, subRule: SUB_RULE.EXPIRED, action: 'stop_unrecoverable', reason: 'abandonment recovery window expired', blocked: false },
    { label: 'expired 30h even off-window', hoursAgo: 30, hour: 23, subRule: SUB_RULE.EXPIRED, action: 'stop_unrecoverable', reason: 'abandonment recovery window expired', blocked: false },
  ];

  const covered = new Set<SubRule>();

  for (const p of probes) {
    const decision = diagnoseAndDecide(probeTx(p.hoursAgo, p.nudgeCount ?? 0), policyConfig, p.hour, ANCHOR);
    const ok =
      decision.action === p.action &&
      decision.reason === p.reason &&
      decision.blockedByCompliance === p.blocked;

    if (ok) covered.add(p.subRule);
    assert(
      p.label,
      ok,
      ok
        ? `${decision.action}${decision.blockedByCompliance ? ' (blocked)' : ''}`
        : `got ${decision.action}/blocked=${decision.blockedByCompliance} "${decision.reason}"`,
    );
  }

  // The point of the matrix is that all four sub-rules are genuinely reachable.
  console.log();
  assert('all 4 sub-rules exercised by probes', covered.size === 4, `${covered.size}/4 sub-rules`);
  for (const rule of Object.values(SUB_RULE)) {
    if (!covered.has(rule)) console.log(`         ↳ NOT covered: ${rule}`);
  }

  // ── PART 2: How the seeded rows classify right now ─────────────────────────
  console.log('\n' + hr('─'));
  console.log('  📍 PART 2: SEEDED DATASET CLASSIFICATION (real rows, real ages)');
  console.log(hr('─'));

  const abandonTxs = await prisma.transaction.findMany({
    where: { type: 'checkout_abandon' },
    orderBy: { createdAt: 'desc' },
  });

  // An empty dataset is a failure, not a reason to exit 0 quietly.
  assert('seeded checkout_abandon rows exist', abandonTxs.length > 0, `${abandonTxs.length} rows`);

  if (abandonTxs.length > 0) {
    const now = new Date();
    console.log(`\n  Evaluating ${abandonTxs.length} rows at ${now.toISOString()} (hour 15 and hour 23):\n`);

    const seedCoverage = new Set<SubRule>();
    let classified = 0;

    for (let i = 0; i < abandonTxs.length; i++) {
      const tx = abandonTxs[i];
      const abandonDate = tx.abandonedAt ?? tx.createdAt;
      const elapsedHours = (now.getTime() - new Date(abandonDate).getTime()) / (1000 * 60 * 60);

      // Evaluate as if freshly abandoned state-wise, so age is the only variable.
      const freshTx = { ...tx, status: 'pending', recovered: false, nudgeCount: 0 };
      const day = diagnoseAndDecide(freshTx, policyConfig, 15, now);
      const night = diagnoseAndDecide(freshTx, policyConfig, 23, now);

      // Age determines which sub-rule this row must land on.
      let expectedDay: { action: string; blocked: boolean; rule: SubRule };
      let expectedNight: { action: string; blocked: boolean; rule: SubRule };
      if (elapsedHours < 1) {
        expectedDay = { action: 'no_action', blocked: false, rule: SUB_RULE.TOO_SOON };
        expectedNight = { action: 'no_action', blocked: false, rule: SUB_RULE.TOO_SOON };
      } else if (elapsedHours <= 24) {
        expectedDay = { action: 'send_nudge', blocked: false, rule: SUB_RULE.IN_WINDOW };
        expectedNight = { action: 'no_action', blocked: true, rule: SUB_RULE.OFF_WINDOW };
      } else {
        expectedDay = { action: 'stop_unrecoverable', blocked: false, rule: SUB_RULE.EXPIRED };
        expectedNight = { action: 'stop_unrecoverable', blocked: false, rule: SUB_RULE.EXPIRED };
      }

      const ok =
        day.action === expectedDay.action &&
        day.blockedByCompliance === expectedDay.blocked &&
        night.action === expectedNight.action &&
        night.blockedByCompliance === expectedNight.blocked;

      if (ok) {
        classified++;
        seedCoverage.add(expectedDay.rule);
        seedCoverage.add(expectedNight.rule);
      }

      console.log(`  [#${String(i + 1).padStart(2)}] ${(tx.externalPaymentId || tx.id).padEnd(24)} ${rupees(tx.amountPaise).padStart(12)}  ${elapsedHours.toFixed(1)}h old`);
      console.log(`       hour 15 -> ${day.action.padEnd(19)} blocked=${String(day.blockedByCompliance).padEnd(5)} "${day.reason}"`);
      console.log(`       hour 23 -> ${night.action.padEnd(19)} blocked=${String(night.blockedByCompliance).padEnd(5)} "${night.reason}"`);
      console.log(`       ${ok ? '✓' : '✗'} matches expected sub-rule for its age: ${expectedDay.rule}`);
      console.log();
    }

    assert('every seeded row lands on its age sub-rule', classified === abandonTxs.length, `${classified}/${abandonTxs.length}`);

    // Honest coverage statement. The seed ages, so this shrinks over time —
    // report what it actually reaches instead of implying full coverage.
    console.log('\n  Sub-rules the CURRENT seeded data reaches on its own:');
    for (const rule of Object.values(SUB_RULE)) {
      console.log(`    ${seedCoverage.has(rule) ? '✓ reached' : '· not reached (seed too old)'}  ${rule}`);
    }
    if (seedCoverage.size < 4) {
      console.log(`\n  ℹ️  ${4 - seedCoverage.size} sub-rule(s) are unreachable from the aged seed — they are`);
      console.log('     covered by the Part 1 probe matrix above. Re-run `npm run seed` for');
      console.log('     fresh 1-24h carts if you want the live dataset to exercise them too.');
    }
  }

  console.log('\n' + hr('═'));
  if (failures === 0) {
    console.log('  ✅ ABANDONMENT SUB-RULES: PASS');
    console.log('     All 4 sub-rules verified against deterministic probes; every seeded row');
    console.log('     classified as its age dictates.');
  } else {
    console.log(`  ❌ ABANDONMENT SUB-RULES: FAIL — ${failures} assertion(s) failed.`);
  }
  console.log(hr('═') + '\n');
  if (failures > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
