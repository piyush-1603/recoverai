/**
 * /scripts/test-razorpay-call.ts
 *
 * Dedicated verification script that executes a live Razorpay test-mode API call
 * to create a Payment Link for an 'auto_retry' transaction.
 *
 * Prints the actual Razorpay API response payload.
 *
 * Run via: npx tsx --tsconfig tsconfig.scripts.json scripts/test-razorpay-call.ts
 */

import 'dotenv/config';
import { getRazorpayClient, createPaymentLink, hasValidRazorpayKeys, TEST_UPI_VPA } from '../lib/razorpay';
import { prisma } from '../lib/prisma';
import { executeAction } from '../lib/action-executor';

function hr(char = '─', len = 64): string {
  return char.repeat(len);
}

async function testRazorpayCall() {
  console.log('\n' + hr('═'));
  console.log('  💳  RAZORPAY TEST-MODE API CALL VERIFICATION');
  console.log(hr('═'));

  const keyId = process.env.RAZORPAY_KEY_ID;
  const hasKeys = hasValidRazorpayKeys();

  console.log(`  Key ID configured : ${keyId ? keyId.slice(0, 12) + '...' : 'None'}`);
  console.log(`  Valid keys found  : ${hasKeys ? 'YES ✓' : 'NO (Using placeholder keys) ⚠️'}\n`);

  if (!hasKeys) {
    console.log('  ⚠️  Notice: Placeholder credentials detected in .env.');
    console.log('      To execute real HTTP calls to api.razorpay.com, replace RAZORPAY_KEY_ID');
    console.log('      and RAZORPAY_KEY_SECRET in .env with your Razorpay Test Mode keys.');
    console.log('      Attempting SDK client call to demonstrate client wiring...\n');
  }

  // Find a gateway transaction
  const targetTx = await prisma.transaction.findFirst({
    where: {
      source: { in: ['gateway', 'razorpay'] },
      expectedRecoveryOutcome: 'recovers_on_retry',
    },
  });

  if (!targetTx) {
    console.log('  No suitable transaction found. Run `npm run seed` first.');
    process.exit(1);
  }

  console.log('  Target Transaction for Auto-Retry:');
  console.log(`    • ID          : ${targetTx.id}`);
  console.log(`    • Amount      : ₹${(targetTx.amountPaise / 100).toFixed(2)} (${targetTx.amountPaise} paise)`);
  console.log(`    • Source      : ${targetTx.source}`);
  console.log(`    • Reason Code : ${targetTx.reasonCode}`);
  console.log(`    • Test VPA    : ${TEST_UPI_VPA.success}\n`);

  try {
    console.log('  📡 Invoking Razorpay API: paymentLink.create()...');
    const paymentLink = await createPaymentLink(
      targetTx.amountPaise,
      `Auto-retry recovery test for ${targetTx.id}`,
      {
        name: `Customer ${targetTx.customerId}`,
        email: `${targetTx.customerId}@example.com`,
        contact: '+919876543210',
      },
      {
        transactionId: targetTx.id,
        merchantReference: `rcv_${targetTx.id.slice(0, 20)}`,
        originalReason: targetTx.reasonCode,
      },
      `test_rcv_${Date.now()}`,
    );

    console.log('\n  ✅ REAL RAZORPAY API RESPONSE RECEIVED:\n');
    console.log(JSON.stringify(paymentLink, null, 2));

    console.log('\n' + hr());
    console.log('  🎉 Live Razorpay Test Mode Call Succeeded!');
    console.log(`     • Payment Link ID : ${paymentLink.id}`);
    console.log(`     • Status          : ${paymentLink.status}`);
    console.log(`     • Short URL       : ${paymentLink.short_url}`);
    console.log(`     • Amount          : ₹${(Number(paymentLink.amount) / 100).toFixed(2)}`);
    console.log(hr('═') + '\n');
  } catch (error: any) {
    console.error('\n  ❌ Razorpay API Response / Error:\n');
    if (error?.error) {
      console.error(JSON.stringify(error.error, null, 2));
    } else {
      console.error(error?.message || error);
    }
    console.log('\n' + hr());
    console.log('  👉 Note: This error is expected if RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET');
    console.log('     contain placeholders. Once valid test keys are in .env, this will');
    console.log('     return the live Payment Link object.');
    console.log(hr('═') + '\n');
  }
}

testRazorpayCall()
  .catch((e) => {
    console.error('Fatal execution error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
