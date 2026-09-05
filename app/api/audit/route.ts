/**
 * /app/api/audit/route.ts
 *
 * GET endpoint that returns real-time metrics, live audit logs, and
 * exception lists for the live recovery dashboard.
 */

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Compute live dashboard metrics across all evaluated transactions including
    // interactive demo events and compliance tests so the dashboard updates live in real-time.
    const transactions = await prisma.transaction.findMany({
      orderBy: { createdAt: 'desc' },
    });

    const auditLogs = await prisma.auditLog.findMany({
      take: 100,
      orderBy: { timestamp: 'desc' },
    });

    const exceptions = await prisma.transaction.findMany({
      where: { status: 'unrecoverable' },
      orderBy: { createdAt: 'desc' },
    });

    let totalAtRiskPaise = 0;
    let totalRecoveredPaise = 0;
    let recoveredCount = 0;

    for (const tx of transactions) {
      totalAtRiskPaise += tx.amountPaise;
      if (tx.recovered) {
        totalRecoveredPaise += tx.simulatedRecoveryAmountPaise ?? tx.amountPaise;
        recoveredCount++;
      }
    }

    const recoveryRate =
      totalAtRiskPaise > 0
        ? Number(((totalRecoveredPaise / totalAtRiskPaise) * 100).toFixed(1))
        : 0;

    const latestRecoveredDemo = await prisma.transaction.findFirst({
      where: { isDemoArtifact: true, recovered: true },
      orderBy: { resolvedAt: 'desc' },
      include: {
        auditLogs: {
          where: { action: 'webhook_payment_captured' },
          orderBy: { timestamp: 'desc' },
          take: 1,
        },
      },
    });

    const activeDemoTx = await prisma.transaction.findFirst({
      where: {
        isDemoArtifact: true,
        source: 'gateway',
        status: 'pending',
      },
      orderBy: { createdAt: 'desc' },
    });

    const liveDemo = {
      activePending: activeDemoTx
        ? {
            id: activeDemoTx.id,
            amountPaise: activeDemoTx.amountPaise,
            externalPaymentId: activeDemoTx.externalPaymentId,
          }
        : null,
      lastRecovered: latestRecoveredDemo
        ? {
            id: latestRecoveredDemo.id,
            amountPaise: latestRecoveredDemo.amountPaise,
            resolvedAt: latestRecoveredDemo.resolvedAt,
            paymentId:
              latestRecoveredDemo.auditLogs[0]?.reason?.match(/\((pay_[^)]+)\)/)?.[1] ?? null,
          }
        : null,
    };

    return NextResponse.json({
      stats: {
        totalTransactions: transactions.length,
        totalAtRiskPaise,
        totalRecoveredPaise,
        recoveryRate,
        recoveredCount,
        unrecoverableCount: exceptions.length,
        pendingCount: transactions.filter((t) => t.status === 'pending' || t.status === 'failed').length,
      },
      liveDemo,
      auditLogs,
      exceptions,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Audit API error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to fetch audit data' },
      { status: 500 },
    );
  }
}
