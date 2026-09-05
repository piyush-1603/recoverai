/**
 * /lib/gateway-health.ts
 *
 * Rail health telemetry for the Smart Optimizer in lib/policy-engine.ts.
 *
 * Shape and semantics follow Razorpay's Payment Downtime feed, which reports an
 * outage as an entity carrying `method` (card | netbanking | upi | wallet), the
 * affected `instrument` (issuing bank, PSP handle or wallet brand), a `severity`
 * of high | medium | low, a `status`, and a begin/end window. Razorpay pushes
 * those as `payment.downtime.started` / `.updated` / `.resolved` webhooks and
 * exposes the current set over the Payment Downtime API.
 *
 * WHAT IS REAL AND WHAT IS NOT
 *  - The rail matrix, issuer handles and the routing logic that consumes them
 *    are real.
 *  - The *status* of each rail here is simulated. Razorpay's downtime feed is not
 *    available on test-mode keys, so `live` is false on every snapshot this
 *    module produces and the dashboard is expected to say so. No number in here
 *    is ever presented as measured production telemetry.
 *
 * The incident is scripted rather than random so a demo is reproducible: HDFC
 * netbanking is down, SBI cards are degraded, and every other rail is up. That
 * is exactly the situation the router exists for — an HDFC customer whose
 * netbanking failed is routed to HDFC's own UPI handle rather than being retried
 * into the outage or shipped to a bank they have no account with.
 */

import type {
  GatewayHealthSnapshot,
  PaymentMethod,
  RailHealth,
} from './policy-engine';
import { issuerDirectory, instrumentForBank } from './policy-engine';

/**
 * Baseline authorization rates per rail, in percent.
 *
 * Ordering reflects the published Indian pattern: UPI authorises best, cards sit
 * below it on 3DS/OTP drop-off, netbanking below that on bank-side redirects,
 * and e-mandate debits are worst of all because RBI AFA pre-debit notification
 * and the 2FA step shed customers at every hop.
 */
const BASELINE_SUCCESS_RATE: Record<PaymentMethod, number> = {
  upi: 94.6,
  card: 88.2,
  wallet: 90.1,
  netbanking: 81.4,
  emandate: 76.8,
};

/** Authorization rate multiplier applied while a rail is degraded. */
const DEGRADED_RATE_FACTOR = 0.42;

type ScriptedIncident = {
  method: PaymentMethod;
  bank: string;
  status: 'degraded' | 'down';
  severity: 'high' | 'medium' | 'low';
  estimatedRecoveryMinutes: number;
};

/**
 * The default scripted outage. Mirrors the single most common real incident
 * class on Indian rails: one bank's netbanking leg drops while its UPI leg,
 * which runs over a different switch, keeps authorising normally.
 */
const DEFAULT_INCIDENTS: ScriptedIncident[] = [
  {
    method: 'netbanking',
    bank: 'HDFC',
    status: 'down',
    severity: 'high',
    estimatedRecoveryMinutes: 45,
  },
  {
    method: 'card',
    bank: 'SBI',
    status: 'degraded',
    severity: 'medium',
    estimatedRecoveryMinutes: 20,
  },
];

/**
 * Operator override for the current incident set.
 *
 * Exists so the dashboard can demonstrate the router live — flip a rail down,
 * watch a retry get held or rerouted — without waiting for a real outage. Kept
 * in module memory deliberately: rail health is a point-in-time observation, not
 * a fact worth persisting, and a restarted process should read the world fresh.
 */
let incidentOverride: ScriptedIncident[] | null = null;

/** Every method the rail matrix enumerates. */
const ALL_METHODS: PaymentMethod[] = ['upi', 'card', 'netbanking', 'wallet', 'emandate'];

function rateFor(method: PaymentMethod, status: 'up' | 'degraded' | 'down'): number {
  const base = BASELINE_SUCCESS_RATE[method];
  if (status === 'down') return 0;
  if (status === 'degraded') return Number((base * DEGRADED_RATE_FACTOR).toFixed(1));
  return base;
}

/**
 * Current rail health across every issuer × method the router can choose from.
 *
 * Razorpay's real feed returns only the *unhealthy* rails, because that is all a
 * downtime API needs to say. A router needs the full matrix to rank alternatives,
 * so healthy rows are filled in from the baseline table and labelled
 * `source: 'baseline'` — the distinction between "we observed this rail" and "we
 * assumed this rail" stays visible all the way to the UI.
 */
export function getGatewayHealth(now: Date = new Date()): GatewayHealthSnapshot {
  const incidents = incidentOverride ?? DEFAULT_INCIDENTS;
  const rails: RailHealth[] = [];

  for (const { bank } of issuerDirectory()) {
    for (const method of ALL_METHODS) {
      const incident = incidents.find((i) => i.method === method && i.bank === bank);
      const status = incident?.status ?? 'up';
      rails.push({
        method,
        instrument: instrumentForBank(bank, method),
        status,
        successRatePct: rateFor(method, status),
        severity: incident?.severity ?? null,
        estimatedRecoveryMinutes: incident?.estimatedRecoveryMinutes ?? null,
        source: incident ? 'downtime_feed' : 'baseline',
      });
    }
  }

  return {
    capturedAt: now.toISOString(),
    // Razorpay does not expose the downtime feed on test keys. Never claim live.
    live: false,
    rails,
  };
}

/** Rails currently reported unhealthy — what Razorpay's downtime API would return. */
export function activeDowntimes(now: Date = new Date()): RailHealth[] {
  return getGatewayHealth(now).rails.filter((r) => r.status !== 'up');
}

/**
 * Replace the incident set, as if a `payment.downtime.started` webhook arrived.
 *
 * Returns the resulting snapshot so a caller can show the effect immediately
 * rather than re-reading and hoping the write landed.
 */
export function setSimulatedDowntimes(incidents: ScriptedIncident[]): GatewayHealthSnapshot {
  incidentOverride = incidents;
  return getGatewayHealth();
}

/** Clear every simulated outage, as if `payment.downtime.resolved` arrived for all. */
export function resolveAllDowntimes(): GatewayHealthSnapshot {
  incidentOverride = [];
  return getGatewayHealth();
}

/** Drop the override entirely and return to the scripted demo incident. */
export function restoreDefaultDowntimes(): GatewayHealthSnapshot {
  incidentOverride = null;
  return getGatewayHealth();
}

export type { ScriptedIncident };
