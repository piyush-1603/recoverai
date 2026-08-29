/**
 * /lib/razorpay.ts
 *
 * Razorpay SDK client integration for test-mode API calls.
 * Provides helper functions for Order and Payment Link creation,
 * Payment fetching, webhook signature validation, and test trigger constants.
 */

import 'dotenv/config';
import Razorpay from 'razorpay';
import { validateWebhookSignature } from 'razorpay/dist/utils/razorpay-utils';

/**
 * Test Cards and UPI VPAs for simulating specific Razorpay test-mode outcomes.
 *
 * NOTE: The test card numbers below follow standard Razorpay test patterns.
 * Please cross-verify exact test card numbers against Razorpay's live documentation
 * (https://razorpay.com/docs/payments/payments/test-card-details/) prior to
 * triggering specific issuer-side simulated responses.
 */
export const TEST_CARDS = {
  success: '4111111111111111',
  timeout: '4100280000090000',
  declined: '4000000000001011',
  authentication_failed: '4000000000001029',
  insufficient_funds: '4000000000001037',
} as const;

export const TEST_UPI_VPA = {
  success: 'success@razorpay',
  failure: 'failure@razorpay',
} as const;

export type RazorpayPaymentLinkResult = {
  id: string;
  short_url: string;
  status: string;
  amount: number | string;
  currency: string;
  created_at?: number;
  [key: string]: any;
};

export type RazorpayOrderResult = {
  id: string;
  amount: number | string;
  currency: string;
  status: string;
  receipt?: string;
  [key: string]: any;
};

let razorpayInstance: Razorpay | null = null;

/**
 * Get or initialize the Razorpay client singleton.
 */
export function getRazorpayClient(): Razorpay {
  if (razorpayInstance) {
    return razorpayInstance;
  }

  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error(
      'Missing RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET in environment variables. Please check .env file.',
    );
  }

  razorpayInstance = new Razorpay({
    key_id,
    key_secret,
  });

  return razorpayInstance;
}

/**
 * Check if real Razorpay credentials are configured.
 */
export function hasValidRazorpayKeys(): boolean {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;
  return Boolean(
    key_id &&
      key_secret &&
      !key_id.includes('your_key_id') &&
      !key_secret.includes('your_key_secret'),
  );
}

/**
 * Create a Razorpay Order in test mode.
 */
export async function createOrder(
  amountPaise: number,
  receipt: string,
  notes?: Record<string, string>,
): Promise<RazorpayOrderResult> {
  const client = getRazorpayClient();
  const order = await (client.orders.create as any)({
    amount: amountPaise,
    currency: 'INR',
    receipt: receipt.slice(0, 40),
    notes,
  });
  return order as RazorpayOrderResult;
}

/**
 * Create a Razorpay Payment Link in test mode.
 */
export async function createPaymentLink(
  amountPaise: number,
  description: string,
  customerContact?: {
    name?: string;
    email?: string;
    contact?: string;
  },
  notes?: Record<string, string>,
  referenceId?: string,
): Promise<RazorpayPaymentLinkResult> {
  const client = getRazorpayClient();
  const payload: any = {
    amount: amountPaise,
    currency: 'INR',
    description: description.slice(0, 250),
    notify: {
      sms: false,
      email: false,
    },
    reminder_enable: false,
    notes,
    reference_id: referenceId ? referenceId.slice(0, 40) : undefined,
  };

  if (customerContact) {
    payload.customer = {
      name: customerContact.name || 'Test Customer',
      email: customerContact.email || 'customer@example.com',
      contact: customerContact.contact || '+919876543210',
    };
  }

  const paymentLink = await (client.paymentLink.create as any)(payload);
  return paymentLink as RazorpayPaymentLinkResult;
}

/**
 * Fetch Payment details from Razorpay by Payment ID.
 */
export async function fetchPayment(paymentId: string): Promise<any> {
  const client = getRazorpayClient();
  return (client.payments.fetch as any)(paymentId);
}

/**
 * Verify incoming webhook signature using Razorpay HMAC-SHA256 helper.
 */
export function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  if (!body || !signature || !secret) {
    return false;
  }
  try {
    return validateWebhookSignature(body, signature, secret);
  } catch (err) {
    console.error('Webhook signature verification error:', err);
    return false;
  }
}
