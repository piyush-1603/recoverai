'use server';

import { NextRequest } from 'next/server';
import { POST as executeDemoTrigger } from '@/app/api/demo-trigger/route';

export async function triggerDashboardDemo(kind: 'live' | 'compliance') {
  const secret = process.env.DEMO_TRIGGER_SECRET;
  if (!secret) throw new Error('Demo trigger is not configured on this server.');

  // Invoke the protected handler on the server. The browser receives neither
  // the secret nor a route that can replay it.
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
