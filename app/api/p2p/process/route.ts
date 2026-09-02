/**
 * /app/api/p2p/process/route.ts
 *
 * Durable execution endpoint for the P2P scheduler.
 *
 * POST /api/p2p/process — Process all due P2P commitments.
 *
 * This is the "Temporal replacement": call it from a cron job (e.g. every
 * 5 minutes) or invoke manually. It scans the database for:
 *  - Pending P2Ps whose reminder window is open (T - 1 hour)
 *  - Reminded P2Ps whose promised payment time has arrived
 *
 * Because state lives in the DB (not in memory), this survives server
 * restarts, container redeploys, and crashes — exactly like Temporal's
 * durable execution model, but without the infrastructure overhead.
 */

import { NextResponse } from 'next/server';
import { processDueP2Ps } from '@/lib/p2p-engine';

export async function POST() {
  try {
    const result = await processDueP2Ps();

    return NextResponse.json({
      success: true,
      summary: {
        remindersProcessed: result.remindersProcessed,
        collectionsProcessed: result.collectionsProcessed,
        totalProcessed: result.remindersProcessed + result.collectionsProcessed,
      },
      details: result.results,
    });
  } catch (error: any) {
    console.error('[P2P Process] Error:', error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
