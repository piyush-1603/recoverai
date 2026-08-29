/**
 * /lib/audit-logger.ts
 *
 * Append-only audit log for all recovery engine actions.
 * Guarantees idempotency via a unique eventId — duplicate writes are silently
 * ignored (no duplicate log entries will be created).
 */

import 'dotenv/config';
import { prisma } from './prisma';
import crypto from 'crypto';

export type AuditActor =
  | 'claude_agent'
  | 'policy_engine'
  | 'action_executor'
  | 'system'
  | 'webhook';

export type AuditEventRecord = {
  id: string;
  transactionId: string;
  eventId: string;
  actor: string;
  action: string;
  reason: string;
  result: string;
  timestamp: Date;
};

/**
 * Write an audit event.
 * Generates a deterministic eventId from the transaction, actor, action,
 * and a timestamp-based nonce — guarantees uniqueness per event invocation
 * while allowing callers to pass a pre-computed eventId for true idempotency.
 *
 * @param transactionId - The transaction this event belongs to
 * @param actor         - Who triggered the action
 * @param action        - What action was taken
 * @param reason        - Why the action was taken
 * @param result        - The outcome of the action
 * @param eventId       - Optional pre-computed idempotency key; auto-generated if omitted
 * @returns             - The written AuditLog record, or null if duplicate
 */
export async function writeEvent(
  transactionId: string,
  actor: AuditActor,
  action: string,
  reason: string,
  result: string,
  eventId?: string,
): Promise<AuditEventRecord | null> {
  // Generate a unique eventId if not provided
  const resolvedEventId =
    eventId ??
    crypto
      .createHash('sha256')
      .update(`${transactionId}:${actor}:${action}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`)
      .digest('hex')
      .substring(0, 32);

  // Idempotency check — silently skip if this eventId already exists
  const existing = await prisma.auditLog.findUnique({
    where: { eventId: resolvedEventId },
  });

  if (existing) {
    return null; // Duplicate — do not write
  }

  const record = await prisma.auditLog.create({
    data: {
      transactionId,
      eventId: resolvedEventId,
      actor,
      action,
      reason,
      result,
    },
  });

  return record;
}

/**
 * Retrieve audit events, optionally filtered by transaction.
 *
 * @param transactionId - Optional filter; if omitted, returns all events
 * @returns             - Array of AuditLog records ordered by timestamp ascending
 */
export async function getEvents(
  transactionId?: string,
): Promise<AuditEventRecord[]> {
  const where = transactionId ? { transactionId } : {};

  const records = await prisma.auditLog.findMany({
    where,
    orderBy: { timestamp: 'asc' },
  });

  return records;
}
