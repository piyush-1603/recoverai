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

/** Dunning channel an event was delivered over. `null`/omitted = no message sent. */
export type AuditChannel = 'sms' | 'whatsapp' | 'upi_intent' | 'gateway_link' | 'none';

/**
 * Structured, queryable facts about an audit event.
 *
 * Everything here used to live only inside the human-readable `reason` sentence,
 * which meant the dashboard had to recover it with regexes — e.g. pulling a
 * payment id out of "…captured via Razorpay (pay_XXX)". That silently produced
 * `null` the first time anyone reworded the sentence. These are columns now, so
 * a consumer reads a value instead of parsing prose.
 *
 * Every field is optional. Rows written before this existed carry NULL and are
 * deliberately NOT backfilled — inventing metadata for historical events would
 * make the ledger less trustworthy, not more.
 */
export type AuditMetadata = {
  /** Transaction amount at the time of the event, in paise. */
  amountPaise?: number | null;
  /** Money this event actually confirmed as collected, in paise. Null unless recovered. */
  recoveredAmountPaise?: number | null;
  /** true = offline simulation produced this outcome; false = a live gateway call did. */
  simulated?: boolean;
  /** Stable policy rule identifier, e.g. 'R1_TRAI_WINDOW'. */
  ruleId?: string | null;
  channel?: AuditChannel | null;
  /** Dunning cost incurred by this event, in paise (SMS ₹0.12 = 12, WhatsApp ₹0.48 = 48). */
  messagingCostPaise?: number | null;
  /** The Razorpay entity this event refers to: pay_… / plink_… / sub_… / rfnd_… */
  razorpayEntityId?: string | null;
  /** Wall-clock duration of the advisory LLM call, in ms. */
  providerLatencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** What the advisory layer proposed, before the policy engine ruled on it. */
  aiRecommendedAction?: string | null;
  /** The model's own stated rationale. */
  aiReasoning?: string | null;
  /** Exact prompt sent to the model, for the live reasoning inspector. */
  aiPrompt?: string | null;
  /** Anything not worth its own column. Serialised to JSON on write. */
  extra?: Record<string, unknown> | null;
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
 * Builds the exact `AuditLog.create` payload `writeEvent` would write.
 *
 * Exported so callers that need to control transaction semantics — the webhook
 * route commits its state mutation and its ledger row in one `prisma.$transaction`
 * so a crash between the two cannot leave a recovered transaction with no
 * evidence — can reuse the field mapping instead of duplicating it and drifting.
 */
export function buildAuditData(
  transactionId: string,
  actor: AuditActor,
  action: string,
  reason: string,
  result: string,
  eventId?: string,
  policyVersion: string = 'v1',
  provider?: string | null,
  model?: string | null,
  meta?: AuditMetadata,
) {
  return {
    transactionId,
    actor,
    action,
    reason,
    result,
    policyVersion,
    eventId: eventId ?? generateEventId(transactionId, actor, action),
    provider: provider ?? null,
    model: model ?? null,
    amountPaise: meta?.amountPaise ?? null,
    recoveredAmountPaise: meta?.recoveredAmountPaise ?? null,
    simulated: meta?.simulated ?? false,
    ruleId: meta?.ruleId ?? null,
    channel: meta?.channel ?? null,
    messagingCostPaise: meta?.messagingCostPaise ?? null,
    razorpayEntityId: meta?.razorpayEntityId ?? null,
    providerLatencyMs: meta?.providerLatencyMs ?? null,
    promptTokens: meta?.promptTokens ?? null,
    completionTokens: meta?.completionTokens ?? null,
    aiRecommendedAction: meta?.aiRecommendedAction ?? null,
    aiReasoning: meta?.aiReasoning ?? null,
    aiPrompt: meta?.aiPrompt ?? null,
    metadata:
      meta?.extra && Object.keys(meta.extra).length > 0 ? JSON.stringify(meta.extra) : null,
  };
}

/** Random, collision-resistant idempotency key for events that have no natural one. */
function generateEventId(transactionId: string, actor: string, action: string): string {
  return crypto
    .createHash('sha256')
    .update(`${transactionId}:${actor}:${action}:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`)
    .digest('hex')
    .substring(0, 32);
}

/** True for the unique-constraint violation that means "this event is a duplicate". */
export function isDuplicateEventError(error: any): boolean {
  return error?.code === 'P2002' || Boolean(error?.message?.includes('UNIQUE constraint'));
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
 * @param meta          - Structured, queryable event metadata (see AuditMetadata)
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
  meta?: AuditMetadata,
): Promise<AuditEventRecord | null> {
  const data = buildAuditData(
    transactionId,
    actor,
    action,
    reason,
    result,
    eventId,
    policyVersion,
    provider,
    model,
    meta,
  );

  try {
    return await prisma.auditLog.create({ data });
  } catch (error: any) {
    // Unique constraint violation (Prisma error code P2002) -> idempotent duplicate write
    if (isDuplicateEventError(error)) {
      console.log(`[AuditLog] Duplicate eventId ignored: ${data.eventId}`);
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
