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
 *
 * Transaction state machine:
 *  - Every one of the five policy actions resolves to exactly one of the five
 *    documented statuses (see `resolveState`). A suppressed action is persisted
 *    as `deferred` with a named `holdReason` and, where one exists, a concrete
 *    `deferredUntil` — so "waiting on the customer", "TRAI forbids contact until
 *    10:00 IST", and "we tried and it failed" are three distinct, queryable
 *    states rather than one undifferentiated `failed`.
 */

import 'dotenv/config';
import { Transaction } from '@prisma/client';
import { prisma } from './prisma';
import type { PolicyDecision, PolicyHoldReason, RouteDecision } from './policy-engine';
import {
  createPaymentLink,
  hasValidRazorpayKeys,
} from './razorpay';

/**
 * How a decision is carried out.
 *
 *  live     — real outbound calls where credentials allow (creates Razorpay
 *             Payment Links), then persists the resulting state.
 *  simulate — no outbound calls; the deterministic simulation produces the
 *             outcome, and the resulting state IS persisted. This is what the
 *             offline benchmark uses.
 *  dry_run  — no outbound calls AND no database write. Computes the complete
 *             result, including the state that *would* have been persisted, and
 *             returns it untouched.
 *
 * `dry_run` exists because the compliance suite exercises real benchmark rows
 * rather than demo artifacts. It was previously safe only by accident: the
 * `no_action` branch wrote nothing at all, so nothing could be corrupted.
 * Completing the state machine removes that accident — `no_action` now persists
 * `deferred` — so any test that asserts on a decision without intending to
 * mutate the frozen 65-row dataset must say so explicitly.
 */
export type ExecutionMode = 'live' | 'simulate' | 'dry_run';

/**
 * Why a transaction is parked, as persisted to `Transaction.holdReason`.
 *
 * A superset of the policy engine's hold reasons: the engine explains why it
 * *suppressed* an action, while the executor also has to explain why a
 * *dispatched* action has not resolved yet.
 */
export type TransactionHoldReason =
  | PolicyHoldReason // 'trai_window_closed' | 'cart_too_fresh' | 'no_rule_matched'
  | 'awaiting_customer_payment' // dunning message delivered, customer has not paid
  | 'awaiting_customer_afa' // RBI e-mandate authentication requested, not completed
  | 'awaiting_gateway_capture'; // live Razorpay Payment Link open, no webhook yet

/** The exact transaction state an execution resolved to. */
export type PersistedState = {
  status: string;
  holdReason: TransactionHoldReason | null;
  deferredUntil: Date | null;
};

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
  /**
   * True when this outcome came from the deterministic offline simulation rather
   * than a confirmed live gateway call. Distinct from `simulatedFallback`, which
   * is the narrower "a live call was attempted and threw". Written straight to
   * `AuditLog.simulated` so a reader never has to guess whether a row describes
   * real money movement.
   */
  simulated: boolean;
  /** The actual cause of that failure, so callers can persist it. */
  fallbackError?: string;
  externalPaymentId?: string;
  razorpayDetails?: {
    paymentLinkId: string;
    shortUrl: string;
    status: string;
    amount: number | string;
  };
  /**
   * The state this execution resolved the transaction to — the same values that
   * were written to the database, or would have been under `dry_run`. Returned
   * so callers can audit and assert on the state transition without a re-read.
   * Null only when the transaction was deliberately left untouched.
   */
  persistedState: PersistedState | null;
  /** Whether the state change above was actually committed. False under `dry_run`. */
  statePersisted: boolean;
  /** Dunning channel this execution used. */
  channel: 'sms' | 'whatsapp' | 'upi_intent' | 'gateway_link' | 'none';
  /** Messaging spend incurred, in paise. Feeds the net-margin rollup. */
  messagingCostPaise: number;
  /**
   * The exact message dispatched, including its DLT header, template id and UPI
   * Intent link. Null for actions that send nothing.
   */
  dunningMessage: DunningMessage | null;
  /** The rail the Smart Optimizer chose, when health telemetry was available. */
  routing: RouteDecision | null;
};

/** Per-message dunning costs in paise, as billed by Indian aggregators. */
export const MESSAGING_COST_PAISE = {
  sms: 12, // ₹0.12 transactional SMS
  whatsapp: 48, // ₹0.48 WhatsApp Business utility template
  upi_intent: 0, // deep link embedded in an existing message
  gateway_link: 0, // Razorpay Payment Link creation is not billed per link
  none: 0,
} as const;

/** IST is UTC+5:30 year-round — India observes no daylight saving. */
export const IST_UTC_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** How long a dispatched dunning message is given before it counts as ignored. */
const NUDGE_FOLLOW_UP_HOURS = 24;
/** How long a customer is given to complete RBI e-mandate authentication. */
const AFA_AUTHENTICATION_WINDOW_HOURS = 24;
/**
 * How long an open Razorpay Payment Link is considered live. Razorpay links have
 * no expiry unless `expire_by` is set, and `createPaymentLink` does not set one,
 * so this is our own follow-up horizon rather than a gateway guarantee.
 */
const PAYMENT_LINK_OPEN_HOURS = 24;
/** Rule 8's cooling-off period before a fresh cart may be nudged. */
const CART_COOLDOWN_HOURS = 1;

const HOUR_MS = 60 * 60 * 1000;

/**
 * The next instant at which an IST wall-clock hour occurs, at or after `from`.
 *
 * Used to turn the policy engine's `resumeAtHour` (an IST hour, e.g. 10 for the
 * TRAI window opening) into a concrete timestamp, so a compliance hold records
 * *when* it releases rather than just that it is held.
 */
export function nextIstHourInstant(istHour: number, from: Date): Date {
  // Shifting by the offset makes the UTC field accessors spell the IST wall clock.
  const istNow = new Date(from.getTime() + IST_UTC_OFFSET_MS);
  const sameDay = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    istHour,
    0,
    0,
    0,
  );
  const target = sameDay <= istNow.getTime() ? sameDay + 24 * HOUR_MS : sameDay;
  return new Date(target - IST_UTC_OFFSET_MS);
}

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

// ─── India dunning: DLT-registered templates and UPI Intent deep links ───────
//
// TRAI's TCCCPR 2018 does not merely restrict *when* a commercial SMS may be
// sent. It restricts *what* may be sent and *by whom*: every message must
// originate from a Header (sender ID) registered on a DLT platform against the
// principal entity, and its body must match a content template pre-registered
// against that header, with variable slots written `{#var#}`. An unregistered
// header or an off-template body is scrubbed by the operator before delivery, so
// a dunning system that composes free text at runtime silently loses messages.
//
// Categories matter too. `transactional` is reserved for OTP-class traffic from
// regulated entities and is exempt from the time restriction; `service_implicit`
// covers a customer-triggered event; `service_explicit` covers a message the
// customer consented to but did not directly trigger. A payment-recovery nudge
// is service-explicit, which is precisely why the 10:00–21:00 gate in the policy
// engine applies to it — a transactional classification would sidestep the
// window, and claiming one for dunning traffic is the exact misuse the DLT
// registry exists to prevent.
//
// WhatsApp is not an SMS channel and is not governed by DLT at all — it is
// governed by Meta's Business Platform utility-template policy, with `{{1}}`
// placeholders rather than `{#var#}`. This system applies the same contact window
// to both as a deliberate merchant-policy choice: one compliance envelope is
// easier to defend than two, and the stricter of the two is the safe one.

/** DLT header registered against the principal entity for recovery traffic. */
export const DLT_SENDER_HEADER = 'RAZORP-REC';

/**
 * Registered content template ids.
 *
 * Illustrative: a real template id is a 19-digit number minted by the DLT
 * operator when the template is approved, so these stand in for ids this project
 * has no way to hold. The template *bodies* below are real DLT-shaped templates.
 */
export const DLT_TEMPLATE_IDS = {
  cart_recovery: '1107169284410000001',
  low_balance: '1107169284410000002',
  card_update: '1107169284410000003',
  generic_recovery: '1107169284410000004',
  mandate_approval: '1107169284410000005',
} as const;

/** Merchant VPA that UPI Intent collections settle into. */
export const UPI_MERCHANT_VPA = process.env.UPI_MERCHANT_VPA ?? 'recoverai@razorpay';
export const UPI_MERCHANT_NAME = process.env.UPI_MERCHANT_NAME ?? 'RecoverAI Commerce';
/** MCC 5411 — grocery/retail. Sent as `mc` so payer apps show the right category. */
export const UPI_MERCHANT_CATEGORY_CODE = '5411';

/** Base for the tokenised recovery shortlink embedded in every dunning message. */
const RECOVERY_LINK_BASE = process.env.RECOVERY_LINK_BASE ?? 'https://rzp.io/rcv';

/** How long a dunning shortlink stays valid, used for the urgency countdown. */
const DUNNING_LINK_VALIDITY_HOURS = 24;

export type DunningChannel = 'sms' | 'whatsapp';

export type DunningMessage = {
  channel: DunningChannel;
  /** DLT header for SMS; the WhatsApp display name acts as the header equivalent. */
  header: string;
  templateId: string;
  /** DLT/Meta category this template is registered under. */
  category: 'service_explicit' | 'service_implicit' | 'transactional' | 'utility';
  /** Template exactly as registered, placeholders unsubstituted. */
  template: string;
  /** Values substituted into the placeholders, in order. */
  variables: string[];
  /** The message as the customer receives it. */
  body: string;
  /** NPCI UPI Intent deep link, or null on channels that cannot carry one. */
  upiIntentUrl: string | null;
  shortlink: string;
  /** Reference echoed back by the PSP, so a UPI credit reconciles to this debt. */
  transactionRef: string;
  costPaise: number;
  expiresInHours: number;
};

/**
 * Build an NPCI UPI Intent deep link.
 *
 * Parameters follow the UPI Linking Specification: `pa` payee VPA and `pn` payee
 * name are mandatory, `am` is rupees to two decimals (never paise), `cu` must be
 * INR, `tr` is the merchant transaction reference capped at 35 characters, `tn` a
 * ≤50-character note, and `mc` the 4-digit merchant category code.
 *
 * Note what `pa` is and is not: it is the *payee*. A UPI intent cannot select the
 * customer's bank or PSP — that choice lives inside whichever app resolves the
 * link. So when the Smart Optimizer recommends a rail, it shapes the guidance
 * text, never these parameters. Encoding a routing preference into `pa` would
 * silently redirect the money to the wrong payee.
 */
export function buildUpiIntentUrl(opts: {
  amountPaise: number;
  transactionRef: string;
  note: string;
  vpa?: string;
  payeeName?: string;
}): string {
  const params = new URLSearchParams({
    pa: opts.vpa ?? UPI_MERCHANT_VPA,
    pn: opts.payeeName ?? UPI_MERCHANT_NAME,
    am: (opts.amountPaise / 100).toFixed(2),
    cu: 'INR',
    tr: opts.transactionRef.slice(0, 35),
    tn: opts.note.slice(0, 50),
    mc: UPI_MERCHANT_CATEGORY_CODE,
  });
  return `upi://pay?${params.toString()}`;
}

/** Reference that reconciles a UPI credit back to this debt. Alphanumeric only. */
export function dunningTransactionRef(transaction: Transaction): string {
  return `RCV${transaction.id.slice(-10).toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
}

function formatInr(amountPaise: number): string {
  return `₹${(amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

type TemplateShape = {
  key: keyof typeof DLT_TEMPLATE_IDS;
  /** Placeholders as `%1`..`%n`; rendered per channel into `{#var#}` or `{{n}}`. */
  sms: string;
  whatsapp: string;
};

/**
 * One registered template per failure class.
 *
 * Kept short on purpose: a DLT template counts against the 160-character GSM-7
 * segment, and a two-segment dunning SMS costs twice as much for no extra
 * recovery. The WhatsApp variant carries the detail the SMS cannot afford.
 */
function selectTemplate(transaction: Transaction): TemplateShape {
  if (transaction.type === 'checkout_abandon') {
    return {
      key: 'cart_recovery',
      sms: 'Your %1 cart is still reserved. Complete payment: %2 Ref %3 - %4',
      whatsapp:
        'Hi! Your order of *%1* is still reserved but payment is not complete.\n\n' +
        'Recommended: %4 — one tap, no card details needed.\n' +
        'Reference: %3\n' +
        'This link expires in %5 hours.\n\n' +
        '%2',
    };
  }

  if (transaction.type === 'subscription') {
    return {
      key: 'mandate_approval',
      sms: 'Approve your %1 subscription debit (RBI e-mandate AFA): %2 Ref %3 - %4',
      whatsapp:
        'Your subscription renewal of *%1* needs your one-time approval.\n\n' +
        'RBI e-mandate rules require additional factor authentication for recurring ' +
        'debits above the mandate threshold, so this cannot be auto-charged.\n' +
        'Recommended: %4\n' +
        'Reference: %3\n' +
        'Approval window closes in %5 hours.\n\n' +
        '%2',
    };
  }

  if (transaction.reasonCode === 'insufficient_funds') {
    return {
      key: 'low_balance',
      sms: 'Payment of %1 failed - low balance. Retry via UPI: %2 Ref %3 - %4',
      whatsapp:
        'Your payment of *%1* could not be completed because the account had ' +
        'insufficient balance.\n\n' +
        'Recommended: %4 — UPI clears instantly from any account you hold, with no ' +
        'card details needed.\n' +
        'Reference: %3\n' +
        'Retry link valid for %5 hours.\n\n' +
        '%2',
    };
  }

  if (['card_declined', 'authentication_failed', 'card_expired'].includes(transaction.reasonCode)) {
    return {
      key: 'card_update',
      sms: 'Card payment of %1 declined. Update or pay by UPI: %2 Ref %3 - %4',
      whatsapp:
        'Your card payment of *%1* was declined by the issuing bank.\n\n' +
        'Retrying the same card will fail identically, so either update the card or ' +
        'use another rail.\n' +
        'Recommended: %4\n' +
        'Reference: %3\n' +
        'Link expires in %5 hours.\n\n' +
        '%2',
    };
  }

  return {
    key: 'generic_recovery',
    sms: 'Payment of %1 is pending. Complete it here: %2 Ref %3 - %4',
    whatsapp:
      'Your payment of *%1* is still pending.\n\n' +
      'Recommended: %4\n' +
      'Reference: %3\n' +
      'Link expires in %5 hours.\n\n' +
      '%2',
  };
}

/** DLT registers slots positionally as `{#var#}`; Meta registers them as `{{n}}`. */
function toRegisteredTemplate(raw: string, channel: DunningChannel): string {
  return channel === 'sms'
    ? raw.replace(/%\d/g, '{#var#}')
    : raw.replace(/%(\d)/g, (_m, n) => `{{${n}}}`);
}

/**
 * The slots a template actually declares, in ascending order.
 *
 * `variables` has to be exactly what is bound to the registered template, not a
 * superset — a DLT template approved with four slots is rejected if five values
 * arrive, and the SMS variants deliberately omit the countdown because a second
 * GSM-7 segment doubles the price for no extra recovery.
 */
function declaredSlots(raw: string): number[] {
  const found = new Set<number>();
  for (const match of raw.matchAll(/%(\d)/g)) found.add(Number(match[1]));
  return [...found].sort((a, b) => a - b);
}

function render(raw: string, valueBySlot: string[]): string {
  return raw.replace(/%(\d)/g, (_m, n) => valueBySlot[Number(n) - 1] ?? '');
}

/**
 * Compose the exact dunning message a nudge or approval request would deliver.
 *
 * Exported so the dashboard can preview the real artefact — header, template id,
 * placeholder shape, rendered body and UPI intent — rather than a mock-up of one.
 * When the Smart Optimizer has an opinion, the guidance line names the rail it
 * recommends; the routing never touches the UPI parameters themselves.
 */
export function composeDunningMessage(
  transaction: Transaction,
  opts: { channel: DunningChannel; route?: RouteDecision | null },
): DunningMessage {
  const { channel, route } = opts;
  const shape = selectTemplate(transaction);
  const amountStr = formatInr(transaction.amountPaise);
  const transactionRef = dunningTransactionRef(transaction);
  const shortlink = `${RECOVERY_LINK_BASE}/${transaction.id.slice(-8)}`;

  // A routing recommendation the customer can act on: name the rail. A retry of
  // the same rail has nothing to add, so it contributes no guidance at all.
  const railHint =
    route?.rerouted && route.recommended
      ? route.recommended.method === 'upi'
        ? `Pay via UPI (${route.recommended.instrument})`
        : `Use ${route.recommended.instrument} ${route.recommended.method}`
      : 'Pay by UPI or card';

  const valueBySlot = [
    amountStr,
    shortlink,
    transactionRef,
    railHint,
    String(DUNNING_LINK_VALIDITY_HOURS),
  ];

  const raw = channel === 'sms' ? shape.sms : shape.whatsapp;
  const slots = declaredSlots(raw);

  return {
    channel,
    header: DLT_SENDER_HEADER,
    templateId: DLT_TEMPLATE_IDS[shape.key],
    // Recovery messaging is consented-to but not customer-triggered, which is
    // service-explicit and therefore time-restricted. See the block comment above.
    category: channel === 'sms' ? 'service_explicit' : 'utility',
    template: toRegisteredTemplate(raw, channel),
    variables: slots.map((n) => valueBySlot[n - 1]),
    body: render(raw, valueBySlot),
    upiIntentUrl: buildUpiIntentUrl({
      amountPaise: transaction.amountPaise,
      transactionRef,
      note: `Recovery ${transactionRef}`,
    }),
    shortlink,
    transactionRef,
    costPaise: MESSAGING_COST_PAISE[channel],
    expiresInHours: DUNNING_LINK_VALIDITY_HOURS,
  };
}

/**
 * One-line ledger rendering of a dunning message.
 *
 * The audit `reason` column is prose, so the structured message goes in as a
 * single readable line naming the channel, the DLT header and template it was
 * sent under, the body, and the UPI intent — everything an auditor would ask for
 * when checking whether a specific message was compliant.
 */
function describeDunningMessage(message: DunningMessage): string {
  const target = message.channel === 'sms' ? 'SMS to +919876543210' : 'WhatsApp to +919876543210';
  const oneLineBody = message.body.replace(/\s*\n+\s*/g, ' ');
  return (
    `${target} [DLT ${message.header} / template ${message.templateId} / ${message.category}]: ` +
    `"${oneLineBody}" | UPI Intent: ${message.upiIntentUrl}`
  );
}

/**
 * Simulate non-auto_retry actions or fallback when Razorpay credentials are not provided.
 *
 * `dunning` is the message the executor already composed for this action, passed
 * in rather than rebuilt here so the note, the channel and the billed cost can
 * never describe different messages.
 */
function simulateOutcome(
  transaction: Transaction,
  decision: PolicyDecision,
  dunning: DunningMessage | null,
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
      const smsText = dunning
        ? describeDunningMessage(dunning)
        : 'Dunning message not composed (no channel resolved).';
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
      const smsText = dunning
        ? describeDunningMessage(dunning)
        : 'Approval request not composed (no channel resolved).';
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
 * Terminal states. Once a transaction reaches one, no execution may move it —
 * a later `no_action` ruling must not overwrite collected money or a deliberate
 * write-off with a hold.
 */
const TERMINAL_STATUSES = new Set(['recovered', 'unrecoverable']);

/**
 * Resolve the transaction state an execution lands in.
 *
 * Every one of the five policy actions is mapped, which is the point: previously
 * `no_action` had no branch at all and `send_nudge`/`request_approval` had one
 * only for the recovery case, so a deferred compliance hold and a dispatched-but-
 * unanswered nudge both left the row sitting in raw `failed`. The dashboard then
 * could not tell "we tried and gave up" from "we are waiting on the customer"
 * from "TRAI forbids us from contacting them until 10:00" — three completely
 * different operational situations sharing one status.
 *
 *   action              recovered  live link │ status         holdReason                  deferredUntil
 *   ───────────────────────────────────────────────────────────────────────────────────────────────────
 *   auto_retry          yes        ·         │ recovered      —                           —
 *   auto_retry          no         yes       │ pending        awaiting_gateway_capture    +24h
 *   auto_retry          no         no        │ failed         —                           —
 *   send_nudge          yes        ·         │ recovered      —                           —
 *   send_nudge          no         ·         │ pending        awaiting_customer_payment   +24h
 *   request_approval    yes        ·         │ recovered      —                           —
 *   request_approval    no         ·         │ pending        awaiting_customer_afa       +24h
 *   stop_unrecoverable  ·          ·         │ unrecoverable  —                           —
 *   no_action  TRAI     ·          ·         │ deferred       trai_window_closed          next 10:00 IST
 *   no_action  cart     ·          ·         │ deferred       cart_too_fresh              abandonedAt +1h
 *   no_action  default  ·          ·         │ deferred       no_rule_matched             — (unbounded)
 *   no_action  resolved ·          ·         │ (left untouched — terminal)
 *
 * Returns null when the transaction must be left exactly as it is.
 */
function resolveState(
  decision: PolicyDecision,
  transaction: Transaction,
  recovered: boolean,
  hasLiveLink: boolean,
  now: Date,
): PersistedState | null {
  const { action, holdReason } = decision;

  if (recovered) {
    return { status: 'recovered', holdReason: null, deferredUntil: null };
  }

  switch (action) {
    case 'auto_retry':
      return hasLiveLink
        ? {
            status: 'pending',
            holdReason: 'awaiting_gateway_capture',
            deferredUntil: new Date(now.getTime() + PAYMENT_LINK_OPEN_HOURS * HOUR_MS),
          }
        : // The attempt ran and produced nothing. No hold: there is nothing to
          // wait for, only the next policy pass to decide whether another retry
          // is still budgeted for this customer tier.
          { status: 'failed', holdReason: null, deferredUntil: null };

    case 'send_nudge':
      return {
        status: 'pending',
        holdReason: 'awaiting_customer_payment',
        deferredUntil: new Date(now.getTime() + NUDGE_FOLLOW_UP_HOURS * HOUR_MS),
      };

    case 'request_approval':
      return {
        status: 'pending',
        holdReason: 'awaiting_customer_afa',
        deferredUntil: new Date(now.getTime() + AFA_AUTHENTICATION_WINDOW_HOURS * HOUR_MS),
      };

    case 'stop_unrecoverable':
      return { status: 'unrecoverable', holdReason: null, deferredUntil: null };

    case 'no_action': {
      // Rule 1 fires on an already-recovered transaction; Rule 9 can fire on one
      // already written off. Neither may be dragged back into a hold.
      if (TERMINAL_STATUSES.has(transaction.status)) return null;

      if (holdReason === 'trai_window_closed') {
        return {
          status: 'deferred',
          holdReason,
          deferredUntil:
            decision.resumeAtHour !== null
              ? nextIstHourInstant(decision.resumeAtHour, now)
              : null,
        };
      }

      if (holdReason === 'cart_too_fresh') {
        const abandonedAt = transaction.abandonedAt ?? transaction.createdAt;
        return {
          status: 'deferred',
          holdReason,
          deferredUntil: new Date(abandonedAt.getTime() + CART_COOLDOWN_HOURS * HOUR_MS),
        };
      }

      if (holdReason === 'issuer_downtime') {
        // The Smart Optimizer refused to spend a retry into a dead rail. The
        // release time is the operator's own ETA for the rail returning, so the
        // hold expires on the outage rather than on a guess of ours.
        const eta = decision.routing?.estimatedRecoveryMinutes ?? null;
        return {
          status: 'deferred',
          holdReason,
          deferredUntil: eta !== null ? new Date(now.getTime() + eta * 60 * 1000) : null,
        };
      }

      // Nothing in policy applies. Still an explicit hold rather than a silent
      // `failed`, but with no release time we can honestly name.
      return { status: 'deferred', holdReason: holdReason ?? 'no_rule_matched', deferredUntil: null };
    }

    default:
      return null;
  }
}

/**
 * Which channel a dunning message goes out on.
 *
 * A cheap channel first, the expensive rich one only when the cheap one was
 * ignored. SMS costs ₹0.12 and gets 160 GSM-7 characters; a WhatsApp utility
 * template costs 4× that and carries formatting, a tappable UPI link and enough
 * room to explain *why* the payment failed. Opening on WhatsApp would spend 4×
 * the budget on the customers who would have paid from a one-line SMS, which is
 * how a dunning programme posts a negative ROI while looking sophisticated.
 */
function resolveDunningChannel(transaction: Transaction): DunningChannel {
  return transaction.nudgeCount >= 1 ? 'whatsapp' : 'sms';
}

/** The channel an action was delivered over, for cost and compliance rollups. */
function resolveChannel(
  action: string,
  hasLiveLink: boolean,
  transaction: Transaction,
): ExecutionResult['channel'] {
  if (action === 'send_nudge' || action === 'request_approval') {
    return resolveDunningChannel(transaction);
  }
  if (action === 'auto_retry') return hasLiveLink ? 'gateway_link' : 'none';
  return 'none';
}

/**
 * Execute a policy decision against a transaction.
 * Updates the transaction record in the database and returns the result.
 * This is the single write-gatekeeper for transaction state.
 */
export async function executeAction(
  decision: PolicyDecision,
  transaction: Transaction,
  executionMode: ExecutionMode = 'live',
): Promise<ExecutionResult> {
  const { action } = decision;
  const now = new Date();

  let recovered = false;
  let recoveredAmountPaise: number | null = null;
  let outcome = 'deferred';
  let note = '';
  let success = true;
  let simulatedFallback = false;
  let fallbackError: string | undefined = undefined;
  let updatedExternalPaymentId: string | undefined = undefined;
  let razorpayDetails: any = undefined;

  // Compose the outbound message once, before anything can branch. Both the
  // ledger note and the billed cost then describe the same artefact — previously
  // the note was built inside the simulation while the cost was derived
  // separately afterwards, so the two could disagree about the channel.
  const dunning =
    action === 'send_nudge' || action === 'request_approval'
      ? composeDunningMessage(transaction, {
          channel: resolveDunningChannel(transaction),
          route: decision.routing ?? null,
        })
      : null;

  // 1. Live Razorpay API Execution for auto_retry
  if (action === 'auto_retry' && executionMode === 'live' && hasValidRazorpayKeys()) {
    try {
      const route = decision.routing ?? null;
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
          // Razorpay `notes` are returned on every webhook for this link, so
          // stamping the routing decision here means the rail choice arrives back
          // with the settlement event instead of having to be re-derived.
          ...(route
            ? {
                routingStrategy: route.strategy,
                routedFrom: `${route.origin.method}:${route.origin.instrument}`,
                routedTo: route.recommended
                  ? `${route.recommended.method}:${route.recommended.instrument}`
                  : 'none',
              }
            : {}),
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
      const fallback = simulateOutcome(transaction, decision, dunning);
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
    const simulated = simulateOutcome(transaction, decision, dunning);
    recovered = simulated.recovered;
    recoveredAmountPaise = simulated.recoveredAmountPaise;
    outcome = simulated.outcome;
    note = simulated.note;
  }

  // 3. Compute the new transaction state to persist in DB
  const hasLiveLink = Boolean(updatedExternalPaymentId);
  const persistedState = resolveState(decision, transaction, recovered, hasLiveLink, now);

  const updateData: {
    retryCount?: number;
    nudgeCount?: number;
    status?: string;
    recovered?: boolean;
    resolvedAt?: Date | null;
    externalPaymentId?: string;
    holdReason?: string | null;
    deferredUntil?: Date | null;
  } = {};

  if (updatedExternalPaymentId) {
    updateData.externalPaymentId = updatedExternalPaymentId;
  }

  // Attempt counters are incremented for every dispatched attempt, recovered or
  // not — they are the budget the policy engine spends, so they must move even
  // when the attempt achieves nothing.
  if (action === 'auto_retry') {
    updateData.retryCount = transaction.retryCount + 1;
  } else if (action === 'send_nudge' || action === 'request_approval') {
    updateData.nudgeCount = transaction.nudgeCount + 1;
  }

  if (persistedState) {
    updateData.status = persistedState.status;
    updateData.holdReason = persistedState.holdReason;
    updateData.deferredUntil = persistedState.deferredUntil;
    if (persistedState.status === 'recovered') {
      updateData.recovered = true;
      updateData.resolvedAt = now;
    } else if (persistedState.status === 'unrecoverable') {
      updateData.resolvedAt = now;
    }
  }

  // 4. Persist state change to database
  const statePersisted = executionMode !== 'dry_run' && Object.keys(updateData).length > 0;
  if (statePersisted) {
    await prisma.transaction.update({
      where: { id: transaction.id },
      data: updateData,
    });
  }

  const channel = resolveChannel(action, hasLiveLink, transaction);

  return {
    transactionId: transaction.id,
    action,
    success,
    recovered,
    recoveredAmountPaise,
    outcome,
    note,
    simulatedFallback,
    // A live Razorpay object is the only evidence a real outbound call landed.
    // Everything else — every nudge, every approval request, every offline
    // benchmark pass, and every failed live call — is simulation.
    simulated: razorpayDetails === undefined,
    fallbackError,
    externalPaymentId: updatedExternalPaymentId,
    razorpayDetails,
    persistedState,
    statePersisted,
    channel,
    messagingCostPaise: MESSAGING_COST_PAISE[channel],
    dunningMessage: dunning,
    routing: decision.routing ?? null,
  };
}
