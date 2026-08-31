/** Verifies the demo-trigger endpoint rejects unauthenticated and rate-limited calls before execution. */
import 'dotenv/config';
import { NextRequest } from 'next/server';
import { POST, setDemoTriggerRateLimitForTests } from '../app/api/demo-trigger/route';

async function run() {
  const unauthorized = await POST(new NextRequest('http://localhost:3000/api/demo-trigger', { method: 'POST' }));
  const secret = process.env.DEMO_TRIGGER_SECRET;
  if (!secret) throw new Error('DEMO_TRIGGER_SECRET is required for this test.');

  setDemoTriggerRateLimitForTests(10);
  const rateLimited = await POST(new NextRequest('http://localhost:3000/api/demo-trigger', {
    method: 'POST',
    headers: { 'x-demo-secret': secret },
  }));
  setDemoTriggerRateLimitForTests(0);

  const passed = unauthorized.status === 401 && rateLimited.status === 429;
  console.log(`Unauthenticated request: ${unauthorized.status} (expected 401)`);
  console.log(`Authenticated request over limit: ${rateLimited.status} (expected 429)`);
  console.log(passed ? '✅ DEMO TRIGGER GUARD: PASS' : '❌ DEMO TRIGGER GUARD: FAIL');
  if (!passed) process.exitCode = 1;
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
