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
import { prisma } from './prisma';


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
 * Gracefully handles Razorpay's test mode limit of 30 total payment links by
 * detecting RATE_LIMIT_EXCEEDED (HTTP 429) and reusing an active unpaid 'created'
 * link with updated notes so live checkout and webhook delivery continue working.
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

  try {
    const paymentLink = await (client.paymentLink.create as any)(payload);
    return paymentLink as RazorpayPaymentLinkResult;
  } catch (err: any) {
    const errorDesc =
      err?.error?.description || err?.message || (typeof err === 'string' ? err : '');
    const isRateLimit =
      errorDesc.includes('limit of 30') ||
      err?.statusCode === 429 ||
      err?.error?.code === 'RATE_LIMIT_EXCEEDED';

    if (isRateLimit) {
      console.warn(
        '[Razorpay] Test mode 30-link cap reached. Finding an active unpaid payment link to reuse...',
      );
      try {
        const list = await (client.paymentLink as any).all({ count: 50 });
        const allLinks = list.payment_links || [];
        const active = allLinks.filter((l: any) => l.status === 'created');

        if (active.length > 0) {
          // Check which link IDs are already registered in the DB
          const used = await prisma.transaction.findMany({
            where: { externalPaymentId: { in: active.map((l: any) => l.id) } },
            select: { externalPaymentId: true },
          });
          const usedSet = new Set(used.map((t: any) => t.externalPaymentId));

          const unassigned = active.filter((l: any) => !usedSet.has(l.id));
          const chosen =
            unassigned.find((l: any) => l.amount === amountPaise) ||
            unassigned[0] ||
            active[0];

          if (chosen) {
            if (notes) {
              try {
                await (client.paymentLink as any).edit(chosen.id, { notes });
              } catch (editErr) {
                console.warn('[Razorpay] Link notes update skipped:', editErr);
              }
            }
            return {
              id: chosen.id,
              short_url: chosen.short_url,
              status: chosen.status,
              amount: chosen.amount,
              currency: chosen.currency,
              created_at: chosen.created_at,
            };
          }
        }
      } catch (reuseErr) {
        console.error('[Razorpay] Fallback link lookup error:', reuseErr);
      }
    }
    throw err;
  }
}

/**
 * Fetch Payment details from Razorpay by Payment ID.
 */
export async function fetchPayment(paymentId: string): Promise<any> {
  const client = getRazorpayClient();
  return (client.payments.fetch as any)(paymentId);
}

/**
 * Fetch a Payment Link by id, so a workflow can ask the gateway whether the
 * customer actually paid instead of guessing.
 *
 * Razorpay reports `status` as created | partially_paid | paid | cancelled |
 * expired, plus `amount_paid` in paise.
 */
export async function fetchPaymentLink(paymentLinkId: string): Promise<any> {
  const client = getRazorpayClient();
  return (client.paymentLink.fetch as any)(paymentLinkId);
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
