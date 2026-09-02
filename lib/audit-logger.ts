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
  | 'ai_agent'
  | 'policy_engine'
  | 'action_executor'
  | 'system'
  | 'webhook'
  | 'policy_engine_override'
  | 'ai_agent+policy_engine'
  // Historical actors, retained so rows written before the advisory layer was
  // made provider-agnostic stay representable. Not used by any new write —
  // the frozen baseline was reasoned over by Google Gemini, not Anthropic.
  | 'claude_agent'
  | 'claude_agent+policy_engine';

export type AuditEventRecord = {
  id: string;
  transactionId: string;
  eventId: string;
  actor: string;
  action: string;
  reason: string;
  result: string;
  provider?: string | null;
  model?: string | null;
  policyVersion?: string;
  timestamp: Date;
};

/**
 * Renders the advisory attribution used at the head of a ledger reason string.
 *
 * Always derived from the live recommendation object, never from a hardcoded
 * provider name, so a row records whichever provider actually answered — Gemini
 * on the primary path, Anthropic or OpenAI when the fallback chain engages.
 * Degrades to a bare 'AI' rather than inventing attribution when the caller has
 * nothing to attribute.
 */
export function describeAdvisor(provider?: string | null, model?: string | null): string {
  if (!provider) return 'AI';
  return model ? `AI (${provider} · ${model})` : `AI (${provider})`;
}

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
 * @param policyVersion - Policy version string (defaults to 'v1')
 * @param provider      - AI provider that produced the advisory recommendation (omit for non-AI actors)
 * @param model         - Exact model id behind that recommendation (omit for non-AI actors)
 * @returns             - The written AuditLog record, or null if duplicate
 */
export async function writeEvent(
  transactionId: string,
  actor: AuditActor,
  action: string,
  reason: string,
  result: string,
  eventId?: string,
  policyVersion: string = 'v1',
  provider?: string | null,
  model?: string | null,
): Promise<AuditEventRecord | null> {
  // Generate a unique eventId if not provided
  const resolvedEventId =
    eventId ??
    crypto
      .createHash('sha256')
      .update(`${transactionId}:${actor}:${action}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`)
      .digest('hex')
      .substring(0, 32);

  try {
    const record = await prisma.auditLog.create({
      data: {
        transactionId,
        actor,
        action,
        reason,
        result,
        policyVersion,
        eventId: resolvedEventId,
        provider: provider ?? null,
        model: model ?? null,
      },
    });
    return record;
  } catch (error: any) {
    // Unique constraint violation (Prisma error code P2002) -> idempotent duplicate write
    if (error?.code === 'P2002' || error?.message?.includes('UNIQUE constraint')) {
      console.log(`[AuditLog] Duplicate eventId ignored: ${resolvedEventId}`);
      return null;
    }
    throw error;
  }
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
