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

export type PolicyDecision = {
  action: PolicyAction;
  requiresApproval: boolean;
  blockedByCompliance: boolean;
  reason: string;
  policyVersion: string;
};

/**
 * Diagnose a transaction and decide the appropriate recovery action.
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
export function diagnoseAndDecide(
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
    };
  }

  // Rule 3: Subscription above merchant AFA threshold — requires customer authentication
  if (
    transaction.type === 'subscription' &&
    transaction.amountPaise > policyConfig.afaThresholdPaise
  ) {
    return {
      action: 'request_approval',
      requiresApproval: true,
      blockedByCompliance: false,
      reason:
        `merchant policy threshold requires customer authentication above ₹` +
        `${policyConfig.afaThresholdPaise / 100}` +
        ` (see RBI e-mandate framework documentation)`,
      policyVersion,
    };
  }

  // Rule 4: Retry and nudge limits exhausted
  const isTransientSource = ['gateway', 'razorpay'].includes(transaction.source);
  const isExhausted =
    (isTransientSource && transaction.retryCount >= effectiveMaxRetries) ||
    (transaction.retryCount >= effectiveMaxRetries &&
      transaction.nudgeCount >= policyConfig.maxNudges);

  if (isExhausted) {
    return {
      action: 'stop_unrecoverable',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: 'exhausted retry and nudge limits',
      policyVersion,
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
      };
    } else {
      return {
        action: 'no_action',
        requiresApproval: false,
        blockedByCompliance: true,
        reason:
          'outside compliant nudge window (TRAI SMS timing rules), deferred to next window',
        policyVersion,
      };
    }
  }

  // Rule 7: Card-related issues — request payment method update (no retry, it would fail identically)
  const cardReasonCodes = [
    'card_declined',
    'authentication_failed',
    'card_expired',
  ];
  if (
    cardReasonCodes.includes(transaction.reasonCode) &&
    transaction.nudgeCount < 1
  ) {
    return {
      action: 'send_nudge',
      requiresApproval: false,
      blockedByCompliance: false,
      reason:
        'card issue, requesting customer update payment method, no retry (would fail identically)',
      policyVersion,
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
        };
      } else {
        return {
          action: 'no_action',
          requiresApproval: false,
          blockedByCompliance: true,
          reason:
            'outside compliant nudge window (TRAI SMS timing rules), deferred to next window',
          policyVersion,
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
  };
}
