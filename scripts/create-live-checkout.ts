/**
 * /scripts/create-live-checkout.ts
 *
 * Generates a live Razorpay test-mode Payment Link for a real browser checkout test.
 *
 * Manual Payment Loop Steps:
 *  1. Run this script to generate a live Payment Link URL.
 *  2. Open the printed `short_url` in a browser.
 *  3. In Razorpay Checkout:
 *     - Success Test: Pay using UPI VPA "success@razorpay" (or a valid test card).
 *     - Failure Test: Pay using UPI VPA "failure@razorpay" (or a declining test card).
 *  4. Verify your local server received the webhook with a real Razorpay event ID (e.g. `evt_...`).
 *
 * Run via: npx tsx --tsconfig tsconfig.scripts.json scripts/create-live-checkout.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { diagnoseAndDecide } from '../lib/policy-engine';
import { executeAction } from '../lib/action-executor';
import { hasValidRazorpayKeys } from '../lib/razorpay';

function hr(char = '─', len = 70): string {
  return char.repeat(len);
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

async function main() {
  console.log('\n' + hr('═'));
  console.log('  💳  LIVE RAZORPAY CHECKOUT LINK GENERATOR');
  console.log(hr('═'));

  if (!hasValidRazorpayKeys()) {
    console.log('  ⚠️  RAZORPAY KEYS REQUIRED');
    console.log('      Please enter your live Razorpay Test Mode keys in `.env`:');
    console.log('      RAZORPAY_KEY_ID="rzp_test_..."');
    console.log('      RAZORPAY_KEY_SECRET="..."\n');
  }

  // Find a fresh unrecovered target transaction for retry
  let targetTx = await prisma.transaction.findFirst({
    where: {
      source: 'gateway',
      status: 'failed',
      recovered: false,
    },
  });

  if (!targetTx) {
    targetTx = await prisma.transaction.create({
      data: {
        externalPaymentId: `pay_live_test_${Date.now()}`,
        amountPaise: 49900, // ₹499.00
        status: 'failed',
        reasonCode: 'gateway_technical_error',
        source: 'gateway',
        type: 'payment',
        customerId: `cust_live_${Date.now().toString(36)}`,
        retryCount: 0,
        nudgeCount: 0,
        recovered: false,
        expectedRecoveryOutcome: 'recovers_on_retry',
        simulatedRecoveryAmountPaise: 49900,
      },
    });
  } else {
    // Reset status to clean state
    targetTx = await prisma.transaction.update({
      where: { id: targetTx.id },
      data: {
        status: 'failed',
        retryCount: 0,
        recovered: false,
        resolvedAt: null,
      },
    });
  }

  console.log('  Target Transaction:');
  console.log(`    • ID            : ${targetTx.id}`);
  console.log(`    • Amount        : ${rupees(targetTx.amountPaise)}`);
  console.log(`    • Source/Reason : ${targetTx.source} / ${targetTx.reasonCode}`);
  console.log(`    • Status        : ${targetTx.status} (recovered=${targetTx.recovered})\n`);

  const policyConfig = {
    afaThresholdPaise: 1500000,
    maxRetries: 1,
    maxNudges: 2,
    nudgeWindowStartHour: 10,
    nudgeWindowEndHour: 21,
  };

  const decision = diagnoseAndDecide(targetTx, policyConfig, 14);
  console.log(`  Policy Engine Decision: ${decision.action} ("${decision.reason}")`);

  console.log('  Invoking Action Executor & Razorpay API...\n');
  const result = await executeAction(decision, targetTx);

  const updatedTx = await prisma.transaction.findUniqueOrThrow({
    where: { id: targetTx.id },
  });

  console.log(hr());
  console.log('  🎯 CHECKOUT DETAILS READY FOR LIVE BROWSER TEST');
  console.log(hr());
  console.log(`  Transaction ID   : ${updatedTx.id}`);
  console.log(`  Status in DB     : ${updatedTx.status} (awaiting webhook payment confirmation)`);
  console.log(`  Payment Link ID  : ${result.razorpayDetails?.paymentLinkId || updatedTx.externalPaymentId}`);
  console.log(`  Checkout URL     : ${result.razorpayDetails?.shortUrl || 'https://rzp.io/i/...'}`);
  console.log(`  Amount Payable   : ${rupees(targetTx.amountPaise)}`);
  console.log('\n  👉 NEXT STEPS FOR MANUAL VERIFICATION:');
  console.log('  1. Ensure Next.js dev server is running (`npm run dev`) with ngrok / webhook forwarder active.');
  console.log('  2. Open the Checkout URL above in your browser.');
  console.log('  3. Choose UPI -> enter "success@razorpay" (or test card 4111 1111 1111 1111) and click Pay.');
  console.log('  4. When Razorpay webhook POSTs to /api/webhook, verify server logs and inspect AuditLog:');
  console.log(`     npx tsx --tsconfig tsconfig.scripts.json -e '...query AuditLog...'`);
  console.log(hr('═') + '\n');
}

main()
  .catch((e) => {
    console.error('Execution error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
