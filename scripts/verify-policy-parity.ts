/**
 * /scripts/verify-policy-parity.ts
 *
 * Differential check for the ruleId/holdReason/resumeAtHour additions to
 * lib/policy-engine.ts.
 *
 * The refactor touched all 19 return sites in the engine, which is exactly the
 * kind of edit that quietly reorders a branch. So rather than trusting review,
 * this runs the PRE-EDIT engine (extracted from git HEAD) and the current engine
 * over every transaction in the database × all 24 hours × a spread of clock
 * offsets, and asserts the five pre-existing fields are identical every time.
 *
 * The new fields are checked for internal consistency instead: a hold reason
 * appears exactly on the decisions that suppress an action, and never on one
 * that resolves it.
 *
 * Usage: node --import tsx scripts/verify-policy-parity.ts <path-to-old-engine.ts>
 * (TSX_TSCONFIG_PATH=tsconfig.scripts.json)
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide as newEngine, type PolicyDecision } from '../lib/policy-engine';

const oldEnginePath = process.argv[2];
if (!oldEnginePath) {
  console.error('✗ Pass the path to the pre-edit policy-engine.ts as argv[2].');
  process.exit(1);
}

/** Actions that leave the transaction parked rather than resolved. */
const SUPPRESSING_ACTIONS = new Set(['no_action']);

async function main() {
  const { diagnoseAndDecide: oldEngine } = await import(oldEnginePath);

  const policyConfig = await prisma.policyConfig.findFirst();
  if (!policyConfig) throw new Error('No PolicyConfig row — run the seed first.');

  const transactions = await prisma.transaction.findMany();
  console.log(`  Corpus: ${transactions.length} transactions × 24 hours × 3 clock offsets`);

  // Three reference instants so Rule 8's elapsed-time branches (<1h, 1–24h, >24h)
  // are all exercised against real abandonedAt values instead of only "now".
  const offsets = [0, 3 * 60 * 60 * 1000, 30 * 60 * 60 * 1000];

  let compared = 0;
  const mismatches: string[] = [];
  const holdViolations: string[] = [];
  const ruleIdCounts = new Map<string, number>();

  for (const tx of transactions) {
    const input = {
      id: tx.id,
      status: tx.status,
      reasonCode: tx.reasonCode,
      type: tx.type,
      amountPaise: tx.amountPaise,
      source: tx.source,
      retryCount: tx.retryCount,
      nudgeCount: tx.nudgeCount,
      customerTier: tx.customerTier,
      abandonedAt: tx.abandonedAt,
      createdAt: tx.createdAt,
    };

    for (const offset of offsets) {
      const now = new Date(Date.now() + offset);
      for (let hour = 0; hour < 24; hour++) {
        const before = oldEngine(input, policyConfig, hour, now);
        const after: PolicyDecision = newEngine(input, policyConfig, hour, now);
        compared++;

        // 1. The five pre-existing fields must be untouched.
        for (const field of [
          'action',
          'requiresApproval',
          'blockedByCompliance',
          'reason',
          'policyVersion',
        ] as const) {
          if (before[field] !== after[field]) {
            mismatches.push(
              `${tx.externalPaymentId ?? tx.id} h=${hour} off=${offset}: ${field} ` +
                `${JSON.stringify(before[field])} → ${JSON.stringify(after[field])}`,
            );
          }
        }

        // 2. New fields must be internally consistent.
        if (!after.ruleId) {
          holdViolations.push(`${tx.id} h=${hour}: missing ruleId`);
        }
        ruleIdCounts.set(after.ruleId, (ruleIdCounts.get(after.ruleId) ?? 0) + 1);

        const suppresses = SUPPRESSING_ACTIONS.has(after.action);
        const isAlreadyResolved = after.ruleId === 'R1_ALREADY_RESOLVED';
        if (suppresses && !isAlreadyResolved && after.holdReason === null) {
          holdViolations.push(
            `${tx.id} h=${hour}: ${after.action} via ${after.ruleId} parks the txn but names no holdReason`,
          );
        }
        if (!suppresses && after.holdReason !== null) {
          holdViolations.push(
            `${tx.id} h=${hour}: ${after.action} resolves but carries holdReason=${after.holdReason}`,
          );
        }
        if (after.blockedByCompliance && after.action === 'no_action') {
          if (after.holdReason !== 'trai_window_closed') {
            holdViolations.push(
              `${tx.id} h=${hour}: compliance hold ${after.ruleId} has holdReason=${after.holdReason}`,
            );
          }
          if (after.resumeAtHour !== policyConfig.nudgeWindowStartHour) {
            holdViolations.push(
              `${tx.id} h=${hour}: TRAI hold resumeAtHour=${after.resumeAtHour}, ` +
                `expected ${policyConfig.nudgeWindowStartHour}`,
            );
          }
        }
        if (after.resumeAtHour !== null && after.holdReason === null) {
          holdViolations.push(`${tx.id} h=${hour}: resumeAtHour set with no holdReason`);
        }
      }
    }
  }

  console.log(`\n  Rule coverage (${ruleIdCounts.size} distinct rule branches exercised):`);
  for (const [ruleId, count] of [...ruleIdCounts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ruleId.padEnd(28)} ${count}`);
  }

  console.log(`\n  ${compared} decision pairs compared.`);

  if (mismatches.length > 0) {
    console.log(`\n  ❌ BEHAVIOUR CHANGED in ${mismatches.length} case(s):`);
    for (const m of mismatches.slice(0, 20)) console.log(`    • ${m}`);
    if (mismatches.length > 20) console.log(`    … ${mismatches.length - 20} more`);
  } else {
    console.log('  ✅ PARITY: every pre-existing decision field is identical to HEAD.');
  }

  if (holdViolations.length > 0) {
    console.log(`\n  ❌ HOLD METADATA INCONSISTENT in ${holdViolations.length} case(s):`);
    for (const v of holdViolations.slice(0, 20)) console.log(`    • ${v}`);
  } else {
    console.log('  ✅ HOLD METADATA: holdReason/resumeAtHour set exactly on parked decisions.');
  }

  await prisma.$disconnect();
  if (mismatches.length > 0 || holdViolations.length > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
