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
};

export type PolicyConfigInput = {
  afaThresholdPaise: number;
  maxRetries: number;
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
};

/**
 * Diagnose a transaction and decide the appropriate recovery action.
 *
 * Priority order (STRICT — first match wins, never reorder):
 *   1. Already recovered → no_action
 *   2. Blocked reason codes → stop_unrecoverable
 *   3. Subscription above AFA threshold → request_approval
 *   4. Both retry and nudge limits exhausted → stop_unrecoverable
 *   5. Transient gateway/razorpay error within retry limit → auto_retry
 *   6. Customer insufficient_funds within nudge limit → send_nudge (or defer)
 *   7. Card-related error within first nudge → send_nudge
 *   8. Default fallback → no_action
 */
export function diagnoseAndDecide(
  transaction: TransactionInput,
  policyConfig: PolicyConfigInput,
  currentHour: number,
): PolicyDecision {
  // Rule 1: Already resolved
  if (transaction.status === 'recovered') {
    return {
      action: 'no_action',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: 'already resolved',
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
    };
  }

  // Rule 4: Retry and nudge limits exhausted
  const isTransientSource = ['gateway', 'razorpay'].includes(transaction.source);
  const isExhausted =
    (isTransientSource && transaction.retryCount >= policyConfig.maxRetries) ||
    (transaction.retryCount >= policyConfig.maxRetries &&
      transaction.nudgeCount >= policyConfig.maxNudges);

  if (isExhausted) {
    return {
      action: 'stop_unrecoverable',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: 'exhausted retry and nudge limits',
    };
  }

  // Rule 5: Transient gateway/razorpay error — auto-retry if within limit
  const transientSources = ['gateway', 'razorpay'];
  if (
    transientSources.includes(transaction.source) &&
    transaction.retryCount < policyConfig.maxRetries
  ) {
    return {
      action: 'auto_retry',
      requiresApproval: false,
      blockedByCompliance: false,
      reason: `transient ${transaction.source} error, auto-retry within limit`,
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
      };
    } else {
      return {
        action: 'no_action',
        requiresApproval: false,
        blockedByCompliance: true,
        reason:
          'outside compliant nudge window (TRAI SMS timing rules), deferred to next window',
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
    };
  }

  // Rule 8: Default fallback
  return {
    action: 'no_action',
    requiresApproval: false,
    blockedByCompliance: false,
    reason: 'no applicable policy rule matched',
  };
}
