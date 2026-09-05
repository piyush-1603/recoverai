'use server';

import { NextRequest } from 'next/server';
import { POST as executeDemoTrigger } from '@/app/api/demo-trigger/route';
import { POST as executeWebhookSimulator } from '@/app/api/test-webhook-simulator/route';

const backendUrl = process.env.BACKEND_API_URL || process.env.NEXT_PUBLIC_BACKEND_URL;

export async function triggerDashboardDemo(kind: 'live' | 'compliance') {
  const secret = process.env.DEMO_TRIGGER_SECRET;
  if (!secret) throw new Error('Demo trigger is not configured on this server.');

  // If running in decoupled mode with a separate backend service
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

  // Fallback to in-process execution in monolithic mode
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
  // If running in decoupled mode with a separate backend service
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

  // Fallback to in-process execution in monolithic mode
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

