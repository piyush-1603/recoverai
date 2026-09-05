/**
 * /scripts/test-p2p-watchdog.ts
 *
 * Covers the Promise-to-Pay expiry watchdog.
 *
 * Before it existed, a collection attempt that failed at the promised time
 * escalated instantly and wrote `failed_escalated` — no grace period, and
 * `brokenAt`/`escalationLevel` were never populated, so a customer default and a
 * human notification were indistinguishable in the data. These assertions pin the
 * new behaviour:
 *
 *   1. A promise inside its grace period stays open (`processing`), not escalated.
 *   2. A promise past its grace period becomes `broken` (brokenAt set, resolvedAt
 *      still null — it is open receivable) and is then escalated with level 1.
 *   3. `markP2PBroken` is idempotent and refuses to reopen a settled promise.
 *   4. A confirmed payment completes the promise instead of breaking it.
 *   5. `processDueP2Ps` reports reminders, collections and breaches separately,
 *      and never double-processes a row.
 *
 * Every record is created and deleted by this script, and none of them touch the
 * Transaction table, so the frozen 65-scenario benchmark cannot be affected.
 *
 * Run via: npm run test:p2p-watchdog
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import {
  createP2P,
  triggerP2PCollection,
  markP2PBroken,
  escalateP2PToHumanAR,
  completeP2P,
  cancelP2P,
  processDueP2Ps,
  getP2PAuditLog,
  p2pBreachDeadline,
  P2P_GRACE_PERIOD_MINUTES,
} from '../lib/p2p-engine';

const MINUTE_MS = 60 * 1000;
const RUN = Date.now();
const createdIds: string[] = [];

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS  ${label.padEnd(58)} ${detail}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label.padEnd(58)} ${detail}`);
  }
}

function hr(char = '─', len = 84) {
  return char.repeat(len);
}

/**
 * Creates a promise whose payment time is already in the past.
 *
 * `createP2P` rightly refuses a past promisedPaymentTime, so the record is created
 * in the future and then backdated — the same thing the clock does in production,
 * without waiting for it.
 */
async function makeOverdueP2P(opts: {
  key: string;
  minutesOverdue: number;
  status?: string;
  reminderSent?: boolean;
  paymentLinkId?: string | null;
}) {
  const record = await createP2P({
    customerId: `cust_p2p_wd_${opts.key}_${RUN}`,
    amountPaise: 249900,
    promisedPaymentTime: new Date(Date.now() + 60 * MINUTE_MS).toISOString(),
  });
  createdIds.push(record.id);

  return prisma.promiseToPay.update({
    where: { id: record.id },
    data: {
      promisedPaymentTime: new Date(Date.now() - opts.minutesOverdue * MINUTE_MS),
      status: opts.status ?? 'reminder_sent',
      reminderSentAt: opts.reminderSent === false ? null : new Date(Date.now() - 90 * MINUTE_MS),
      // A simulated link id: `isPaymentLinkPaid` treats it as unknowable rather
      // than calling Razorpay, which keeps this suite offline and deterministic.
      paymentLinkId: opts.paymentLinkId ?? `plink_sim_${record.id}`,
      paymentLinkUrl: `https://rzp.io/i/p2p_${record.id}_simulated`,
    },
  });
}

async function actions(p2pId: string) {
  const events = await getP2PAuditLog(p2pId);
  return events.map((e) => e.action);
}

async function run() {
  console.log('\n' + hr('═'));
  console.log('  🧪  TEST: PROMISE-TO-PAY EXPIRY WATCHDOG');
  console.log(hr('═') + '\n');

  // ── 0. The grace deadline is the promised time plus the grace period ───────
  console.log('  [0] Breach deadline arithmetic\n');
  {
    const promised = new Date('2026-09-05T12:00:00.000Z');
    const deadline = p2pBreachDeadline(promised);
    assert(
      `deadline = promised + ${P2P_GRACE_PERIOD_MINUTES}min`,
      deadline.getTime() - promised.getTime() === P2P_GRACE_PERIOD_MINUTES * MINUTE_MS,
      deadline.toISOString(),
    );
    assert('grace period is non-zero', P2P_GRACE_PERIOD_MINUTES > 0, `${P2P_GRACE_PERIOD_MINUTES}min`);
  }

  // ── 1. Inside the grace period: late, not broken ───────────────────────────
  console.log('\n  [1] Collection unconfirmed while still inside the grace period\n');
  {
    const p2p = await makeOverdueP2P({ key: 'grace', minutesOverdue: 5 });
    const after = await triggerP2PCollection(p2p.id, { paymentConfirmed: false });
    const log = await actions(p2p.id);

    assert('status stays processing', after.status === 'processing', `status=${after.status}`);
    assert('NOT escalated', after.status !== 'failed_escalated' && after.crmTaskId === null, `crm=${after.crmTaskId}`);
    assert('not yet broken', after.brokenAt === null, `brokenAt=${after.brokenAt}`);
    assert('escalationLevel still 0', after.escalationLevel === 0, `${after.escalationLevel}`);
    assert('resolvedAt still null — money is still owed', after.resolvedAt === null);
    assert(
      'ledger records the open grace period',
      log.includes('p2p_collection_unconfirmed'),
      log.join(' → '),
    );
    assert(
      'failureReason names the deadline',
      Boolean(after.failureReason?.includes('Grace period runs to')),
      `${after.failureReason?.slice(0, 60)}…`,
    );
  }

  // ── 2. Past the grace period: broken, then escalated ──────────────────────
  console.log('\n  [2] Watchdog sweep on a promise past its grace period\n');
  {
    const p2p = await makeOverdueP2P({
      key: 'breach',
      minutesOverdue: P2P_GRACE_PERIOD_MINUTES + 15,
      status: 'processing',
    });

    const summary = await processDueP2Ps();
    const after = await prisma.promiseToPay.findUniqueOrThrow({ where: { id: p2p.id } });
    const log = await actions(p2p.id);

    assert('counted as a breach, not a collection', summary.breachesProcessed >= 1, `${summary.breachesProcessed}`);
    assert('status → failed_escalated', after.status === 'failed_escalated', `status=${after.status}`);
    assert('brokenAt recorded', after.brokenAt !== null, `${after.brokenAt?.toISOString()}`);
    assert('escalationLevel = 1', after.escalationLevel === 1, `${after.escalationLevel}`);
    assert('CRM ticket opened', Boolean(after.crmTaskId), `${after.crmTaskId}`);
    assert(
      'p2p_broken logged BEFORE p2p_escalated',
      log.indexOf('p2p_broken') !== -1 &&
        log.indexOf('p2p_broken') < log.indexOf('p2p_escalated'),
      log.join(' → '),
    );
    assert(
      'breach reason states how late the payment was',
      Boolean(after.failureReason?.includes('minutes past the promised time')),
      `${after.failureReason}`,
    );
  }

  // ── 3. markP2PBroken never reopens a settled promise ──────────────────────
  console.log('\n  [3] Idempotency and terminal-state protection\n');
  {
    const done = await makeOverdueP2P({ key: 'done', minutesOverdue: 120 });
    await completeP2P(done.id, `pay_p2p_wd_done_${RUN}`);
    const afterBreakAttempt = await markP2PBroken(done.id, 'watchdog should not touch this');
    assert(
      'a completed promise cannot be broken',
      afterBreakAttempt.status === 'completed',
      `status=${afterBreakAttempt.status}`,
    );
    assert('completed promise keeps brokenAt null', afterBreakAttempt.brokenAt === null);

    const cancelled = await makeOverdueP2P({ key: 'cancel', minutesOverdue: 120 });
    await cancelP2P(cancelled.id, 'Customer withdrew commitment');
    const afterCancelBreak = await markP2PBroken(cancelled.id, 'watchdog should not touch this');
    assert(
      'a cancelled promise cannot be broken',
      afterCancelBreak.status === 'cancelled',
      `status=${afterCancelBreak.status}`,
    );

    const twice = await makeOverdueP2P({ key: 'twice', minutesOverdue: 120 });
    const first = await markP2PBroken(twice.id, 'first break');
    const second = await markP2PBroken(twice.id, 'second break attempt');
    assert('re-breaking is a no-op', second.brokenAt?.getTime() === first.brokenAt?.getTime());
    assert(
      'reason from the first break is preserved',
      second.failureReason === 'first break',
      `${second.failureReason}`,
    );
    const brokenEvents = (await actions(twice.id)).filter((a) => a === 'p2p_broken');
    assert('exactly one p2p_broken ledger row', brokenEvents.length === 1, `${brokenEvents.length}`);

    // Escalating an already-escalated promise must not open a second CRM ticket.
    await escalateP2PToHumanAR(twice.id, 'first escalation');
    const escalatedOnce = await prisma.promiseToPay.findUniqueOrThrow({ where: { id: twice.id } });
    await escalateP2PToHumanAR(twice.id, 'duplicate escalation attempt');
    const escalatedTwice = await prisma.promiseToPay.findUniqueOrThrow({ where: { id: twice.id } });
    assert(
      'no duplicate CRM ticket for the same debt',
      escalatedTwice.crmTaskId === escalatedOnce.crmTaskId,
      `${escalatedOnce.crmTaskId} vs ${escalatedTwice.crmTaskId}`,
    );
  }

  // ── 4. A confirmed payment completes rather than breaks ───────────────────
  console.log('\n  [4] Confirmed payment on an overdue promise\n');
  {
    const p2p = await makeOverdueP2P({ key: 'paid', minutesOverdue: 10 });
    const after = await triggerP2PCollection(p2p.id, { paymentConfirmed: true });
    const log = await actions(p2p.id);

    assert('status → completed', after.status === 'completed', `status=${after.status}`);
    assert('resolvedAt set', after.resolvedAt !== null);
    assert('never marked broken', after.brokenAt === null, `brokenAt=${after.brokenAt}`);
    assert('escalationLevel stays 0', after.escalationLevel === 0, `${after.escalationLevel}`);
    assert('p2p_completed logged', log.includes('p2p_completed'), log.join(' → '));
    assert('p2p_escalated NOT logged', !log.includes('p2p_escalated'), log.join(' → '));
  }

  // ── 5. A single sweep advances each row without repeating or contradicting ─
  console.log('\n  [5] One sweep, no repeated or contradictory actions per row\n');
  {
    const inGrace = await makeOverdueP2P({ key: 'sweep_grace', minutesOverdue: 2, status: 'pending' });
    const breached = await makeOverdueP2P({
      key: 'sweep_breach',
      minutesOverdue: P2P_GRACE_PERIOD_MINUTES + 60,
      status: 'reminder_sent',
    });

    const summary = await processDueP2Ps();
    const forInGrace = summary.results.filter((r) => r.p2pId === inGrace.id).map((r) => r.action);
    const forBreached = summary.results.filter((r) => r.p2pId === breached.id).map((r) => r.action);

    // A pending promise inside its grace period legitimately advances two stages
    // in one tick — the reminder creates the Payment Link that collection then
    // checks. What must never happen is the SAME stage running twice, or a row
    // being both collected and broken in one sweep.
    assert(
      'in-grace promise advances through collection',
      forInGrace.includes('trigger_collection'),
      forInGrace.join(' → ') || '(none)',
    );
    assert(
      'in-grace promise never repeats a stage',
      new Set(forInGrace).size === forInGrace.length,
      forInGrace.join(' → '),
    );
    assert(
      'in-grace promise is NOT broken in the same sweep',
      !forInGrace.includes('break_and_escalate'),
      forInGrace.join(' → '),
    );

    assert('breached promise handled exactly once', forBreached.length === 1, forBreached.join(', ') || '(none)');
    assert(
      'breached promise routed to break_and_escalate',
      forBreached[0] === 'break_and_escalate',
      `${forBreached[0]}`,
    );
    assert(
      'breached promise is NOT sent a fresh reminder first',
      !forBreached.includes('send_reminder'),
      forBreached.join(' → '),
    );

    // A second immediate sweep must find nothing left to do for these two.
    const second = await processDueP2Ps();
    const stillListed = second.results.filter(
      (r) => r.p2pId === breached.id && r.action === 'break_and_escalate',
    );
    assert('an escalated promise is not swept again', stillListed.length === 0, `${stillListed.length}`);
  }

  console.log('\n' + hr());
  console.log(
    `  ${failed === 0 ? '✅' : '❌'} TEST RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`,
  );
  console.log(hr('═') + '\n');
  if (failed > 0) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (createdIds.length > 0) {
      await prisma.p2PAuditLog.deleteMany({ where: { p2pId: { in: createdIds } } });
      await prisma.promiseToPay.deleteMany({ where: { id: { in: createdIds } } });
    }
    await prisma.$disconnect();
  });
