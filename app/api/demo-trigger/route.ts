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
import { executeAction } from '@/lib/action-executor';
import { writeEvent } from '@/lib/audit-logger';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    let reqBody: { id?: string } = {};
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
    const currentHour = parseInt(istHourStr, 10);

    // 3. Pure diagnosis
    const decision = diagnoseAndDecide(targetTx, policyConfig, currentHour);

    // 4. Real live execution (creates real Razorpay Payment Link if auto_retry)
    const result = await executeAction(decision, targetTx, 'live');

    // 5. Write live audit log entry
    await writeEvent(
      targetTx.id,
      'action_executor',
      decision.action,
      decision.reason,
      result.outcome,
    );

    return NextResponse.json({
      success: true,
      transactionId: targetTx.id,
      externalPaymentId: targetTx.externalPaymentId,
      amountPaise: targetTx.amountPaise,
      decision,
      result,
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
