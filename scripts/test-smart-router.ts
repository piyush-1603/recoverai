/**
 * /scripts/test-smart-router.ts
 *
 * Covers the Razorpay Smart Optimizer (lib/policy-engine.ts) and the India
 * dunning composer (lib/action-executor.ts).
 *
 * Both are new authority surfaces, so the assertions pin the properties that
 * actually matter rather than the prose:
 *
 *   1. Routing is strictly additive. With no health snapshot the decision is
 *      unchanged and carries no routing — absent telemetry must never be read as
 *      "the rail is fine".
 *   2. A healthy rail is never rerouted.
 *   3. HDFC netbanking down routes to HDFC's OWN UPI handle, not to a bank the
 *      customer has no account with.
 *   4. With every rail at the customer's bank down, it fails over to the best
 *      rail anywhere.
 *   5. With nothing up, an auto_retry is HELD rather than spent — and the hold is
 *      an availability hold, not a compliance one, so the TRAI shield count stays
 *      honest.
 *   6. A nudge is never held for downtime: the customer picks their own rail, and
 *      a compliant contact window that has opened does not reopen later.
 *   7. The UPI Intent link conforms to the NPCI UPI Linking Specification.
 *   8. SMS carries DLT `{#var#}` slots, WhatsApp carries Meta `{{n}}` slots, and
 *      the escalation ladder bills ₹0.12 then ₹0.48.
 *
 * Entirely in-memory: no database reads, no writes, no network. The frozen
 * 65-scenario benchmark cannot be touched by this suite.
 *
 * Run via: npm run test:smart-router
 */

import 'dotenv/config';
import type { Transaction } from '@prisma/client';
import {
  diagnoseAndDecide,
  evaluateSmartRoute,
  resolveOriginRail,
  inferIssuerBank,
  instrumentForBank,
  type GatewayHealthSnapshot,
  type PolicyConfigInput,
  type RailHealth,
  type TransactionInput,
} from '../lib/policy-engine';
import {
  buildUpiIntentUrl,
  composeDunningMessage,
  dunningTransactionRef,
  DLT_SENDER_HEADER,
  MESSAGING_COST_PAISE,
  UPI_MERCHANT_VPA,
} from '../lib/action-executor';
import { getGatewayHealth, setSimulatedDowntimes, restoreDefaultDowntimes } from '../lib/gateway-health';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ PASS  ${label.padEnd(60)} ${detail}`);
  } else {
    failed++;
    console.log(`  ✗ FAIL  ${label.padEnd(60)} ${detail}`);
  }
}

function hr(char = '─', len = 92) {
  return char.repeat(len);
}

const POLICY: PolicyConfigInput = {
  afaThresholdPaise: 1500000,
  maxRetries: 1,
  vipMaxRetries: 3,
  standardMaxRetries: 1,
  trialMaxRetries: 1,
  maxNudges: 2,
  nudgeWindowStartHour: 10,
  nudgeWindowEndHour: 21,
};

/** A customer id that deterministically resolves to HDFC, found by search. */
function customerAtBank(bank: string): string {
  for (let i = 0; i < 5000; i++) {
    const id = `cust_router_${i}`;
    if (inferIssuerBank(id) === bank) return id;
  }
  throw new Error(`No synthetic customer id resolved to ${bank} — the issuer table changed shape.`);
}

/** A transaction that Rule 5 will route to auto_retry. */
function retryableTx(overrides: Partial<TransactionInput> = {}): TransactionInput {
  return {
    id: 'tx_router_001',
    status: 'failed',
    reasonCode: 'bank_technical_error',
    type: 'payment',
    amountPaise: 249900,
    source: 'gateway',
    retryCount: 0,
    nudgeCount: 0,
    customerTier: 'standard',
    customerId: customerAtBank('HDFC'),
    ...overrides,
  };
}

/** Health snapshot with an explicit rail list, everything else absent. */
function snapshot(rails: RailHealth[]): GatewayHealthSnapshot {
  return { capturedAt: new Date().toISOString(), live: false, rails };
}

function rail(
  method: RailHealth['method'],
  instrument: string,
  status: RailHealth['status'],
  successRatePct: number,
  estimatedRecoveryMinutes: number | null = null,
): RailHealth {
  return {
    method,
    instrument,
    status,
    successRatePct,
    severity: status === 'up' ? null : 'high',
    estimatedRecoveryMinutes,
    source: status === 'up' ? 'baseline' : 'downtime_feed',
  };
}

/** Minimal Prisma Transaction for the dunning composer. No DB row is created. */
function dunningTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'clx_router_dunning_0001',
    externalPaymentId: null,
    amountPaise: 249900,
    status: 'failed',
    reasonCode: 'insufficient_funds',
    source: 'customer',
    type: 'payment',
    customerTier: 'standard',
    customerId: 'cust_dunning_001',
    retryCount: 0,
    nudgeCount: 0,
    createdAt: new Date('2026-09-05T08:00:00.000Z'),
    abandonedAt: null,
    resolvedAt: null,
    recovered: false,
    expectedRecoveryOutcome: 'recovers_on_nudge',
    simulatedRecoveryAmountPaise: 249900,
    isDemoArtifact: true,
    holdReason: null,
    deferredUntil: null,
    ...overrides,
  } as Transaction;
}

function run() {
  console.log('\n' + hr('═'));
  console.log('  🧪  TEST: RAZORPAY SMART OPTIMIZER + INDIA DUNNING COMPOSER');
  console.log(hr('═') + '\n');

  const hdfcCustomer = customerAtBank('HDFC');
  const icici = instrumentForBank('ICICI', 'upi');
  const hdfcUpi = instrumentForBank('HDFC', 'upi');

  // ── 1. Routing is additive: no snapshot, no change ──────────────────────────
  console.log('  [1] No health snapshot leaves the decision untouched\n');
  {
    const tx = retryableTx();
    const bare = diagnoseAndDecide(tx, POLICY, 14);
    assert('action is auto_retry', bare.action === 'auto_retry', bare.action);
    assert('ruleId unchanged', bare.ruleId === 'R5_TRANSIENT_RETRY', bare.ruleId);
    assert(
      'routing is absent, not a fabricated "healthy"',
      bare.routing === undefined,
      `routing=${JSON.stringify(bare.routing)}`,
    );
    assert('no hold reason', bare.holdReason === null, `${bare.holdReason}`);
  }

  // ── 2. Origin rail inference from the failure signature ─────────────────────
  console.log('\n  [2] Origin rail inferred from the failure signature\n');
  {
    const cases: Array<[string, string]> = [
      ['bank_technical_error', 'netbanking'],
      ['payment_timed_out', 'upi'],
      ['card_declined', 'card'],
      ['payment_pending_approval', 'emandate'],
    ];
    for (const [reasonCode, expected] of cases) {
      const origin = resolveOriginRail(retryableTx({ reasonCode }));
      assert(`${reasonCode} → ${expected}`, origin.rail.method === expected, origin.rail.method);
      assert(`${reasonCode} marked inferred`, origin.inferred === true, `${origin.inferred}`);
    }

    const explicit = resolveOriginRail(retryableTx({ paymentMethod: 'wallet', issuer: 'PAYTM' }));
    assert(
      'a recorded rail is used verbatim and NOT flagged inferred',
      explicit.rail.method === 'wallet' && explicit.inferred === false,
      `${explicit.rail.method}/${explicit.inferred}`,
    );

    const sameCustomer = retryableTx({ customerId: 'cust_stable_xyz' });
    assert(
      'a customer resolves to the same bank every time',
      resolveOriginRail(sameCustomer).bank === resolveOriginRail(sameCustomer).bank &&
        inferIssuerBank('cust_stable_xyz') === resolveOriginRail(sameCustomer).bank,
      resolveOriginRail(sameCustomer).bank,
    );
  }

  // ── 3. A healthy rail is never rerouted ────────────────────────────────────
  console.log('\n  [3] Healthy origin rail → retry where it failed\n');
  {
    const health = snapshot([rail('netbanking', 'HDFC', 'up', 81.4), rail('upi', hdfcUpi, 'up', 94.6)]);
    const route = evaluateSmartRoute(retryableTx({ customerId: hdfcCustomer }), health);
    assert('strategy is retry_same_rail', route.strategy === 'retry_same_rail', route.strategy);
    assert('rerouted is false', route.rerouted === false);
    assert('uplift is zero', route.upliftPct === 0, `${route.upliftPct}`);
    assert(
      'recommended rail equals the origin rail',
      route.recommended?.method === 'netbanking' && route.recommended?.instrument === 'HDFC',
      `${route.recommended?.method}:${route.recommended?.instrument}`,
    );

    const decision = diagnoseAndDecide(retryableTx({ customerId: hdfcCustomer }), POLICY, 14, undefined, health);
    assert('decision still auto_retry', decision.action === 'auto_retry', decision.action);
    assert('routing attached', decision.routing?.strategy === 'retry_same_rail', `${decision.routing?.strategy}`);
  }

  // ── 4. HDFC netbanking down → HDFC's own UPI handle ────────────────────────
  console.log('\n  [4] Issuer downtime → switch method, keep the customer\'s bank\n');
  {
    const health = snapshot([
      rail('netbanking', 'HDFC', 'down', 0, 45),
      rail('upi', hdfcUpi, 'up', 94.6),
      rail('card', 'HDFC', 'up', 88.2),
      // A better rate at a bank this customer does not hold must not win.
      rail('upi', icici, 'up', 99.9),
    ]);
    const route = evaluateSmartRoute(retryableTx({ customerId: hdfcCustomer }), health);

    assert('strategy is switch_method', route.strategy === 'switch_method', route.strategy);
    assert('rerouted is true', route.rerouted === true);
    assert(
      `recommended rail is HDFC UPI (${hdfcUpi}), not the 99.9% ICICI handle`,
      route.recommended?.method === 'upi' && route.recommended?.instrument === hdfcUpi,
      `${route.recommended?.method}:${route.recommended?.instrument}`,
    );
    assert('uplift is positive', (route.upliftPct ?? 0) > 0, `+${route.upliftPct}pp`);
    assert('outage ETA carried through', route.estimatedRecoveryMinutes === 45, `${route.estimatedRecoveryMinutes}`);
    assert('severity carried through', route.severity === 'high', `${route.severity}`);
    assert(
      'reason names both rails',
      route.reason.includes('netbanking') && route.reason.includes(hdfcUpi),
      route.reason.slice(0, 78) + '…',
    );

    const decision = diagnoseAndDecide(retryableTx({ customerId: hdfcCustomer }), POLICY, 14, undefined, health);
    assert('the retry still happens', decision.action === 'auto_retry', decision.action);
    assert('no hold — a reroute is not a delay', decision.holdReason === null, `${decision.holdReason}`);
  }

  // ── 5. Every rail at the bank down → fail over elsewhere ───────────────────
  console.log('\n  [5] Whole issuer down → acquirer-level failover\n');
  {
    const health = snapshot([
      rail('netbanking', 'HDFC', 'down', 0, 60),
      rail('upi', hdfcUpi, 'down', 0, 60),
      rail('card', 'HDFC', 'down', 0, 60),
      rail('wallet', 'HDFC', 'down', 0, 60),
      rail('emandate', 'HDFC', 'down', 0, 60),
      rail('upi', icici, 'up', 94.6),
    ]);
    const route = evaluateSmartRoute(retryableTx({ customerId: hdfcCustomer }), health);
    assert('strategy is switch_instrument', route.strategy === 'switch_instrument', route.strategy);
    assert(
      `failed over to ${icici}`,
      route.recommended?.instrument === icici,
      `${route.recommended?.instrument}`,
    );
    assert('reason names the failed issuer', route.reason.includes('HDFC'), route.reason.slice(0, 70) + '…');
  }

  // ── 6. Nothing up → hold the retry, do not spend it ────────────────────────
  console.log('\n  [6] Total outage → the retry budget is preserved\n');
  {
    const health = snapshot([
      rail('netbanking', 'HDFC', 'down', 0, 90),
      rail('upi', hdfcUpi, 'down', 0, 90),
      rail('card', 'HDFC', 'down', 0, 90),
      rail('upi', icici, 'down', 0, 90),
    ]);
    const tx = retryableTx({ customerId: hdfcCustomer });
    const route = evaluateSmartRoute(tx, health);
    assert('strategy is hold_for_recovery', route.strategy === 'hold_for_recovery', route.strategy);
    assert('no rail recommended', route.recommended === null);
    assert('uplift is null, not zero', route.upliftPct === null, `${route.upliftPct}`);

    const decision = diagnoseAndDecide(tx, POLICY, 14, undefined, health);
    assert('auto_retry vetoed → no_action', decision.action === 'no_action', decision.action);
    assert('ruleId names the downtime hold', decision.ruleId === 'R5_ISSUER_DOWNTIME_HOLD', decision.ruleId);
    assert('holdReason is issuer_downtime', decision.holdReason === 'issuer_downtime', `${decision.holdReason}`);
    assert(
      'NOT counted as a compliance shield — an outage is not a regulation',
      decision.blockedByCompliance === false,
      `${decision.blockedByCompliance}`,
    );
    assert(
      'no clock-bound release: the outage releases it, not the hour',
      decision.resumeAtHour === null,
      `${decision.resumeAtHour}`,
    );
    assert('routing attached to the hold', decision.routing?.strategy === 'hold_for_recovery');
  }

  // ── 7. A nudge is never held for downtime ──────────────────────────────────
  console.log('\n  [7] Downtime never suppresses a nudge\n');
  {
    const health = snapshot([
      rail('upi', hdfcUpi, 'down', 0, 90),
      rail('netbanking', 'HDFC', 'down', 0, 90),
      rail('card', 'HDFC', 'down', 0, 90),
    ]);
    const nudgeTx = retryableTx({
      customerId: hdfcCustomer,
      reasonCode: 'insufficient_funds',
      source: 'customer',
    });
    const decision = diagnoseAndDecide(nudgeTx, POLICY, 14, undefined, health);
    assert('action stays send_nudge', decision.action === 'send_nudge', decision.action);
    assert('no hold applied', decision.holdReason === null, `${decision.holdReason}`);
    assert(
      'routing still attached for the deep-link hint',
      decision.routing?.strategy === 'hold_for_recovery',
      `${decision.routing?.strategy}`,
    );

    // The TRAI gate is untouched by any of this.
    const night = diagnoseAndDecide(nudgeTx, POLICY, 23, undefined, health);
    assert('TRAI window still governs the nudge at 23:00', night.action === 'no_action', night.action);
    assert(
      'and it is still a compliance hold, not a downtime hold',
      night.holdReason === 'trai_window_closed' && night.blockedByCompliance === true,
      `${night.holdReason}/${night.blockedByCompliance}`,
    );
  }

  // ── 8. The scripted demo snapshot is the advertised incident ───────────────
  console.log('\n  [8] Default gateway-health snapshot\n');
  {
    restoreDefaultDowntimes();
    const health = getGatewayHealth();
    const hdfcNb = health.rails.find((r) => r.method === 'netbanking' && r.instrument === 'HDFC');
    const hdfcUp = health.rails.find((r) => r.method === 'upi' && r.instrument === hdfcUpi);

    assert('never claims to be live telemetry', health.live === false, `live=${health.live}`);
    assert('HDFC netbanking is down', hdfcNb?.status === 'down', `${hdfcNb?.status}`);
    assert('HDFC netbanking rate is 0, not the baseline', hdfcNb?.successRatePct === 0, `${hdfcNb?.successRatePct}`);
    assert('HDFC UPI is unaffected', hdfcUp?.status === 'up', `${hdfcUp?.status}`);
    assert('down rail is sourced from the downtime feed', hdfcNb?.source === 'downtime_feed', `${hdfcNb?.source}`);
    assert('healthy rail is labelled an estimate', hdfcUp?.source === 'baseline', `${hdfcUp?.source}`);
    assert(
      'every issuer × method is enumerated for ranking',
      health.rails.length === 25,
      `${health.rails.length} rails`,
    );

    const route = evaluateSmartRoute(retryableTx({ customerId: hdfcCustomer }), health);
    assert(
      'the advertised demo outcome: HDFC netbanking → HDFC UPI',
      route.strategy === 'switch_method' && route.recommended?.instrument === hdfcUpi,
      `${route.strategy} → ${route.recommended?.instrument}`,
    );

    setSimulatedDowntimes([]);
    const clear = getGatewayHealth();
    assert(
      'clearing the override brings every rail back up',
      clear.rails.every((r) => r.status === 'up'),
      `${clear.rails.filter((r) => r.status !== 'up').length} still down`,
    );
    restoreDefaultDowntimes();
  }

  // ── 9. UPI Intent link conforms to the NPCI spec ───────────────────────────
  console.log('\n  [9] NPCI UPI Intent deep link\n');
  {
    const tx = dunningTx({ amountPaise: 149900 });
    const url = buildUpiIntentUrl({
      amountPaise: tx.amountPaise,
      transactionRef: dunningTransactionRef(tx),
      note: `Recovery ${dunningTransactionRef(tx)}`,
    });
    const params = new URLSearchParams(url.slice('upi://pay?'.length));

    assert('scheme is upi://pay', url.startsWith('upi://pay?'), url.slice(0, 34) + '…');
    assert('pa = merchant VPA', params.get('pa') === UPI_MERCHANT_VPA, `${params.get('pa')}`);
    assert('pn is present', Boolean(params.get('pn')), `${params.get('pn')}`);
    assert(
      'am is RUPEES to 2dp, not paise',
      params.get('am') === '1499.00',
      `am=${params.get('am')} for ${tx.amountPaise} paise`,
    );
    assert('cu = INR', params.get('cu') === 'INR', `${params.get('cu')}`);
    assert('mc is a 4-digit MCC', /^\d{4}$/.test(params.get('mc') ?? ''), `${params.get('mc')}`);
    assert('tr ≤ 35 chars (NPCI cap)', (params.get('tr') ?? '').length <= 35, `${params.get('tr')}`);
    assert('tn ≤ 50 chars (NPCI cap)', (params.get('tn') ?? '').length <= 50, `len=${(params.get('tn') ?? '').length}`);
    assert(
      'tr is alphanumeric so PSPs echo it back intact',
      /^[A-Z0-9]+$/.test(params.get('tr') ?? ''),
      `${params.get('tr')}`,
    );

    const long = buildUpiIntentUrl({
      amountPaise: 100,
      transactionRef: 'X'.repeat(60),
      note: 'Y'.repeat(120),
    });
    const longParams = new URLSearchParams(long.slice('upi://pay?'.length));
    assert('over-long tr is truncated to 35', longParams.get('tr')?.length === 35, `${longParams.get('tr')?.length}`);
    assert('over-long tn is truncated to 50', longParams.get('tn')?.length === 50, `${longParams.get('tn')?.length}`);
  }

  // ── 10. DLT and Meta template shapes, and the cost ladder ──────────────────
  console.log('\n  [10] DLT-registered SMS vs Meta WhatsApp template\n');
  {
    const tx = dunningTx();
    const sms = composeDunningMessage(tx, { channel: 'sms' });
    const wa = composeDunningMessage(tx, { channel: 'whatsapp' });

    assert('SMS carries the DLT header', sms.header === DLT_SENDER_HEADER, sms.header);
    assert('SMS has a registered template id', /^\d{19}$/.test(sms.templateId), sms.templateId);
    assert(
      'SMS template uses DLT {#var#} slots',
      sms.template.includes('{#var#}') && !sms.template.includes('{{'),
      sms.template.slice(0, 56) + '…',
    );
    assert(
      'SMS is service_explicit — which is WHY the TRAI window applies',
      sms.category === 'service_explicit',
      sms.category,
    );
    assert(
      'WhatsApp template uses Meta {{n}} slots',
      wa.template.includes('{{1}}') && !wa.template.includes('{#var#}'),
      wa.template.slice(0, 56) + '…',
    );
    assert('WhatsApp is a utility template', wa.category === 'utility', wa.category);
    assert(
      'no unsubstituted placeholder survives into the body',
      !/%\d|\{\{\d\}\}|\{#var#\}/.test(sms.body) && !/%\d|\{\{\d\}\}|\{#var#\}/.test(wa.body),
      `sms="${sms.body.slice(0, 44)}…"`,
    );
    assert('body names the amount', sms.body.includes('₹2,499.00'), sms.body.slice(0, 52) + '…');
    assert('body carries the reconciliation ref', sms.body.includes(sms.transactionRef), sms.transactionRef);
    assert('both channels embed a UPI intent', Boolean(sms.upiIntentUrl && wa.upiIntentUrl));
    assert(
      'SMS body fits one GSM-7 segment',
      sms.body.length <= 160,
      `${sms.body.length} chars`,
    );
    assert(
      'WhatsApp body is richer than the SMS it escalates from',
      wa.body.length > sms.body.length,
      `${wa.body.length} vs ${sms.body.length}`,
    );
    assert('WhatsApp states the expiry countdown', wa.body.includes('24 hours'), '24h');

    assert('SMS costs ₹0.12', sms.costPaise === MESSAGING_COST_PAISE.sms, `${sms.costPaise}p`);
    assert('WhatsApp costs ₹0.48', wa.costPaise === MESSAGING_COST_PAISE.whatsapp, `${wa.costPaise}p`);
    assert('WhatsApp is 4× the SMS cost', wa.costPaise === sms.costPaise * 4, `${wa.costPaise}/${sms.costPaise}`);

    // Template selection follows the failure class, so the message explains the
    // actual reason rather than a generic "payment pending".
    const card = composeDunningMessage(dunningTx({ reasonCode: 'card_declined' }), { channel: 'whatsapp' });
    assert(
      'a card decline says retrying the same card is pointless',
      card.body.includes('declined') && card.body.includes('fail identically'),
      card.body.slice(0, 56) + '…',
    );
    const mandate = composeDunningMessage(dunningTx({ type: 'subscription' }), { channel: 'whatsapp' });
    assert(
      'a subscription cites RBI e-mandate AFA',
      mandate.body.includes('RBI e-mandate'),
      mandate.body.slice(0, 56) + '…',
    );
    const cart = composeDunningMessage(dunningTx({ type: 'checkout_abandon', reasonCode: '' }), { channel: 'sms' });
    assert('an abandoned cart uses the cart template', cart.templateId.endsWith('001'), cart.templateId);

    // The routing hint reaches the customer-facing copy.
    const routed = composeDunningMessage(tx, {
      channel: 'whatsapp',
      route: evaluateSmartRoute(retryableTx({ customerId: hdfcCustomer }), getGatewayHealth()),
    });
    assert(
      'a reroute names the recommended rail in the message',
      routed.body.includes(hdfcUpi),
      routed.variables[3],
    );
    const unrouted = composeDunningMessage(tx, { channel: 'whatsapp', route: null });
    assert(
      'with no reroute the copy stays generic',
      unrouted.variables[3] === 'Pay by UPI or card',
      unrouted.variables[3],
    );

    // Every variable a template is handed must actually reach the body, and the
    // count must match the slots the registered template declares. Without this,
    // a template that simply omits a placeholder silently drops the value — which
    // is how the routing hint was computed for WhatsApp and then thrown away on
    // all five templates while every assertion above still passed.
    const shapes: Array<[string, Partial<Transaction>]> = [
      ['cart', { type: 'checkout_abandon', reasonCode: '' }],
      ['subscription', { type: 'subscription' }],
      ['low_balance', { reasonCode: 'insufficient_funds' }],
      ['card', { reasonCode: 'card_declined' }],
      ['generic', { reasonCode: 'payment_timed_out' }],
    ];
    for (const [name, overrides] of shapes) {
      for (const channel of ['sms', 'whatsapp'] as const) {
        const msg = composeDunningMessage(dunningTx(overrides), { channel });
        const missing = msg.variables.filter((v) => !msg.body.includes(v));
        assert(
          `${name}/${channel} renders every variable it was given`,
          missing.length === 0,
          missing.length ? `dropped: ${missing.join(', ')}` : `${msg.variables.length} vars`,
        );

        // A registered template is rejected if the value count does not match its
        // slot count, so this has to hold per channel, not on average.
        const slotCount =
          channel === 'sms'
            ? (msg.template.match(/\{#var#\}/g) ?? []).length
            : new Set(msg.template.match(/\{\{\d\}\}/g) ?? []).size;
        assert(
          `${name}/${channel} binds exactly one value per registered slot`,
          slotCount === msg.variables.length,
          `${slotCount} slots vs ${msg.variables.length} values`,
        );

        if (channel === 'whatsapp') {
          // Meta numbers its placeholders, and a gap in the sequence fails review.
          const nums = [...new Set((msg.template.match(/\{\{(\d)\}\}/g) ?? []).map((s) => Number(s.slice(2, -2))))]
            .sort((a, b) => a - b);
          assert(
            `${name}/whatsapp placeholder numbering is contiguous from 1`,
            nums.every((n, i) => n === i + 1),
            `{{${nums.join('}} {{')}}}`,
          );
        }
      }
    }
  }

  console.log('\n' + hr());
  console.log(
    `  ${failed === 0 ? '✅' : '❌'} TEST RESULT: ${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`,
  );
  console.log(hr('═') + '\n');
  if (failed > 0) process.exitCode = 1;
}

run();
