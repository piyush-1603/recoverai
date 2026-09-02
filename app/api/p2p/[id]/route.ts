/**
 * /app/api/p2p/[id]/route.ts
 *
 * REST API for individual Promise-to-Pay (P2P) operations.
 *
 * GET    /api/p2p/:id           — Get a single P2P record by ID
 * PATCH  /api/p2p/:id           — Update P2P status (cancel, mark completed)
 */

import { NextResponse } from 'next/server';
import { getP2PById, cancelP2P, completeP2P } from '@/lib/p2p-engine';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const record = await getP2PById(id);
    if (!record) {
      return NextResponse.json({ error: `P2P record ${id} not found` }, { status: 404 });
    }
    return NextResponse.json({
      ...record,
      amountRupees: record.amountPaise / 100,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { action, reason, paymentId } = body;

    const record = await getP2PById(id);
    if (!record) {
      return NextResponse.json({ error: `P2P record ${id} not found` }, { status: 404 });
    }

    if (action === 'cancel') {
      const updated = await cancelP2P(id, reason || 'Merchant-initiated cancellation');
      return NextResponse.json({ success: true, p2p: updated });
    }

    if (action === 'complete') {
      if (!paymentId) {
        return NextResponse.json({ error: 'paymentId is required for "complete" action' }, { status: 400 });
      }
      const updated = await completeP2P(id, paymentId);
      return NextResponse.json({ success: true, p2p: updated });
    }

    return NextResponse.json(
      { error: 'Invalid action. Supported: "cancel", "complete"' },
      { status: 400 },
    );
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
