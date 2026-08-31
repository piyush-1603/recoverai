/**
 * /app/api/demo-trigger/route.ts
 *
 * Manual Demo Trigger POST endpoint for pitches and live presentations.
 *
 * Resets a single demo transaction to fresh failed state, executes policy diagnosis,
 * invokes real Razorpay Payment Link creation via action-executor, and writes an
 * immutable AuditLog entry with a live current timestamp.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { diagnoseAndDecide } from '@/lib/policy-engine';
import { recommendAction } from '@/lib/claude-agent';
import { executeAction } from '@/lib/action-executor';
import { writeEvent } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

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

    // The dashboard's compliance demo intentionally uses an insufficient-funds
    // record and a caller-supplied off-window hour. Normal live triggers retain
    // the current-time behavior below.
    if (!targetTx && typeof reqBody.hourOverride === 'number') {
      targetTx = await prisma.transaction.findFirst({
        where: { reasonCode: 'insufficient_funds' },
      });
    }

    if (!targetTx) {
      // Find a gateway demo transaction or fallback
      targetTx = await prisma.transaction.findFirst({
        where: {
          source: 'gateway',
          reasonCode: { in: ['payment_timed_out', 'gateway_technical_error', 'bank_technical_error'] },
        },
      });
    }

    if (!targetTx) {
      // Create one if none exists
      targetTx = await prisma.transaction.create({
        data: {
          externalPaymentId: `pay_live_demo_${Date.now()}`,
          amountPaise: 49900,
          status: 'failed',
          reasonCode: 'payment_timed_out',
          source: 'gateway',
          type: 'payment',
          customerId: 'cust_live_demo_01',
          retryCount: 0,
          nudgeCount: 0,
          recovered: false,
          expectedRecoveryOutcome: 'recovers_on_retry',
          simulatedRecoveryAmountPaise: 49900,
        },
      });
    } else {
      // Reset to clean fresh failed state
      targetTx = await prisma.transaction.update({
        where: { id: targetTx.id },
        data: {
          status: 'failed',
          retryCount: 0,
          nudgeCount: 0,
          recovered: false,
          resolvedAt: null,
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

    // 3. Claude AI Advisory Recommendation
    const claudeRec = await recommendAction(targetTx as any, policyConfig);

    // 4. Pure Policy Diagnosis (Authoritative)
    const decision = diagnoseAndDecide(targetTx as any, policyConfig, currentHour);

    // 5. Real live execution (always executes Policy Engine decision)
    const result = await executeAction(decision, targetTx, 'live');

    // 6. Write live audit log entry
    const isMatch = claudeRec.recommendedAction === decision.action;
    if (isMatch) {
      await writeEvent(
        targetTx.id,
        'claude_agent+policy_engine',
        decision.action,
        `Claude recommended "${claudeRec.recommendedAction}" (${claudeRec.reasoning}) — Confirmed by policy: ${decision.reason}`,
        result.outcome,
        undefined,
        decision.policyVersion,
      );
    } else {
      await writeEvent(
        targetTx.id,
        'policy_engine_override',
        'override',
        `Claude recommended "${claudeRec.recommendedAction}" (${claudeRec.reasoning}) but policy engine enforced "${decision.action}" per rule: ${decision.reason}`,
        'ai_recommendation_overridden',
        undefined,
        decision.policyVersion,
      );
    }

    return NextResponse.json({
      success: true,
      transactionId: targetTx.id,
      externalPaymentId: targetTx.externalPaymentId,
      amountPaise: targetTx.amountPaise,
      claudeRecommendation: claudeRec,
      decision,
      result,
      isMatch,
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
