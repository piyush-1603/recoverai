/**
 * /lib/action-executor.ts
 *
 * Executes the action decided by the policy engine against a transaction.
 * This is the ONLY module permitted to mutate transaction state in the database.
 * The policy engine and AI advisory agent never touch the DB directly.
 *
 * Live Razorpay Integration:
 *  - When valid Razorpay credentials are present, 'auto_retry' creates a genuine
 *    Razorpay Payment Link (plink_...) and sets status to 'pending', storing the link ID
 *    in `externalPaymentId`.
 *  - Final recovery transition (status: 'recovered') is driven asynchronously by
 *    inbound Razorpay Webhooks (payment.captured / payment_link.paid), ensuring genuine
 *    end-to-end payment confirmation.
 *  - If that live call fails, the deterministic simulation stands in so the
 *    pipeline still produces a trace — but the result is reported as
 *    'retry_simulated_fallback' with success=false and recovered=false, and the
 *    underlying API error is carried in `note` for the audit row. A failed
 *    outbound request is never allowed to look like collected money.
 */

import 'dotenv/config';
import { Transaction } from '@prisma/client';
import { prisma } from './prisma';
import type { PolicyDecision } from './policy-engine';
import {
  createPaymentLink,
  hasValidRazorpayKeys,
} from './razorpay';

export type ExecutionResult = {
  transactionId: string;
  action: string;
  /**
   * True only when the action the policy engine asked for actually completed as
   * requested. A live Razorpay call that threw and fell back to the offline
   * simulation is NOT a success, even though a fallback outcome was produced.
   */
  success: boolean;
  recovered: boolean;
  recoveredAmountPaise: number | null;
  outcome: string;
  note: string;
  /** True when the live Razorpay call failed and the simulation stood in for it. */
  simulatedFallback: boolean;
  /** The actual cause of that failure, so callers can persist it. */
  fallbackError?: string;
  externalPaymentId?: string;
  razorpayDetails?: {
    paymentLinkId: string;
    shortUrl: string;
    status: string;
    amount: number | string;
  };
};

/**
 * Result values reserved for "the live call failed, so this number came from the
 * offline simulation". Deliberately distinct from the simulation's own outcomes:
 * a simulated result reached *after* an API failure is not evidence of anything
 * and must never be presented as a confirmed recovery. Neither value appears in
 * SUCCESSFUL_RECOVERY_OUTCOMES, so reporting and dashboard rollups exclude them.
 */
const FALLBACK_OUTCOMES: Record<string, string> = {
  retry_succeeded: 'retry_simulated_fallback',
  retry_failed: 'retry_simulated_fallback_no_recovery',
};

/**
 * Extracts a human-readable cause from a thrown Razorpay / network error.
 *
 * The Razorpay SDK does not throw `Error` instances for API-level failures — it
 * rejects with a plain object shaped `{ statusCode, error: { code, description,
 * … } }`, and where outbound requests are filtered `error` can be `undefined`
 * altogether. Reading `err?.message` alone therefore yields `undefined`, which
 * is what previously reduced the audit note to "Razorpay call fallback: API
 * error" and discarded the only evidence of what went wrong. Walk every shape
 * the SDK and the runtime can produce before giving up.
 */
function describeApiError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error (nothing thrown)';
  if (typeof err === 'string') return err;

  const e = err as Record<string, any>;
  const parts: string[] = [];

  const description = e.error?.description ?? e.error?.reason ?? e.error?.message;
  if (typeof description === 'string' && description) parts.push(description);
  if (typeof e.message === 'string' && e.message) parts.push(e.message);

  const code = e.error?.code ?? e.code;
  if (code) parts.push(`code=${code}`);

  if (e.statusCode !== undefined) {
    // Flag the bodyless case explicitly — an HTTP status with no payload is the
    // signature of a rejected/filtered request rather than a Razorpay refusal.
    parts.push(
      parts.length
        ? `httpStatus=${e.statusCode}`
        : `httpStatus=${e.statusCode} (no error body returned)`,
    );
  }

  if (parts.length) return parts.join(' | ');

  try {
    const serialised = JSON.stringify(err);
    if (serialised && serialised !== '{}') return serialised;
  } catch {
    /* circular or otherwise unserialisable — fall through */
  }
  return `unserialisable ${typeof err} thrown by the Razorpay client`;
}

/**
 * Ledger suffix carrying the executor's note when — and only when — that note
 * holds something the `result` column cannot: the actual API error behind a
 * simulated fallback.
 *
 * Every `writeEvent` caller used to compute `result.note` and then drop it, so
 * the reason a live call failed never reached the audit row. Appending only on
 * the fallback path keeps the 65 benchmark reason strings unchanged while
 * guaranteeing a real failure is never silently swallowed.
 */
export function auditReasonSuffix(result: ExecutionResult): string {
  if (!result.simulatedFallback) return '';
  return ` [EXECUTOR FALLBACK] ${result.note}`;
}

function composeNudgeMessage(transaction: Transaction): string {
  const amountStr = `₹${(transaction.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  if (transaction.type === 'checkout_abandon') {
    return `SMS to +919876543210: "Hi! You left ${amountStr} in your cart. Complete your purchase here: https://pay.example.com/cart/${transaction.id.slice(-6)}"`;
  }
  if (transaction.reasonCode === 'insufficient_funds') {
    return `SMS to +919876543210: "Your payment of ${amountStr} failed due to low balance. Retry with UPI/card: https://pay.example.com/retry/${transaction.id.slice(-6)}"`;
  }
  if (['card_declined', 'authentication_failed', 'card_expired'].includes(transaction.reasonCode)) {
    return `SMS to +919876543210: "Your card payment of ${amountStr} was declined. Update your payment method: https://pay.example.com/update/${transaction.id.slice(-6)}"`;
  }
  return `SMS to +919876543210: "Payment reminder: Complete your ${amountStr} payment here: https://pay.example.com/pay/${transaction.id.slice(-6)}"`;
}

/**
 * Simulate non-auto_retry actions or fallback when Razorpay credentials are not provided.
 */
function simulateOutcome(
  transaction: Transaction,
  decision: PolicyDecision,
): {
  recovered: boolean;
  recoveredAmountPaise: number | null;
  outcome: string;
  note: string;
} {
  const { action, blockedByCompliance, reason } = decision;
  const { expectedRecoveryOutcome, simulatedRecoveryAmountPaise } = transaction;

  switch (action) {
    case 'no_action':
      return {
        recovered: false,
        recoveredAmountPaise: null,
        outcome: blockedByCompliance ? 'compliance_deferred' : 'deferred',
        note: blockedByCompliance
          ? '[COMPLIANCE HOLD] SMS NOT sent — outside compliant window (TRAI SMS rules 10:00–21:00 IST), deferred to next window.'
          : (reason || 'No action taken; transaction remains in current state.'),
      };

    case 'stop_unrecoverable':
      return {
        recovered: false,
        recoveredAmountPaise: null,
        outcome: 'marked_unrecoverable',
        note: `[POLICY STOP] ${reason || 'Transaction marked unrecoverable per policy.'}`,
      };

    case 'auto_retry': {
      const succeeded =
        expectedRecoveryOutcome === 'recovers_on_retry' &&
        simulatedRecoveryAmountPaise !== null;
      return {
        recovered: succeeded,
        recoveredAmountPaise: succeeded ? simulatedRecoveryAmountPaise : null,
        outcome: succeeded ? 'retry_succeeded' : 'retry_failed',
        note: succeeded
          ? `Auto-retry succeeded; recovered ₹${(simulatedRecoveryAmountPaise! / 100).toFixed(2)}.`
          : 'Auto-retry did not recover payment (expected outcome: never_recovers).',
      };
    }

    case 'send_nudge': {
      const succeeded =
        expectedRecoveryOutcome === 'recovers_on_nudge' &&
        simulatedRecoveryAmountPaise !== null;
      const smsText = composeNudgeMessage(transaction);
      return {
        recovered: succeeded,
        recoveredAmountPaise: succeeded ? simulatedRecoveryAmountPaise : null,
        outcome: succeeded ? 'nudge_led_to_recovery' : 'nudge_sent_no_recovery',
        note: succeeded
          ? `${smsText} [Customer clicked link & recovered ₹${(simulatedRecoveryAmountPaise! / 100).toFixed(2)}]`
          : `${smsText} [Awaiting customer response / payment still pending]`,
      };
    }

    case 'request_approval': {
      const succeeded =
        expectedRecoveryOutcome === 'requires_approval_then_recovers' &&
        simulatedRecoveryAmountPaise !== null;
      const amountStr = `₹${(transaction.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
      const smsText = `SMS to +919876543210: "Action Required: Approve recurring subscription of ${amountStr} per RBI e-mandate guidelines: https://pay.example.com/approve/${transaction.id.slice(-6)}"`;
      return {
        recovered: succeeded,
        recoveredAmountPaise: succeeded ? simulatedRecoveryAmountPaise : null,
        outcome: succeeded ? 'approval_granted_recovered' : 'approval_pending',
        note: succeeded
          ? `${smsText} [Customer authenticated approval & recovered ₹${(simulatedRecoveryAmountPaise! / 100).toFixed(2)}]`
          : `${smsText} [Awaiting customer 2FA authentication]`,
      };
    }

    default:
      return {
        recovered: false,
        recoveredAmountPaise: null,
        outcome: 'unknown_action',
        note: `Unknown action "${action}" — no operation performed.`,
      };
  }
}

/**
 * Execute a policy decision against a transaction.
 * Updates the transaction record in the database and returns the result.
 * This is the single write-gatekeeper for transaction state.
 */
export async function executeAction(
  decision: PolicyDecision,
  transaction: Transaction,
  executionMode: 'live' | 'simulate' = 'live',
): Promise<ExecutionResult> {
  const { action } = decision;

  let recovered = false;
  let recoveredAmountPaise: number | null = null;
  let outcome = 'deferred';
  let note = '';
  let success = true;
  let simulatedFallback = false;
  let fallbackError: string | undefined = undefined;
  let updatedExternalPaymentId: string | undefined = undefined;
  let razorpayDetails: any = undefined;

  // 1. Live Razorpay API Execution for auto_retry
  if (action === 'auto_retry' && executionMode === 'live' && hasValidRazorpayKeys()) {
    try {
      const link = await createPaymentLink(
        transaction.amountPaise,
        `Payment recovery retry for invoice ${transaction.id.slice(-8).toUpperCase()}`,
        {
          name: `Customer ${transaction.customerId}`,
          email: `${transaction.customerId}@example.com`,
          contact: '+919876543210',
        },
        {
          transactionId: transaction.id,
          merchantReference: `rcv_${transaction.id.slice(0, 20)}`,
          originalReason: transaction.reasonCode,
        },
        `rcv_${transaction.id.slice(0, 18)}_${Date.now().toString(36)}`,
      );

      updatedExternalPaymentId = link.id;
      razorpayDetails = {
        paymentLinkId: link.id,
        shortUrl: link.short_url,
        status: link.status,
        amount: link.amount,
      };

      // State is pending until real webhook payment event is captured
      recovered = false;
      recoveredAmountPaise = null;
      outcome = 'link_created_awaiting_payment';
      note = `Live Razorpay Payment Link created (${link.id}). Checkout URL: ${link.short_url}. Awaiting webhook confirmation.`;
    } catch (err: unknown) {
      const cause = describeApiError(err);
      console.warn(`[ActionExecutor] Razorpay API call failed for ${transaction.id}: ${cause}`);

      // The live call was the only thing that could have produced evidence of a
      // recovery, and it failed. Fall back to the deterministic simulation so
      // the pipeline still yields a decision trace, but report the result for
      // what it is: a simulation reached after an API failure. It is not a
      // success and not a recovery. Leaving `recovered` true here — as this
      // branch previously did — let a blocked outbound request mark money as
      // collected and stamp the transaction 'recovered' in the database.
      const fallback = simulateOutcome(transaction, decision);
      simulatedFallback = true;
      fallbackError = cause;
      success = false;
      recovered = false;
      recoveredAmountPaise = null;
      outcome = FALLBACK_OUTCOMES[fallback.outcome] ?? `${fallback.outcome}_simulated_fallback`;
      note =
        `[SIMULATED FALLBACK — NO LIVE RAZORPAY CALL] Razorpay Payment Link creation failed ` +
        `(${cause}). No live link exists and no payment was confirmed. The offline simulation ` +
        `would have reported "${fallback.outcome}": ${fallback.note}`;
    }
  } else {
    // 2. Simulated execution for nudge, approval, stop_unrecoverable, or offline benchmark
    const simulated = simulateOutcome(transaction, decision);
    recovered = simulated.recovered;
    recoveredAmountPaise = simulated.recoveredAmountPaise;
    outcome = simulated.outcome;
    note = simulated.note;
  }

  // 3. Compute the new transaction state to persist in DB
  const updateData: {
    retryCount?: number;
    nudgeCount?: number;
    status?: string;
    recovered?: boolean;
    resolvedAt?: Date | null;
    externalPaymentId?: string;
  } = {};

  if (updatedExternalPaymentId) {
    updateData.externalPaymentId = updatedExternalPaymentId;
  }

  if (action === 'auto_retry') {
    updateData.retryCount = transaction.retryCount + 1;
    if (recovered) {
      updateData.status = 'recovered';
      updateData.recovered = true;
      updateData.resolvedAt = new Date();
    } else if (updatedExternalPaymentId) {
      updateData.status = 'pending'; // Awaiting customer checkout on real link
    } else {
      updateData.status = 'failed';
    }
  } else if (action === 'send_nudge') {
    updateData.nudgeCount = transaction.nudgeCount + 1;
    if (recovered) {
      updateData.status = 'recovered';
      updateData.recovered = true;
      updateData.resolvedAt = new Date();
    }
  } else if (action === 'stop_unrecoverable') {
    updateData.status = 'unrecoverable';
    updateData.resolvedAt = new Date();
  } else if (action === 'request_approval') {
    updateData.nudgeCount = transaction.nudgeCount + 1;
    if (recovered) {
      updateData.status = 'recovered';
      updateData.recovered = true;
      updateData.resolvedAt = new Date();
    }
  }

  // 4. Persist state change to database
  if (Object.keys(updateData).length > 0) {
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: updateData,
    });
  }

  return {
    transactionId: transaction.id,
    action,
    success,
    recovered,
    recoveredAmountPaise,
    outcome,
    note,
    simulatedFallback,
    fallbackError,
    externalPaymentId: updatedExternalPaymentId,
    razorpayDetails,
  };
}
