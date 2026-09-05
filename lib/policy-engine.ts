/**
 * /lib/policy-engine.ts
 *
 * Pure, deterministic function that diagnoses a failed transaction and
 * decides what action to take based on the merchant's policy configuration.
 *
 * Rules are evaluated in strict priority order (top-to-bottom, first match wins).
 * This function has NO side effects — it never touches the database.
 */

export type TransactionInput = {
  id: string;
  status: string;
  reasonCode: string;
  type: string;
  amountPaise: number;
  source: string;
  retryCount: number;
  nudgeCount: number;
  customerTier?: string; // 'vip' | 'standard' | 'trial'
  abandonedAt?: Date | string | null;
  createdAt?: Date | string;
  /**
   * Routing inputs for the Smart Optimizer. Both optional: the benchmark dataset
   * predates rail capture, so when they are absent the router infers the rail
   * from the failure signature and marks the decision as inferred.
   */
  customerId?: string;
  paymentMethod?: PaymentMethod;
  issuer?: string;
};

export type PolicyConfigInput = {
  afaThresholdPaise: number;
  maxRetries: number;
  vipMaxRetries?: number;
  standardMaxRetries?: number;
  trialMaxRetries?: number;
  maxNudges: number;
  nudgeWindowStartHour: number;
  nudgeWindowEndHour: number;
};

export type PolicyAction =
  | 'no_action'
  | 'stop_unrecoverable'
  | 'request_approval'
  | 'send_nudge'
  | 'auto_retry';

/**
 * Stable identifier for the rule branch that produced a decision.
 *
 * These strings are written to `AuditLog.ruleId` and are the join key between a
 * ledger row and the rule that caused it, so they are part of the data contract:
 * rename one and historical rows stop matching. The `reason` prose may be
 * reworded freely; these may not.
 *
 * Note the four distinct `*_TRAI_WINDOW` ids. All four emit the same sentence,
 * which made the compliance hold impossible to attribute to a rule after the
 * fact — "how often does the nocturnal restriction block a card-update nudge
 * specifically" was unanswerable. Now it is a `WHERE ruleId = ...`.
 */
export type PolicyRuleId =
  | 'R1_ALREADY_RESOLVED'
  | 'R2_BLOCKED_REASON_CODE'
  | 'R3_AFA_NUDGE_LIMIT'
  | 'R3_AFA_TRAI_WINDOW'
  | 'R3_AFA_APPROVAL'
  | 'R4_RETRY_LIMIT'
  | 'R4_RETRY_AND_NUDGE_LIMIT'
  | 'R4_CUSTOMER_NUDGE_LIMIT'
  | 'R5_TRANSIENT_RETRY'
  | 'R5_ISSUER_DOWNTIME_HOLD'
  | 'R6_FUNDS_NUDGE'
  | 'R6_FUNDS_TRAI_WINDOW'
  | 'R7_CARD_TRAI_WINDOW'
  | 'R7_CARD_NUDGE'
  | 'R8_CART_TOO_FRESH'
  | 'R8_CART_WINDOW_EXPIRED'
  | 'R8_CART_NUDGE'
  | 'R8_CART_TRAI_WINDOW'
  | 'R9_NO_RULE_MATCHED';

/**
 * Why a transaction is being parked rather than resolved, and — via
 * `resumeAtHour` — when it becomes eligible again.
 *
 * Persisted to `Transaction.holdReason` / `Transaction.deferredUntil` by the
 * action executor, so "why is this still open and when does it move" is a column
 * read rather than an inference from ledger prose. Set on exactly the decisions
 * that suppress an action; null on every decision that resolves one.
 */
export type PolicyHoldReason =
  | 'trai_window_closed' // TCCCPR 2018 nocturnal restriction — releases at window open
  | 'cart_too_fresh' // deliberate delay; the customer may still be in the checkout
  | 'issuer_downtime' // the rail is down; spending a retry now would waste the budget
  | 'no_rule_matched'; // nothing in policy applies — parked for human review

// ─── Razorpay Smart Optimizer: issuer-aware retry routing ───────────────────
//
// Deciding *whether* to re-attempt a charge and deciding *which rail* to
// re-attempt it on are two different questions, and conflating them is how
// recovery systems burn their entire retry budget into a bank that is down.
// The rules above answer the first question. Everything below answers the
// second, and — in exactly one case — vetoes the first: a retry is never spent
// on a rail with no chance of authorising.
//
// The health input is modelled on Razorpay's Payment Downtime feed
// (`payment.downtime.started` / `.updated` / `.resolved`), whose entity carries
// `method`, the affected `instrument`, a `severity`, and a `begin`/`end` window.
// Everything here stays pure: the snapshot is passed in, never fetched.

/** Rails a recovery attempt can be routed over. */
export type PaymentMethod = 'card' | 'netbanking' | 'upi' | 'wallet' | 'emandate';

export type RailStatus = 'up' | 'degraded' | 'down';

export type RailHealth = {
  method: PaymentMethod;
  /**
   * The issuing bank for card/netbanking/emandate, the PSP handle for UPI, or
   * the brand for a wallet. `'*'` means the whole method is affected with no
   * instrument breakdown — how Razorpay reports method-wide downtime.
   */
  instrument: string;
  status: RailStatus;
  /** Live authorization rate for this rail, 0–100. */
  successRatePct: number;
  /** Razorpay downtime severity. Null while the rail is healthy. */
  severity: 'high' | 'medium' | 'low' | null;
  /** Operator ETA for the rail returning, in minutes. Null when unknown. */
  estimatedRecoveryMinutes: number | null;
  /** Whether this row came from a downtime event or from the baseline estimate. */
  source: 'downtime_feed' | 'baseline';
};

export type GatewayHealthSnapshot = {
  capturedAt: string;
  /** True only when these rows came from Razorpay's live feed. */
  live: boolean;
  rails: RailHealth[];
};

export type RoutingStrategy =
  /** Origin rail is healthy — re-attempt exactly where the payment failed. */
  | 'retry_same_rail'
  /** Same bank, different rail (e.g. HDFC netbanking down → HDFC UPI intent). */
  | 'switch_method'
  /** No rail at the customer's bank is up — fail over to the best rail anywhere. */
  | 'switch_instrument'
  /** Nothing is up. Park the attempt rather than consume the retry budget. */
  | 'hold_for_recovery';

export type PaymentRail = {
  method: PaymentMethod;
  instrument: string;
};

export type RouteDecision = {
  strategy: RoutingStrategy;
  /** True whenever the recommended rail differs from where the payment failed. */
  rerouted: boolean;
  origin: PaymentRail;
  /**
   * True when the origin rail was derived from the failure signature rather than
   * recorded on the transaction. The benchmark dataset predates rail capture, so
   * this is honest about which rows are inference.
   */
  originInferred: boolean;
  originStatus: RailStatus;
  originSuccessRatePct: number;
  /** Null only for `hold_for_recovery` — there is nowhere to send it. */
  recommended: PaymentRail | null;
  recommendedSuccessRatePct: number | null;
  /** Percentage points of authorization rate the reroute buys. */
  upliftPct: number | null;
  /** Minutes until the origin rail is expected back. Null when unknown. */
  estimatedRecoveryMinutes: number | null;
  severity: 'high' | 'medium' | 'low' | null;
  reason: string;
};

export type PolicyDecision = {
  action: PolicyAction;
  requiresApproval: boolean;
  blockedByCompliance: boolean;
  reason: string;
  policyVersion: string;
  /** Stable identifier of the rule branch that fired. */
  ruleId: PolicyRuleId;
  /** Set only when the decision parks the transaction instead of resolving it. */
  holdReason: PolicyHoldReason | null;
  /** IST hour at which a clock-bound hold becomes eligible again. Null = not clock-bound. */
  resumeAtHour: number | null;
  /**
   * Which rail this attempt should use. Present only when a gateway health
   * snapshot was supplied AND the decision actually dispatches a payment path;
   * `undefined` means no routing telemetry was available, which is not the same
   * as "the origin rail is fine".
   */
  routing?: RouteDecision | null;
};

/**
 * Issuers the router knows about, with their real UPI handles, so a method
 * switch keeps the customer at their own bank. Recommending an ICICI handle to
 * an HDFC account holder is not a reroute, it is a dead end.
 */
const ISSUER_DIRECTORY: Array<{ bank: string; upiHandle: string }> = [
  { bank: 'HDFC', upiHandle: '@okhdfcbank' },
  { bank: 'ICICI', upiHandle: '@okicici' },
  { bank: 'SBI', upiHandle: '@oksbi' },
  { bank: 'AXIS', upiHandle: '@okaxis' },
  { bank: 'KOTAK', upiHandle: '@kotak' },
];

export function issuerDirectory(): ReadonlyArray<{ bank: string; upiHandle: string }> {
  return ISSUER_DIRECTORY;
}

/**
 * The rail a given failure most likely arrived on.
 *
 * Reason codes are the only rail evidence the benchmark dataset carries, and
 * they are decent evidence: a bank technical error is a netbanking/issuer-side
 * signature, a timeout is the classic UPI collect request the customer never
 * opened, and card declines are self-describing.
 */
const METHOD_BY_REASON_CODE: Record<string, PaymentMethod> = {
  bank_technical_error: 'netbanking',
  gateway_technical_error: 'card',
  payment_timed_out: 'upi',
  insufficient_funds: 'upi',
  card_declined: 'card',
  authentication_failed: 'card',
  card_expired: 'card',
  payment_pending_approval: 'emandate',
};

/**
 * India rail preference when authorization rates tie. UPI first: it carries the
 * highest live success rate and zero MDR on P2M, so it is both the likeliest to
 * authorise and the cheapest to authorise on.
 */
const METHOD_PREFERENCE: PaymentMethod[] = ['upi', 'card', 'netbanking', 'wallet', 'emandate'];

/** Rails an automated reroute may move an attempt onto. */
const REROUTABLE_METHODS = new Set<PaymentMethod>(['upi', 'card', 'netbanking', 'wallet']);

/** Stable, non-cryptographic hash so a customer always resolves to one bank. */
function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** The bank a customer holds, derived deterministically from their id. */
export function inferIssuerBank(customerId: string): string {
  return ISSUER_DIRECTORY[stableHash(customerId) % ISSUER_DIRECTORY.length].bank;
}

/** The instrument string a given bank presents on a given rail. */
export function instrumentForBank(bank: string, method: PaymentMethod): string {
  if (method !== 'upi') return bank;
  const entry = ISSUER_DIRECTORY.find((i) => i.bank === bank);
  return entry ? entry.upiHandle : bank;
}

/** The bank behind an instrument string, inverting `instrumentForBank`. */
export function bankForInstrument(instrument: string): string {
  const entry = ISSUER_DIRECTORY.find(
    (i) => i.upiHandle === instrument || i.bank === instrument,
  );
  return entry ? entry.bank : instrument;
}

/**
 * Resolve where a payment failed. Uses whatever the transaction records, and
 * falls back to inference from the failure signature for rows that predate rail
 * capture — flagging which of the two happened.
 */
export function resolveOriginRail(transaction: TransactionInput): {
  rail: PaymentRail;
  inferred: boolean;
  bank: string;
} {
  const bank = transaction.issuer ?? inferIssuerBank(transaction.customerId ?? transaction.id);
  if (transaction.paymentMethod) {
    return {
      rail: { method: transaction.paymentMethod, instrument: instrumentForBank(bank, transaction.paymentMethod) },
      inferred: false,
      bank,
    };
  }

  // An abandoned cart never selected a rail, so there is no failed rail to
  // reroute away from — treat UPI as the offered default.
  const method = METHOD_BY_REASON_CODE[transaction.reasonCode] ?? 'upi';
  return {
    rail: { method, instrument: instrumentForBank(bank, method) },
    inferred: true,
    bank,
  };
}

/** Health for a rail, preferring an exact instrument row over a method-wide one. */
function findRailHealth(
  health: GatewayHealthSnapshot,
  rail: PaymentRail,
): RailHealth | undefined {
  return (
    health.rails.find((r) => r.method === rail.method && r.instrument === rail.instrument) ??
    health.rails.find((r) => r.method === rail.method && r.instrument === '*')
  );
}

/** Best-first ordering: highest authorization rate, then India rail preference. */
function rankRails(rails: RailHealth[]): RailHealth[] {
  return [...rails].sort((a, b) => {
    if (b.successRatePct !== a.successRatePct) return b.successRatePct - a.successRatePct;
    return METHOD_PREFERENCE.indexOf(a.method) - METHOD_PREFERENCE.indexOf(b.method);
  });
}

function railLabel(rail: PaymentRail): string {
  return rail.method === 'upi' ? `UPI ${rail.instrument}` : `${rail.instrument} ${rail.method}`;
}

/**
 * Choose the rail a recovery attempt should run on, given live rail health.
 *
 * Pure: no clock, no network, no database. The cascade is deliberate —
 *   1. origin rail healthy            → retry where it failed
 *   2. same bank has a healthy rail   → switch method (customer-actionable)
 *   3. any rail anywhere is healthy   → fail over to it (acquirer-level)
 *   4. nothing is healthy             → hold, and keep the retry budget
 *
 * Step 2 outranks step 3 on purpose even when step 3 offers a better rate: a
 * higher authorization rate at a bank the customer has no account with is worth
 * nothing. E-mandate is excluded as a reroute *destination* — standing up a new
 * recurring mandate on another rail needs fresh RBI AFA, so it is a new mandate
 * rather than a retry. A failed mandate debit may still be rerouted *away* onto a
 * one-off rail, which is how AR teams actually collect the missed instalment.
 */
export function evaluateSmartRoute(
  transaction: TransactionInput,
  health: GatewayHealthSnapshot,
): RouteDecision {
  const origin = resolveOriginRail(transaction);
  const originHealth = findRailHealth(health, origin.rail);

  // No telemetry for this rail is not evidence of a problem. Treat it as up and
  // say so, rather than inventing a downtime that was never reported.
  const originStatus: RailStatus = originHealth?.status ?? 'up';
  const originSuccessRatePct = originHealth?.successRatePct ?? 0;

  if (originStatus === 'up') {
    return {
      strategy: 'retry_same_rail',
      rerouted: false,
      origin: origin.rail,
      originInferred: origin.inferred,
      originStatus,
      originSuccessRatePct,
      recommended: origin.rail,
      recommendedSuccessRatePct: originSuccessRatePct,
      upliftPct: 0,
      estimatedRecoveryMinutes: null,
      severity: null,
      reason:
        `${railLabel(origin.rail)} is healthy at ${originSuccessRatePct.toFixed(1)}% ` +
        `authorization — no reroute needed`,
    };
  }

  const healthy = health.rails.filter(
    (r) =>
      r.status === 'up' &&
      REROUTABLE_METHODS.has(r.method) &&
      !(r.method === origin.rail.method && r.instrument === origin.rail.instrument) &&
      r.instrument !== '*',
  );

  const sameBank = rankRails(healthy.filter((r) => bankForInstrument(r.instrument) === origin.bank));
  const anyBank = rankRails(healthy);
  const chosen = sameBank[0] ?? anyBank[0];

  if (!chosen) {
    return {
      strategy: 'hold_for_recovery',
      rerouted: false,
      origin: origin.rail,
      originInferred: origin.inferred,
      originStatus,
      originSuccessRatePct,
      recommended: null,
      recommendedSuccessRatePct: null,
      upliftPct: null,
      estimatedRecoveryMinutes: originHealth?.estimatedRecoveryMinutes ?? null,
      severity: originHealth?.severity ?? null,
      reason:
        `${railLabel(origin.rail)} is ${originStatus} and no alternative rail is up — ` +
        `holding the attempt instead of spending a retry that cannot authorise`,
    };
  }

  const recommended: PaymentRail = { method: chosen.method, instrument: chosen.instrument };
  const strategy: RoutingStrategy = sameBank[0] ? 'switch_method' : 'switch_instrument';

  return {
    strategy,
    rerouted: true,
    origin: origin.rail,
    originInferred: origin.inferred,
    originStatus,
    originSuccessRatePct,
    recommended,
    recommendedSuccessRatePct: chosen.successRatePct,
    upliftPct: Number((chosen.successRatePct - originSuccessRatePct).toFixed(1)),
    estimatedRecoveryMinutes: originHealth?.estimatedRecoveryMinutes ?? null,
    severity: originHealth?.severity ?? null,
    reason:
      strategy === 'switch_method'
        ? `${railLabel(origin.rail)} is ${originStatus} (${originSuccessRatePct.toFixed(1)}%) — ` +
          `routing to ${railLabel(recommended)} at ${chosen.successRatePct.toFixed(1)}%, ` +
          `same issuer so the customer can actually complete it`
        : `no rail at ${origin.bank} is up — failing over to ${railLabel(recommended)} ` +
          `at ${chosen.successRatePct.toFixed(1)}% authorization`,
  };
}

/**
 * Layer routing onto a completed policy decision.
 *
 * Routing is advisory about *how* to act and authoritative about one thing only:
 * it will not let a retry be spent on a rail that is down. Nudges are never held
 * for downtime — the customer picks their own rail inside their own app, and a
 * compliant contact window that has opened does not reopen later.
 */
function applySmartRouting(
  decision: PolicyDecision,
  transaction: TransactionInput,
  health: GatewayHealthSnapshot,
): PolicyDecision {
  if (decision.action !== 'auto_retry' && decision.action !== 'send_nudge') return decision;

  const routing = evaluateSmartRoute(transaction, health);

  if (decision.action !== 'auto_retry' || routing.strategy !== 'hold_for_recovery') {
    return { ...decision, routing };
  }

  return {
    ...decision,
    action: 'no_action',
    // A bank outage is an availability problem, not a regulatory one. Marking it
    // as a compliance block would corrupt the TRAI shield count.
    blockedByCompliance: false,
    reason: routing.reason,
    ruleId: 'R5_ISSUER_DOWNTIME_HOLD',
    holdReason: 'issuer_downtime',
    resumeAtHour: null,
    routing,
  };
}

/**
 * Diagnose a transaction and decide the appropriate recovery action.
 *
 * `health` is optional and purely additive: with no snapshot the returned
 * decision is bit-identical to what the rules alone produce, which is what
 * `scripts/verify-policy-parity.ts` asserts across the whole corpus × 24 hours.
 * Supply a snapshot and the Smart Optimizer annotates the decision with the rail
 * to use — and refuses to spend a retry on a rail that is down.
 */
export function diagnoseAndDecide(
  transaction: TransactionInput,
  policyConfig: PolicyConfigInput,
  currentHour: number,
  now?: Date,
  health?: GatewayHealthSnapshot,
): PolicyDecision {
  const decision = decidePolicyRules(transaction, policyConfig, currentHour, now);
  if (!health) return decision;
  return applySmartRouting(decision, transaction, health);
}

/**
 * The rule ladder itself.
 *
 * Priority order (STRICT — first match wins, never reorder):
 *   1. Already recovered → no_action
 *   2. Blocked reason codes → stop_unrecoverable
 *   3. Subscription above AFA threshold → request_approval
 *   4. Both retry and nudge limits exhausted → stop_unrecoverable
 *   5. Transient gateway/razorpay error within retry limit → auto_retry (tier-aware)
 *   6. Customer insufficient_funds within nudge limit → send_nudge (or defer)
 *   7. Card-related error within first nudge → send_nudge
 *   8. Cart / Checkout abandonment → time-bounded nudge / stop_unrecoverable
 *   9. Default fallback → no_action
 */
function decidePolicyRules(
  transaction: TransactionInput,
  policyConfig: PolicyConfigInput,
  currentHour: number,
  now?: Date,
): PolicyDecision {
  const policyVersion = 'v1';

  // Determine tier-appropriate retry limit
  let effectiveMaxRetries = policyConfig.maxRetries ?? 1;
  if (transaction.customerTier === 'vip') {
    effectiveMaxRetries = policyConfig.vipMaxRetries ?? 3;
  } else if (transaction.customerTier === 'trial') {
    effectiveMaxRetries = policyConfig.trialMaxRetries ?? 1;
  } else if (transaction.customerTier === 'standard') {
    effectiveMaxRetries = policyConfig.standardMaxRetries ?? 1;
  }

  // Rule 1: Already resolved
  if (transaction.status === 'recovered') {
    return {
      action: 'no_action',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: 'already resolved',
      policyVersion,
      ruleId: 'R1_ALREADY_RESOLVED',
      holdReason: null,
      resumeAtHour: null,
    };
  }

  // Rule 2: Flagged reason codes that are never retryable by policy
  const blockedReasonCodes = [
    'payment_risk_check_failed',
    'transaction_daily_limit_exceeded',
  ];
  if (blockedReasonCodes.includes(transaction.reasonCode)) {
    return {
      action: 'stop_unrecoverable',
      requiresApproval: false,
      blockedByCompliance: true,
      reason: 'flagged reason code, not retryable by policy',
      policyVersion,
      ruleId: 'R2_BLOCKED_REASON_CODE',
      holdReason: null,
      resumeAtHour: null,
    };
  }

  // Rule 3: Subscription above merchant AFA threshold — requires customer authentication
  if (
    transaction.type === 'subscription' &&
    transaction.amountPaise > policyConfig.afaThresholdPaise
  ) {
    if (transaction.nudgeCount >= policyConfig.maxNudges) {
      return {
        action: 'stop_unrecoverable',
        requiresApproval: false,
        blockedByCompliance: false,
        reason: 'exhausted customer nudge limits',
        policyVersion,
        ruleId: 'R3_AFA_NUDGE_LIMIT',
        holdReason: null,
        resumeAtHour: null,
      };
    }

    const inWindow =
      currentHour >= policyConfig.nudgeWindowStartHour &&
      currentHour < policyConfig.nudgeWindowEndHour;

    if (!inWindow) {
      return {
        action: 'no_action',
        requiresApproval: false,
        blockedByCompliance: true,
        reason:
          'outside compliant nudge window (TRAI SMS timing rules), deferred to next window',
        policyVersion,
        ruleId: 'R3_AFA_TRAI_WINDOW',
        holdReason: 'trai_window_closed',
        resumeAtHour: policyConfig.nudgeWindowStartHour,
      };
    }

    return {
      action: 'request_approval',
      requiresApproval: true,
      blockedByCompliance: false,
      reason:
        `merchant policy threshold requires customer authentication above ₹` +
        `${policyConfig.afaThresholdPaise / 100}` +
        ` (see RBI e-mandate framework documentation)`,
      policyVersion,
      ruleId: 'R3_AFA_APPROVAL',
      holdReason: null,
      resumeAtHour: null,
    };
  }

  // Rule 4: Retry and nudge limits exhausted
  const isTransientSource = ['gateway', 'razorpay'].includes(transaction.source);
  if (isTransientSource && transaction.retryCount >= effectiveMaxRetries) {
    return {
      action: 'stop_unrecoverable',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: 'exhausted retry limits',
      policyVersion,
      ruleId: 'R4_RETRY_LIMIT',
      holdReason: null,
      resumeAtHour: null,
    };
  }

  if (
    transaction.retryCount >= effectiveMaxRetries &&
    transaction.nudgeCount >= policyConfig.maxNudges
  ) {
    return {
      action: 'stop_unrecoverable',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: 'exhausted retry and nudge limits',
      policyVersion,
      ruleId: 'R4_RETRY_AND_NUDGE_LIMIT',
      holdReason: null,
      resumeAtHour: null,
    };
  }

  const cardReasonCodes = [
    'card_declined',
    'authentication_failed',
    'card_expired',
  ];
  const maxCustomerNudges = cardReasonCodes.includes(transaction.reasonCode)
    ? 1
    : policyConfig.maxNudges;
  if (
    transaction.source === 'customer' &&
    transaction.nudgeCount >= maxCustomerNudges
  ) {
    return {
      action: 'stop_unrecoverable',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: 'exhausted customer nudge limits',
      policyVersion,
      ruleId: 'R4_CUSTOMER_NUDGE_LIMIT',
      holdReason: null,
      resumeAtHour: null,
    };
  }

  // Rule 5: Transient gateway/razorpay error — auto-retry if within tier-based limit
  const transientSources = ['gateway', 'razorpay'];
  if (
    transientSources.includes(transaction.source) &&
    transaction.retryCount < effectiveMaxRetries
  ) {
    const tierNote = transaction.customerTier === 'vip' ? ' (VIP tier priority: up to 3 retries)' : '';
    return {
      action: 'auto_retry',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: `transient ${transaction.source} error, auto-retry within limit${tierNote}`,
      policyVersion,
      ruleId: 'R5_TRANSIENT_RETRY',
      holdReason: null,
      resumeAtHour: null,
    };
  }

  // Rule 6: Customer-side insufficient_funds — nudge if within limit and window
  if (
    transaction.source === 'customer' &&
    transaction.reasonCode === 'insufficient_funds' &&
    transaction.nudgeCount < policyConfig.maxNudges
  ) {
    const inWindow =
      currentHour >= policyConfig.nudgeWindowStartHour &&
      currentHour < policyConfig.nudgeWindowEndHour;

    if (inWindow) {
      return {
        action: 'send_nudge',
        requiresApproval: false,
        blockedByCompliance: false,
        reason: 'customer-side, nudging within compliant window',
        policyVersion,
        ruleId: 'R6_FUNDS_NUDGE',
        holdReason: null,
        resumeAtHour: null,
      };
    } else {
      return {
        action: 'no_action',
        requiresApproval: false,
        blockedByCompliance: true,
        reason:
          'outside compliant nudge window (TRAI SMS timing rules), deferred to next window',
        policyVersion,
        ruleId: 'R6_FUNDS_TRAI_WINDOW',
        holdReason: 'trai_window_closed',
        resumeAtHour: policyConfig.nudgeWindowStartHour,
      };
    }
  }

  // Rule 7: Card-related issues — request payment method update (no retry, it would fail identically)
  if (
    cardReasonCodes.includes(transaction.reasonCode) &&
    transaction.nudgeCount < 1
  ) {
    const inWindow =
      currentHour >= policyConfig.nudgeWindowStartHour &&
      currentHour < policyConfig.nudgeWindowEndHour;

    if (!inWindow) {
      return {
        action: 'no_action',
        requiresApproval: false,
        blockedByCompliance: true,
        reason:
          'outside compliant nudge window (TRAI SMS timing rules), deferred to next window',
        policyVersion,
        ruleId: 'R7_CARD_TRAI_WINDOW',
        holdReason: 'trai_window_closed',
        resumeAtHour: policyConfig.nudgeWindowStartHour,
      };
    }

    return {
      action: 'send_nudge',
      requiresApproval: false,
      blockedByCompliance: false,
      reason:
        'card issue, requesting customer update payment method, no retry (would fail identically)',
      policyVersion,
      ruleId: 'R7_CARD_NUDGE',
      holdReason: null,
      resumeAtHour: null,
    };
  }

  // Rule 8: Cart / Checkout Abandonment Lifecycle
  if (transaction.type === 'checkout_abandon') {
    const nowTime = now ? now.getTime() : Date.now();
    const abandonTime = transaction.abandonedAt
      ? new Date(transaction.abandonedAt).getTime()
      : (transaction.createdAt ? new Date(transaction.createdAt).getTime() : nowTime);
    const hoursSinceAbandonment = Math.max(0, (nowTime - abandonTime) / (1000 * 60 * 60));

    // Case 1: < 1 hour -> too soon, avoid premature nudge
    if (hoursSinceAbandonment < 1) {
      return {
        action: 'no_action',
        requiresApproval: false,
        blockedByCompliance: false,
        reason: 'too soon, avoiding premature nudge',
        policyVersion,
        ruleId: 'R8_CART_TOO_FRESH',
        holdReason: 'cart_too_fresh',
        // Elapsed-time bound, not clock bound: the executor derives the release
        // instant from abandonedAt + 1h, so there is no fixed IST hour to name.
        resumeAtHour: null,
      };
    }

    // Case 2: between 1 and 24 hours -> evaluate nudge window & count
    if (hoursSinceAbandonment >= 1 && hoursSinceAbandonment <= 24) {
      if (transaction.nudgeCount >= policyConfig.maxNudges) {
        return {
          action: 'stop_unrecoverable',
          requiresApproval: false,
          blockedByCompliance: false,
          reason: 'abandonment recovery window expired',
          policyVersion,
          ruleId: 'R8_CART_WINDOW_EXPIRED',
          holdReason: null,
          resumeAtHour: null,
        };
      }

      const inWindow =
        currentHour >= policyConfig.nudgeWindowStartHour &&
        currentHour < policyConfig.nudgeWindowEndHour;

      if (inWindow) {
        return {
          action: 'send_nudge',
          requiresApproval: false,
          blockedByCompliance: false,
          reason: 'cart abandonment recovery nudge, within compliant window',
          policyVersion,
          ruleId: 'R8_CART_NUDGE',
          holdReason: null,
          resumeAtHour: null,
        };
      } else {
        return {
          action: 'no_action',
          requiresApproval: false,
          blockedByCompliance: true,
          reason:
            'outside compliant nudge window (TRAI SMS timing rules), deferred to next window',
          policyVersion,
          ruleId: 'R8_CART_TRAI_WINDOW',
          holdReason: 'trai_window_closed',
          resumeAtHour: policyConfig.nudgeWindowStartHour,
        };
      }
    }

    // Case 3: > 24 hours with no recovery -> stop_unrecoverable
    if (hoursSinceAbandonment > 24) {
      return {
        action: 'stop_unrecoverable',
        requiresApproval: false,
        blockedByCompliance: false,
        reason: 'abandonment recovery window expired',
        policyVersion,
        ruleId: 'R8_CART_WINDOW_EXPIRED',
        holdReason: null,
        resumeAtHour: null,
      };
    }
  }

  // Rule 9: Default fallback
  return {
    action: 'no_action',
    requiresApproval: false,
    blockedByCompliance: false,
    reason: 'no applicable policy rule matched',
    policyVersion,
    ruleId: 'R9_NO_RULE_MATCHED',
    holdReason: 'no_rule_matched',
    resumeAtHour: null,
  };
}
