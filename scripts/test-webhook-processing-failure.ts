/** Confirms a valid, new webhook receives 500 when its database update fails. */
import 'dotenv/config';
import crypto from 'crypto';
import { NextRequest } from 'next/server';
import { prisma } from '../lib/prisma';
import { POST } from '../app/api/webhook/route';

const triggerName = 'force_webhook_processing_failure';

async function run() {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
  if (!secret) throw new Error('A Razorpay webhook secret is required for this test.');

  const suffix = Date.now();
  const transaction = await prisma.transaction.create({
    data: {
      externalPaymentId: `plink_failure_${suffix}`,
      amountPaise: 49900,
      status: 'failed',
      reasonCode: 'gateway_technical_error',
      source: 'gateway',
      type: 'payment',
      customerId: 'webhook_failure_test',
      expectedRecoveryOutcome: 'never_recovers',
    },
  });

  try {
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON "Transaction" WHEN OLD.id = '${transaction.id}' BEGIN SELECT RAISE(FAIL, 'forced webhook database failure'); END;`);
    const eventId = `evt_processing_failure_${suffix}`;
    const body = JSON.stringify({
      event: 'payment.captured',
      event_id: eventId,
      payload: { payment_link: { entity: { id: transaction.externalPaymentId, notes: { transactionId: transaction.id } } } },
    });
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const response = await POST(new NextRequest('http://localhost:3000/api/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature, 'x-razorpay-event-id': eventId },
      body,
    }));
    const passed = response.status === 500;
    console.log(`Valid new webhook with forced DB failure: ${response.status} (expected 500)`);
    console.log(passed ? '✅ WEBHOOK PROCESSING FAILURE: PASS' : '❌ WEBHOOK PROCESSING FAILURE: FAIL');
    if (!passed) process.exitCode = 1;
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName}`);
    await prisma.auditLog.deleteMany({ where: { transactionId: transaction.id } });
    await prisma.transaction.delete({ where: { id: transaction.id } });
    await prisma.$disconnect();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
