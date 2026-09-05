'use server';

import { NextRequest } from 'next/server';

const backendUrl = process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_BACKEND_URL;

export async function triggerDashboardDemo(kind: 'live' | 'compliance') {
  const secret = process.env.DEMO_TRIGGER_SECRET;
  if (!secret) throw new Error('Demo trigger is not configured on this server.');

  // Decoupled mode: proxy to the dedicated backend service
  if (backendUrl) {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/api/demo-trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-demo-secret': secret,
      },
      body: JSON.stringify(kind === 'compliance' ? { hourOverride: 2 } : {}),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Demo trigger failed.');
    return payload;
  }

  // Monolithic mode: load route handler dynamically so better-sqlite3 is never
  // statically bundled on the Vercel frontend build (which has no DATABASE_URL).
  const { POST: executeDemoTrigger } = await import('@/app/api/demo-trigger/route');
  const request = new NextRequest('http://internal/api/demo-trigger', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-demo-secret': secret,
    },
    body: JSON.stringify(kind === 'compliance' ? { hourOverride: 2 } : {}),
  });
  const response = await executeDemoTrigger(request);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Demo trigger failed.');
  return payload;
}

export async function simulateWebhookPayment(options?: {
  transactionId?: string;
  externalPaymentId?: string;
  event?: string;
}) {
  // Decoupled mode: proxy to the dedicated backend service
  if (backendUrl) {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/api/test-webhook-simulator`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(options || {}),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Webhook simulation failed.');
    return payload;
  }

  // Monolithic mode: dynamic import to avoid bundling the DB stack at build time.
  const { POST: executeWebhookSimulator } = await import('@/app/api/test-webhook-simulator/route');
  const request = new NextRequest('http://internal/api/test-webhook-simulator', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options || {}),
  });
  const response = await executeWebhookSimulator(request);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Webhook simulation failed.');
  return payload;
}
