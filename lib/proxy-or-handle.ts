/**
 * lib/proxy-or-handle.ts
 *
 * When BACKEND_API_URL is set (Vercel / decoupled mode), every Next.js API
 * route calls this helper first.  It forwards the request to the Render
 * backend and streams the response back — completely bypassing the local
 * SQLite / Prisma stack.
 *
 * In monolithic mode (no BACKEND_API_URL), it returns null so the route
 * falls through to its own handler.
 */

import { NextRequest, NextResponse } from 'next/server';

export async function proxyOrNull(
  req: NextRequest,
  pathOverride?: string,
): Promise<NextResponse | null> {
  const raw = process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_BACKEND_URL;
  if (!raw) return null; // monolithic mode – let the real handler run

  const base = raw.startsWith('http') ? raw.replace(/\/$/, '') : `https://${raw.replace(/\/$/, '')}`;
  const path = pathOverride ?? req.nextUrl.pathname + (req.nextUrl.search || '');
  const target = `${base}${path}`;

  // Forward headers, but remove host so fetch uses the upstream target host
  const forwarded = new Headers(req.headers);
  forwarded.delete('host');
  forwarded.set('x-forwarded-host', req.nextUrl.host);
  forwarded.set('x-forwarded-proto', req.nextUrl.protocol.replace(':', ''));

  const init: RequestInit = {
    method: req.method,
    headers: forwarded,
  };

  if (!['GET', 'HEAD'].includes(req.method)) {
    init.body = req.body;
    // @ts-expect-error — duplex required for streaming bodies in Node 18+
    init.duplex = 'half';
  }

  try {
    const upstream = await fetch(target, init);
    const body = await upstream.arrayBuffer();
    return new NextResponse(body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (err: unknown) {
    const cause = err instanceof Error && err.cause ? ` (${(err.cause as Error)?.message || JSON.stringify(err.cause)})` : '';
    const message = err instanceof Error ? `${err.message}${cause}` : 'Proxy error';
    console.error(`[proxy] Failed to reach ${target}:`, message);
    return NextResponse.json(
      {
        error: `Backend unreachable: ${message}`,
        target,
        hint: 'Check that BACKEND_API_URL in Vercel settings is set to https://recoverai-8vv7.onrender.com',
      },
      { status: 502 },
    );
  }
}
