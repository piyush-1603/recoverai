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
      if (tx.recovered && tx.simulatedRecoveryAmountPaise) {
        totalRecoveredPaise += tx.simulatedRecoveryAmountPaise;
        recoveredCount++;
      }
    }

    const recoveryRate =
      totalAtRiskPaise > 0
        ? Number(((totalRecoveredPaise / totalAtRiskPaise) * 100).toFixed(1))
        : 0;

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
