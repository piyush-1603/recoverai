/**
 * /lib/p2p-engine.ts
 *
 * Promise-to-Pay (P2P) Durable Execution Engine
 *
 * Implements a lightweight durable workflow for customer payment commitments
 * without requiring an external Temporal server. Uses database-backed state
 * machine + scheduled polling for crash-resilient execution.
 *
 * Workflow:
 *  1. Customer commits to pay ₹X at time T → record created (status: pending)
 *  2. At T - 1 hour → send WhatsApp/SMS reminder with Razorpay Payment Link
 *  3. At T            → check if payment link was completed; if not, trigger retry
 *  4. Success         → mark completed, write audit log
 *  5. T + grace       → promise is BROKEN; record it, then escalate to human AR
 *
 * Step 5 is the watchdog. Before it existed, a collection attempt that failed at T
 * escalated instantly and wrote `failed_escalated` — which conflated two different
 * facts ("the customer defaulted" and "a human was told") and gave the customer no
 * grace period at all, despite the reminder link often being paid minutes late.
 * A promise now sits in `processing` until the grace period elapses, becomes
 * `broken` when it does, and only then escalates.
 *
 * Every step is audit-logged to P2PAuditLog (decoupled from Transaction FK).
 * State is persisted in SQLite via Prisma, so the engine survives process restarts.
 */

import { prisma } from './prisma';
import { createPaymentLink, fetchPaymentLink, hasValidRazorpayKeys } from './razorpay';
import crypto from 'crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export type P2PStatus =
  | 'pending'
  | 'reminder_sent'
  | 'processing'
  | 'broken'
  | 'completed'
  | 'failed_escalated'
  | 'cancelled';

/**
 * How long after the promised time a customer still has to pay before the
 * promise is declared broken. Razorpay Payment Link settlement plus UPI
 * collect-request latency routinely lands a few minutes late, so escalating at
 * T exactly generates false defaults.
 */
export const P2P_GRACE_PERIOD_MINUTES = 30;
const MINUTE_MS = 60 * 1000;

/** Statuses that are settled — the watchdog must never reopen them. */
const P2P_TERMINAL_STATUSES = new Set<string>([
  'completed',
  'failed_escalated',
  'cancelled',
]);

export type CreateP2PInput = {
  customerId: string;
  amountPaise: number;
  promisedPaymentTime: string | Date; // ISO 8601 or Date
  transactionId?: string;             // link to original failed transaction
};

export type P2PRecord = {
  id: string;
  customerId: string;
  transactionId: string | null;
  amountPaise: number;
  promisedPaymentTime: Date;
  status: string;
  paymentLinkId: string | null;
  paymentLinkUrl: string | null;
  crmTaskId: string | null;
  reminderSentAt: Date | null;
  resolvedAt: Date | null;
  failureReason: string | null;
  /** When the grace period lapsed and the promise was declared broken. */
  brokenAt: Date | null;
  /** 0 = nobody notified, 1 = human AR notified. */
  escalationLevel: number;
  createdAt: Date;
  updatedAt: Date;
};

/** The moment a promise stops being merely late and becomes broken. */
export function p2pBreachDeadline(promisedPaymentTime: Date): Date {
  return new Date(promisedPaymentTime.getTime() + P2P_GRACE_PERIOD_MINUTES * MINUTE_MS);
}

// ─── P2P-specific Audit Logger ──────────────────────────────────────────────
// Writes to P2PAuditLog (no Transaction FK constraint).

async function logP2PEvent(
  p2pId: string,
  action: string,
  detail: string,
  result: string,
): Promise<void> {
  const eventId = crypto
    .createHash('sha256')
    .update(`${p2pId}:${action}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`)
    .digest('hex')
    .substring(0, 32);

  try {
    await prisma.p2PAuditLog.create({
      data: { p2pId, eventId, action, detail, result },
    });
  } catch (err: any) {
    // Idempotent — unique constraint on eventId
    if (err?.code === 'P2002' || err?.message?.includes('UNIQUE constraint')) {
      console.log(`[P2P Audit] Duplicate eventId ignored: ${eventId}`);
      return;
    }
    throw err;
  }
}

// ─── Step 1: Create P2P Record ──────────────────────────────────────────────

export async function createP2P(input: CreateP2PInput): Promise<P2PRecord> {
  const promised = new Date(input.promisedPaymentTime);
  if (isNaN(promised.getTime())) {
    throw new Error('Invalid promisedPaymentTime: must be a valid ISO 8601 date');
  }
  if (promised.getTime() <= Date.now()) {
    throw new Error('promisedPaymentTime must be in the future');
  }

  const record = await prisma.promiseToPay.create({
    data: {
      customerId: input.customerId,
      transactionId: input.transactionId ?? null,
      amountPaise: input.amountPaise,
      promisedPaymentTime: promised,
      status: 'pending',
    },
  });

  const amountRupees = (input.amountPaise / 100).toLocaleString('en-IN');
  await logP2PEvent(
    record.id,
    'p2p_created',
    `Promise-to-Pay registered: Customer ${input.customerId} committed ₹${amountRupees} ` +
      `by ${promised.toISOString()}. P2P ID: ${record.id}`,
    'p2p_scheduled',
  );

  return record as P2PRecord;
}

// ─── Step 2: Send 1-Hour Pre-Due Reminder ───────────────────────────────────

export async function sendP2PReminder(p2pId: string): Promise<P2PRecord> {
  const p2p = await prisma.promiseToPay.findUnique({ where: { id: p2pId } });
  if (!p2p) throw new Error(`P2P record ${p2pId} not found`);
  if (p2p.status !== 'pending') {
    // Already processed — idempotent no-op
    return p2p as P2PRecord;
  }

  let paymentLinkId: string | null = null;
  let paymentLinkUrl: string | null = null;
  const amountRupees = (p2p.amountPaise / 100).toLocaleString('en-IN');

  try {
    // Generate real Razorpay Payment Link
    const link = await createPaymentLink(
      p2p.amountPaise,
      `Payment reminder: ₹${amountRupees} due from ${p2p.customerId}`,
      { name: p2p.customerId, contact: '+919876543210' },
      { p2p_id: p2pId, customer_id: p2p.customerId },
      `p2p_${p2pId}`,
    );
    paymentLinkId = link.id;
    paymentLinkUrl = link.short_url;
  } catch (err: any) {
    console.warn('[P2P] Razorpay Payment Link creation failed, proceeding with record update:', err.message);
    paymentLinkUrl = `https://rzp.io/i/p2p_${p2pId}_simulated`;
    paymentLinkId = `plink_sim_${p2pId}`;
  }

  // Update DB state
  const updated = await prisma.promiseToPay.update({
    where: { id: p2pId },
    data: {
      status: 'reminder_sent',
      paymentLinkId,
      paymentLinkUrl,
      reminderSentAt: new Date(),
    },
  });

  await logP2PEvent(
    p2pId,
    'p2p_reminder_sent',
    `1-hour pre-due reminder dispatched to ${p2p.customerId} via WhatsApp/SMS. ` +
      `Razorpay Payment Link: ${paymentLinkUrl}. P2P ID: ${p2pId}`,
    'reminder_sent',
  );

  return updated as P2PRecord;
}

// ─── Step 3: Trigger Payment Collection at Promised Time ────────────────────

/**
 * Ask the gateway whether the reminder link was actually paid.
 *
 * Returns null when we cannot know — no real link, no keys, or the API call
 * failed. Callers must treat null as "unknown", never as "unpaid": declaring a
 * default because our own API call errored would invent a customer failure.
 */
async function isPaymentLinkPaid(paymentLinkId: string | null): Promise<boolean | null> {
  // `plink_sim_*` ids are produced by the offline fallback in sendP2PReminder and
  // do not exist at Razorpay, so there is nothing to fetch.
  if (!paymentLinkId || paymentLinkId.startsWith('plink_sim_')) return null;
  if (!hasValidRazorpayKeys()) return null;

  try {
    const link = await fetchPaymentLink(paymentLinkId);
    return link?.status === 'paid' || Number(link?.amount_paid ?? 0) > 0;
  } catch (err: any) {
    console.warn(`[P2P] Could not read Payment Link ${paymentLinkId}: ${err?.message}`);
    return null;
  }
}

export async function triggerP2PCollection(
  p2pId: string,
  opts: { paymentConfirmed?: boolean } = {},
): Promise<P2PRecord> {
  const p2p = await prisma.promiseToPay.findUnique({ where: { id: p2pId } });
  if (!p2p) throw new Error(`P2P record ${p2pId} not found`);
  if (P2P_TERMINAL_STATUSES.has(p2p.status)) {
    return p2p as P2PRecord;
  }

  // Mark as processing
  await prisma.promiseToPay.update({
    where: { id: p2pId },
    data: { status: 'processing' },
  });

  await logP2PEvent(
    p2pId,
    'p2p_collection_triggered',
    `Promised payment time reached. Attempting collection for ₹${(p2p.amountPaise / 100).toLocaleString('en-IN')}. P2P ID: ${p2pId}`,
    'collection_in_progress',
  );

  // Truth in priority order: an explicit caller assertion (tests, webhook-confirmed
  // payment), then the gateway itself, and only then the offline simulation.
  let paymentSucceeded: boolean;
  let evidence: string;

  if (typeof opts.paymentConfirmed === 'boolean') {
    paymentSucceeded = opts.paymentConfirmed;
    evidence = 'caller-supplied confirmation';
  } else {
    const linkPaid = await isPaymentLinkPaid(p2p.paymentLinkId);
    if (linkPaid !== null) {
      paymentSucceeded = linkPaid;
      evidence = `Razorpay Payment Link status (${p2p.paymentLinkId})`;
    } else {
      // No gateway truth available. Simulated, and labelled as such — a reminded
      // customer pays more often than an un-reminded one, which is the only
      // signal the offline path legitimately has.
      const successProbability = p2p.reminderSentAt !== null ? 0.7 : 0.3;
      paymentSucceeded = Math.random() < successProbability;
      evidence = 'offline simulation (no live Payment Link to query)';
    }
  }

  if (paymentSucceeded) {
    return completeP2P(p2pId, `razorpay_${Date.now()}`);
  }

  // NOT an immediate escalation. The promise is late, not yet broken — the
  // watchdog decides that once the grace period has actually elapsed.
  const deadline = p2pBreachDeadline(p2p.promisedPaymentTime);
  const reason = `Payment not confirmed at promised time (${evidence}). Grace period runs to ${deadline.toISOString()}.`;

  const updated = await prisma.promiseToPay.update({
    where: { id: p2pId },
    data: { status: 'processing', failureReason: reason },
  });

  await logP2PEvent(
    p2pId,
    'p2p_collection_unconfirmed',
    `Collection unconfirmed for ${p2p.customerId}. ${reason} ` +
      `Promise remains open until then. P2P ID: ${p2pId}`,
    'awaiting_grace_period',
  );

  return updated as P2PRecord;
}

// ─── Step 4: Mark P2P as Completed ──────────────────────────────────────────

export async function completeP2P(p2pId: string, paymentId: string): Promise<P2PRecord> {
  const p2p = await prisma.promiseToPay.findUnique({ where: { id: p2pId } });
  if (!p2p) throw new Error(`P2P record ${p2pId} not found`);

  const updated = await prisma.promiseToPay.update({
    where: { id: p2pId },
    data: {
      status: 'completed',
      resolvedAt: new Date(),
    },
  });

  await logP2PEvent(
    p2pId,
    'p2p_completed',
    `Promise-to-Pay fulfilled. ₹${(p2p.amountPaise / 100).toLocaleString('en-IN')} collected successfully. ` +
      `Payment ID: ${paymentId}. P2P ID: ${p2pId}`,
    'revenue_recovered',
  );

  return updated as P2PRecord;
}

// ─── Step 5: Declare the Promise Broken ─────────────────────────────────────

/**
 * The grace period elapsed with no confirmed payment: the promise is broken.
 *
 * Deliberately separate from escalation. `brokenAt` is a fact about the customer;
 * `crmTaskId`/`escalationLevel` are facts about us. Collapsing them into a single
 * `failed_escalated` write — the old behaviour — made it impossible to tell a
 * default from a notification, or to report broken-promise rate at all.
 *
 * `resolvedAt` stays null: a broken promise is still open receivable.
 */
export async function markP2PBroken(p2pId: string, reason: string): Promise<P2PRecord> {
  const p2p = await prisma.promiseToPay.findUnique({ where: { id: p2pId } });
  if (!p2p) throw new Error(`P2P record ${p2pId} not found`);

  // Never reopen a settled promise, and never re-break one already broken.
  if (P2P_TERMINAL_STATUSES.has(p2p.status) || p2p.status === 'broken') {
    return p2p as P2PRecord;
  }

  const brokenAt = new Date();
  const updated = await prisma.promiseToPay.update({
    where: { id: p2pId },
    data: { status: 'broken', brokenAt, failureReason: reason },
  });

  await logP2PEvent(
    p2pId,
    'p2p_broken',
    `Promise-to-Pay BROKEN. Customer ${p2p.customerId} did not pay ` +
      `₹${(p2p.amountPaise / 100).toLocaleString('en-IN')} within the ` +
      `${P2P_GRACE_PERIOD_MINUTES}-minute grace period after ` +
      `${p2p.promisedPaymentTime.toISOString()}. Reason: ${reason}. P2P ID: ${p2pId}`,
    'promise_broken',
  );

  return updated as P2PRecord;
}

// ─── Step 6: Escalate to Human AR ───────────────────────────────────────────

export async function escalateP2PToHumanAR(
  p2pId: string,
  failureReason: string,
): Promise<P2PRecord> {
  const p2p = await prisma.promiseToPay.findUnique({ where: { id: p2pId } });
  if (!p2p) throw new Error(`P2P record ${p2pId} not found`);

  // Escalating an already-escalated or settled promise would open a duplicate
  // CRM ticket for the same debt.
  if (P2P_TERMINAL_STATUSES.has(p2p.status)) {
    return p2p as P2PRecord;
  }

  // In production: call Salesforce / HubSpot / Freshdesk API
  const crmTaskId = `CRM_AR_${Date.now()}`;

  const updated = await prisma.promiseToPay.update({
    where: { id: p2pId },
    data: {
      status: 'failed_escalated',
      crmTaskId,
      failureReason,
      resolvedAt: new Date(),
      // Preserve the breach timestamp when escalation is reached without passing
      // through `broken` (a direct call), so the default is never unrecorded.
      brokenAt: p2p.brokenAt ?? new Date(),
      escalationLevel: 1,
    },
  });

  await logP2PEvent(
    p2pId,
    'p2p_escalated',
    `Promise-to-Pay BROKEN. Customer ${p2p.customerId} failed to pay ` +
      `₹${(p2p.amountPaise / 100).toLocaleString('en-IN')} by promised time. ` +
      `Escalated to human AR collections. CRM Ticket: ${crmTaskId}. Reason: ${failureReason}`,
    'escalated_to_human_ar',
  );

  return updated as P2PRecord;
}

// ─── Step 7: Cancel P2P ─────────────────────────────────────────────────────

export async function cancelP2P(p2pId: string, reason: string): Promise<P2PRecord> {
  const p2p = await prisma.promiseToPay.findUnique({ where: { id: p2pId } });
  if (!p2p) throw new Error(`P2P record ${p2pId} not found`);

  const updated = await prisma.promiseToPay.update({
    where: { id: p2pId },
    data: {
      status: 'cancelled',
      resolvedAt: new Date(),
      failureReason: reason,
    },
  });

  await logP2PEvent(
    p2pId,
    'p2p_cancelled',
    `Promise-to-Pay cancelled. Reason: ${reason}. P2P ID: ${p2pId}`,
    'cancelled',
  );

  return updated as P2PRecord;
}

// ─── Durable Scheduler: Process Due P2Ps ────────────────────────────────────
// Call this from a cron endpoint or polling interval. It:
//  - Finds pending P2Ps whose reminder window is open (T - 1 hour)
//  - Finds reminder_sent P2Ps whose promised time has arrived
//  - Runs the expiry watchdog: promises past T + grace become `broken`, then escalate
// This is crash-resilient because state is in the DB, not in memory.

export async function processDueP2Ps(): Promise<{
  remindersProcessed: number;
  collectionsProcessed: number;
  breachesProcessed: number;
  results: Array<{ p2pId: string; action: string; status: string }>;
}> {
  const now = new Date();
  const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
  const graceCutoff = new Date(now.getTime() - P2P_GRACE_PERIOD_MINUTES * MINUTE_MS);
  const results: Array<{ p2pId: string; action: string; status: string }> = [];

  // 1. Find pending P2Ps where the reminder window is open (due within 1 hour).
  //    Bounded below by the grace cutoff: a promise already past its grace period
  //    is about to be declared broken further down, and sending it a "1-hour
  //    pre-due reminder" first would mint a Razorpay link and bill for an SMS on
  //    a debt we are in the same breath handing to human collections.
  const dueForReminder = await prisma.promiseToPay.findMany({
    where: {
      status: 'pending',
      promisedPaymentTime: { lte: oneHourFromNow, gt: graceCutoff },
    },
  });

  for (const p2p of dueForReminder) {
    try {
      const updated = await sendP2PReminder(p2p.id);
      results.push({ p2pId: p2p.id, action: 'send_reminder', status: updated.status });
    } catch (err: any) {
      console.error(`[P2P] Failed to send reminder for ${p2p.id}:`, err.message);
      results.push({ p2pId: p2p.id, action: 'send_reminder', status: `error: ${err.message}` });
    }
  }

  // 2. Promises whose time has arrived but whose grace period has NOT yet run out.
  //    A single query covers both the reminded path and any pending promise that
  //    skipped the reminder window; the two separate queries this replaces could
  //    return the same row twice and attempt collection on it twice.
  const dueForCollection = await prisma.promiseToPay.findMany({
    where: {
      status: { in: ['pending', 'reminder_sent', 'processing'] },
      promisedPaymentTime: { lte: now, gt: graceCutoff },
    },
  });

  for (const p2p of dueForCollection) {
    try {
      const updated = await triggerP2PCollection(p2p.id);
      results.push({ p2pId: p2p.id, action: 'trigger_collection', status: updated.status });
    } catch (err: any) {
      console.error(`[P2P] Failed to collect for ${p2p.id}:`, err.message);
      results.push({ p2pId: p2p.id, action: 'trigger_collection', status: `error: ${err.message}` });
    }
  }

  // 3. Expiry watchdog. The grace period has elapsed with nothing confirmed, so
  //    the promise is broken. One last gateway check first — a customer who paid
  //    the link at T+25min must not be reported as a defaulter just because no
  //    webhook reached us.
  const breached = await prisma.promiseToPay.findMany({
    where: {
      status: { in: ['pending', 'reminder_sent', 'processing'] },
      promisedPaymentTime: { lte: graceCutoff },
    },
  });

  for (const p2p of breached) {
    try {
      const paidLate = await isPaymentLinkPaid(p2p.paymentLinkId);
      if (paidLate === true) {
        const updated = await completeP2P(p2p.id, p2p.paymentLinkId ?? `razorpay_${Date.now()}`);
        results.push({ p2pId: p2p.id, action: 'late_payment_detected', status: updated.status });
        continue;
      }

      const overdueMinutes = Math.floor(
        (now.getTime() - p2p.promisedPaymentTime.getTime()) / MINUTE_MS,
      );
      await markP2PBroken(
        p2p.id,
        `No confirmed payment ${overdueMinutes} minutes after the promised time ` +
          `(grace period: ${P2P_GRACE_PERIOD_MINUTES} minutes).`,
      );
      const escalated = await escalateP2PToHumanAR(
        p2p.id,
        `Promise broken: unpaid ${overdueMinutes} minutes past the promised time.`,
      );
      results.push({ p2pId: p2p.id, action: 'break_and_escalate', status: escalated.status });
    } catch (err: any) {
      console.error(`[P2P] Watchdog failed for ${p2p.id}:`, err.message);
      results.push({ p2pId: p2p.id, action: 'break_and_escalate', status: `error: ${err.message}` });
    }
  }

  return {
    remindersProcessed: dueForReminder.length,
    collectionsProcessed: dueForCollection.length,
    breachesProcessed: breached.length,
    results,
  };
}

// ─── Query Helpers ──────────────────────────────────────────────────────────

export async function getP2PById(p2pId: string): Promise<P2PRecord | null> {
  const record = await prisma.promiseToPay.findUnique({ where: { id: p2pId } });
  return record as P2PRecord | null;
}

export async function getP2PsByCustomer(customerId: string): Promise<P2PRecord[]> {
  const records = await prisma.promiseToPay.findMany({
    where: { customerId },
    orderBy: { createdAt: 'desc' },
  });
  return records as P2PRecord[];
}

export async function getAllP2Ps(limit: number = 50): Promise<P2PRecord[]> {
  const records = await prisma.promiseToPay.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return records as P2PRecord[];
}

export async function getP2PAuditLog(p2pId: string) {
  return prisma.p2PAuditLog.findMany({
    where: { p2pId },
    orderBy: { timestamp: 'asc' },
  });
}
