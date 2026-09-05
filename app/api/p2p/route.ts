/**
 * /app/api/p2p/route.ts
 *
 * REST API for the Promise-to-Pay (P2P) tracker.
 *
 * POST /api/p2p  — Create a new P2P commitment
 * GET  /api/p2p  — List all P2P records (optionally filtered by customerId)
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createP2P,
  getAllP2Ps,
  getP2PsByCustomer,
} from '@/lib/p2p-engine';
import { proxyOrNull } from '@/lib/proxy-or-handle';

export async function POST(req: NextRequest) {
  const proxy = await proxyOrNull(req);
  if (proxy) return proxy;
  try {
    const body = await req.json();
    const { customerId, promisedPaymentTime, transactionAmount, transactionId } = body;

    // ── Input validation ──
    if (!customerId || typeof customerId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "customerId" (string required)' },
        { status: 400 },
      );
    }

    if (!promisedPaymentTime || typeof promisedPaymentTime !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid "promisedPaymentTime" (ISO 8601 string required, e.g. "2026-09-05T15:00:00Z")' },
        { status: 400 },
      );
    }

    if (!transactionAmount || typeof transactionAmount !== 'number' || transactionAmount <= 0) {
      return NextResponse.json(
        { error: 'Missing or invalid "transactionAmount" (positive number in rupees required)' },
        { status: 400 },
      );
    }

    const amountPaise = Math.round(transactionAmount * 100);

    const record = await createP2P({
      customerId,
      amountPaise,
      promisedPaymentTime,
      transactionId,
    });

    return NextResponse.json({
      success: true,
      p2p: {
        id: record.id,
        customerId: record.customerId,
        amountRupees: amountPaise / 100,
        promisedPaymentTime: record.promisedPaymentTime,
        status: record.status,
      },
      message: `P2P commitment registered. Reminder will be sent 1 hour before ${promisedPaymentTime}. Auto-collection will trigger at the promised time.`,
    });
  } catch (error: any) {
    console.error('[P2P API] Error creating P2P:', error.message);
    return NextResponse.json(
      { error: error.message || 'Internal Server Error' },
      { status: error.message?.includes('must be') ? 400 : 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  const proxy = await proxyOrNull(req);
  if (proxy) return proxy;
  try {
    const url = new URL(req.url);
    const customerId = url.searchParams.get('customerId');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);

    const records = customerId
      ? await getP2PsByCustomer(customerId)
      : await getAllP2Ps(limit);

    return NextResponse.json({
      count: records.length,
      records: records.map((r) => ({
        ...r,
        amountRupees: r.amountPaise / 100,
      })),
    });
  } catch (error: any) {
    console.error('[P2P API] Error fetching P2P records:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
