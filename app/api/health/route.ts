import { NextRequest, NextResponse } from 'next/server';
import { proxyOrNull } from '@/lib/proxy-or-handle';

export async function GET(req: NextRequest) {
  const proxied = await proxyOrNull(req);
  if (proxied) return proxied;

  return NextResponse.json({
    status: 'healthy',
    mode: 'monolithic',
    timestamp: new Date().toISOString(),
  });
}
