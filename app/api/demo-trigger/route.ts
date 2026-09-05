/**
 * /app/api/demo-trigger/route.ts
 *
 * Manual Demo Trigger POST endpoint for pitches and live presentations.
 *
 * Resets a single demo transaction to fresh failed state, executes policy diagnosis,
 * invokes real Razorpay Payment Link creation via action-executor, and writes an
 * immutable AuditLog entry with a live current timestamp.
 *
 * The AI advisory call is non-fatal: if every provider fails, the policy engine still
 * decides, the action still executes, and the audit row records 'advisory_unavailable'.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { diagnoseAndDecide } from '@/lib/policy-engine';
import { getGatewayHealth } from '@/lib/gateway-health';
import { recommendAction, ClaudeRecommendation } from '@/lib/claude-agent';
import { executeAction, auditReasonSuffix } from '@/lib/action-executor';
import { writeEvent, describeAdvisor, type AuditMetadata } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';
import { proxyOrNull } from '@/lib/proxy-or-handle';

const RATE_LIMIT_MAX_CALLS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
let rateLimitWindowStartedAt = Date.now();
let rateLimitCallCount = 0;

function isWithinDemoTriggerRateLimit(now = Date.now()): boolean {
  if (now - rateLimitWindowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitWindowStartedAt = now;
    rateLimitCallCount = 0;
  }

  if (rateLimitCallCount >= RATE_LIMIT_MAX_CALLS) return false;
  rateLimitCallCount += 1;
  return true;
}

/** Test-only hook: lets the guard be verified without triggering recovery actions. */
export function setDemoTriggerRateLimitForTests(callCount: number, windowStartedAt = Date.now()) {
  rateLimitCallCount = callCount;
  rateLimitWindowStartedAt = windowStartedAt;
}

export async function POST(req: NextRequest) {
  const proxy = await proxyOrNull(req);
  if (proxy) return proxy;
  const demoTriggerSecret = process.env.DEMO_TRIGGER_SECRET;
  if (!demoTriggerSecret || req.headers.get('x-demo-secret') !== demoTriggerSecret) {
    return NextResponse.json({ error: 'Unauthorized demo trigger request' }, { status: 401 });
  }

  if (!isWithinDemoTriggerRateLimit()) {
    return NextResponse.json(
      { error: 'Demo trigger rate limit exceeded. Try again in one minute.' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  try {
    let reqBody: { id?: string; hourOverride?: number } = {};
    try {
      reqBody = await req.json();
    } catch {
      // No JSON body provided, use default
    }

    let targetTx = null;

    if (reqBody.id) {
      targetTx = await prisma.transaction.findUnique({
        where: { id: reqBody.id },
      });
    }

    // Dashboard demo buttons operate on DEDICATED demo artifacts, never on the
    // frozen 65-transaction benchmark set. Previously both buttons grabbed a real
    // baseline row and reset `recovered: false` on it, permanently degrading the
    // headline recovered-revenue figure every time a demo was run. Demo artifacts
    // are flagged `isDemoArtifact` and excluded from the headline metrics, so a
    // live trigger proves real execution without touching the benchmark numbers.
    //
    // `source` and `reasonCode` deliberately mirror real records so the policy
    // engine routes them through the exact same rules (it branches on `source`):
    //   compliance -> customer / insufficient_funds  => nudge path, blocked off-window
    //   live       -> gateway  / payment_timed_out   => transient auto_retry path
    if (!targetTx) {
      const isComplianceDemo = typeof reqBody.hourOverride === 'number';
      const demoKey = isComplianceDemo ? 'pay_demo_compliance_01' : 'pay_demo_live_01';

      const demoDefaults = isComplianceDemo
        ? {
            reasonCode: 'insufficient_funds',
            source: 'customer',
            expectedRecoveryOutcome: 'recovers_on_nudge',
            customerId: 'cust_demo_compliance',
          }
        : {
            reasonCode: 'payment_timed_out',
            source: 'gateway',
            expectedRecoveryOutcome: 'recovers_on_retry',
            customerId: 'cust_demo_live',
          };

      // Reuse the same artifact across runs (stable demoKey) so repeated demo clicks
      // never accumulate extra rows in the database.
      const existing = await prisma.transaction.findFirst({
        where: { customerId: demoDefaults.customerId, isDemoArtifact: true },
      });

      if (existing) {
        targetTx = await prisma.transaction.update({
          where: { id: existing.id },
          data: {
            externalPaymentId: demoKey,
            status: 'failed',
            retryCount: 0,
            nudgeCount: 0,
            recovered: false,
            resolvedAt: null,
            // A reset is a fresh failure, so any hold from the previous run is
            // stale. Leaving these behind made the artifact look like it was
            // still parked under a TRAI window it had long since exited.
            holdReason: null,
            deferredUntil: null,
            isDemoArtifact: true,
          },
        });
      } else {
        targetTx = await prisma.transaction.create({
          data: {
            externalPaymentId: demoKey,
            amountPaise: 49900,
            status: 'failed',
            type: 'payment',
            customerTier: 'standard',
            retryCount: 0,
            nudgeCount: 0,
            recovered: false,
            simulatedRecoveryAmountPaise: 49900,
            isDemoArtifact: true,
            ...demoDefaults,
          },
        });
      }
    } else {
      // Explicit id supplied (tests / targeted replays): reset to a clean failed state.
      targetTx = await prisma.transaction.update({
        where: { id: targetTx.id },
        data: {
          status: 'failed',
          retryCount: 0,
          nudgeCount: 0,
          recovered: false,
          resolvedAt: null,
          holdReason: null,
          deferredUntil: null,
        },
      });
    }

    // 2. Load policy config and evaluate current hour
    const policyConfig = (await prisma.policyConfig.findFirst()) ?? {
      afaThresholdPaise: 1500000,
      maxRetries: 1,
      maxNudges: 2,
      nudgeWindowStartHour: 10,
      nudgeWindowEndHour: 21,
    };

    const istHourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false,
    }).format(new Date());
    const currentHour = typeof reqBody.hourOverride === 'number'
      ? Math.max(0, Math.min(23, Math.floor(reqBody.hourOverride)))
      : parseInt(istHourStr, 10);

    // 3. AI Advisory Recommendation (provider resolved at runtime — see lib/claude-agent.ts)
    //
    // DELIBERATELY NON-FATAL. The policy engine is the sole decision authority and
    // needs no AI input to act, so an advisory outage (rate limit, quota, network,
    // bad key, every provider down) must never block real recovery execution. When
    // the advisory layer is unavailable we still run the policy engine, still call
    // Razorpay, and still write an audit row — the row just records honestly that
    // no AI opinion was available rather than inventing one.
    let aiRec: ClaudeRecommendation | null = null;
    let advisoryError: string | null = null;
    try {
      aiRec = await recommendAction(targetTx as any, policyConfig);
    } catch (advisoryFailure: any) {
      advisoryError = advisoryFailure?.message || 'unknown advisory failure';
      console.error(
        '[DemoTrigger] AI advisory unavailable — proceeding on policy engine alone:',
        advisoryError,
      );
    }

    // 4. Pure Policy Diagnosis (Authoritative)
    //
    // The health snapshot is read here rather than inside the engine on purpose:
    // the engine stays pure (no clock, no network, no I/O) so it remains testable
    // and the parity suite can prove the rule ladder is untouched. Rail health is
    // an observation about the outside world, so the caller supplies it.
    const gatewayHealth = getGatewayHealth();
    const decision = diagnoseAndDecide(
      targetTx as any,
      policyConfig,
      currentHour,
      undefined,
      gatewayHealth,
    );

    // 5. Real live execution (always executes Policy Engine decision)
    const result = await executeAction(decision, targetTx, 'live');

    // 6. Write live audit log entry
    //
    // The reason text names the provider/model that actually answered, read off
    // the recommendation object rather than written in by hand — so if the
    // fallback chain engages, the ledger says so instead of claiming Gemini.
    // `auditReasonSuffix` appends the executor's note when the live Razorpay
    // call failed, so the actual API error lands in the row instead of being
    // dropped on the floor.
    const isMatch = aiRec ? aiRec.recommendedAction === decision.action : null;
    const advisor = aiRec ? describeAdvisor(aiRec.provider, aiRec.model) : null;
    const executorNote = auditReasonSuffix(result);

    // Structured, queryable facts about this event. The reason prose above stays
    // exactly as it was — it is what a human reads and what several suites assert
    // on — but nothing downstream has to parse it any more: every value the
    // dashboard needs is now a column.
    const meta: AuditMetadata = {
      amountPaise: targetTx.amountPaise,
      recoveredAmountPaise: result.recoveredAmountPaise,
      simulated: result.simulated,
      ruleId: decision.ruleId,
      channel: result.channel,
      messagingCostPaise: result.messagingCostPaise,
      razorpayEntityId: result.externalPaymentId ?? targetTx.externalPaymentId,
      aiRecommendedAction: aiRec?.recommendedAction ?? null,
      aiReasoning: aiRec?.reasoning ?? null,
      extra: {
        outcome: result.outcome,
        executionMode: 'live',
        currentHourIst: currentHour,
        resolvedStatus: result.persistedState?.status ?? null,
        holdReason: result.persistedState?.holdReason ?? null,
        deferredUntil: result.persistedState?.deferredUntil?.toISOString() ?? null,
        blockedByCompliance: decision.blockedByCompliance,
        // Which rail the Smart Optimizer chose and why. Flattened rather than
        // nested so the ledger stays queryable with plain JSON extraction — the
        // same reason every other value in here is a scalar.
        ...(result.routing
          ? {
              routingStrategy: result.routing.strategy,
              routedFrom: `${result.routing.origin.method}:${result.routing.origin.instrument}`,
              routedTo: result.routing.recommended
                ? `${result.routing.recommended.method}:${result.routing.recommended.instrument}`
                : null,
              routingOriginStatus: result.routing.originStatus,
              routingUpliftPct: result.routing.upliftPct,
              routingOriginInferred: result.routing.originInferred,
            }
          : {}),
        // The dunning artefact, so the trace drawer can show exactly what the
        // customer received without re-deriving it from the reason prose.
        ...(result.dunningMessage
          ? {
              dltHeader: result.dunningMessage.header,
              dltTemplateId: result.dunningMessage.templateId,
              dltCategory: result.dunningMessage.category,
              upiIntentUrl: result.dunningMessage.upiIntentUrl,
              dunningShortlink: result.dunningMessage.shortlink,
              dunningTransactionRef: result.dunningMessage.transactionRef,
            }
          : {}),
        ...(advisoryError ? { advisoryError } : {}),
        ...(result.fallbackError ? { fallbackError: result.fallbackError } : {}),
      },
    };

    if (!aiRec) {
      // Degraded path: no AI opinion existed, so this is neither a match nor an
      // override. Provider/model stay NULL because no provider actually answered.
      await writeEvent(
        targetTx.id,
        'policy_engine',
        decision.action,
        `AI advisory unavailable (${advisoryError}) — policy engine independently enforced "${decision.action}" per rule: ${decision.reason}. Execution outcome: ${result.outcome}.${executorNote}`,
        'advisory_unavailable',
        undefined,
        decision.policyVersion,
        null,
        null,
        meta,
      );
    } else if (isMatch) {
      await writeEvent(
        targetTx.id,
        'ai_agent+policy_engine',
        decision.action,
        `${advisor} recommended "${aiRec.recommendedAction}" (${aiRec.reasoning}) — Confirmed by policy: ${decision.reason}${executorNote}`,
        result.outcome,
        undefined,
        decision.policyVersion,
        aiRec.provider,
        aiRec.model,
        meta,
      );
    } else {
      await writeEvent(
        targetTx.id,
        'policy_engine_override',
        decision.action,
        `${advisor} recommended "${aiRec.recommendedAction}" (${aiRec.reasoning}) but policy engine enforced "${decision.action}" per rule: ${decision.reason}${executorNote}`,
        result.outcome,
        undefined,
        decision.policyVersion,
        aiRec.provider,
        aiRec.model,
        meta,
      );
    }

    return NextResponse.json({
      success: true,
      transactionId: targetTx.id,
      externalPaymentId: targetTx.externalPaymentId,
      amountPaise: targetTx.amountPaise,
      aiRecommendation: aiRec,
      advisoryUnavailable: aiRec === null,
      advisoryError,
      decision,
      result,
      isMatch,
      // Additive: existing consumers ignore it, the new operations console renders
      // the rail matrix from it. `live` is false because Razorpay does not expose
      // the downtime feed on test keys — the UI must say so rather than imply
      // measured production telemetry.
      gatewayHealth,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('[DemoTrigger] Error executing live demo trigger:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to execute demo trigger' },
      { status: 500 },
    );
  }
}
