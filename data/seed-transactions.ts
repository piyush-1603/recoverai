/**
 * /data/seed-transactions.ts
 *
 * Deterministic and idempotent seed script that populates exactly 65 transactions:
 *  - 55 failed/pending payment transactions (gateway, customer, subscription, risk)
 *  - 10 checkout abandonment transactions with varying abandonedAt timestamps
 *  - Customer tier distribution: ~15% VIP, ~70% Standard, ~15% Trial
 *
 * Designed Scenarios:
 *  1. VIP auto-retries with up to 3 retry limit tolerance.
 *  2. Designed AI Recommendation vs Policy Conflict Edge-Cases:
 *     - Flagged Risk Code on VIP / High-Value (AI: auto_retry -> Policy: stop_unrecoverable)
 *     - Large Subscription > ₹15k AFA (AI: auto_retry -> Policy: request_approval)
 *     - Premature Cart Abandonment < 1h (AI: send_nudge -> Policy: no_action)
 *
 * Run via: npm run seed  OR  npx tsx --tsconfig tsconfig.scripts.json data/seed-transactions.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';

// Realistic INR amounts in paise
const SMALL_AMOUNTS_PAISE = [
  49900,   // ₹499
  99900,   // ₹999
  149900,  // ₹1,499
  299900,  // ₹2,999
  799900,  // ₹7,999
  1499900, // ₹14,999
];

const SUBSCRIPTION_AMOUNTS_PAISE = [
  1800000, // ₹18,000
  2500000, // ₹25,000
  3999900, // ₹39,999
  4999900, // ₹49,999
];

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

type TransactionSeed = {
  externalPaymentId: string;
  amountPaise: number;
  status: string;
  reasonCode: string;
  source: string;
  type: string;
  customerTier: string; // 'vip' | 'standard' | 'trial'
  customerId: string;
  retryCount: number;
  nudgeCount: number;
  createdAt: Date;
  abandonedAt?: Date | null;
  recovered: boolean;
  expectedRecoveryOutcome: string;
  simulatedRecoveryAmountPaise: number | null;
};

export async function seedDatabase() {
  console.log('\n' + '═'.repeat(64));
  console.log('  🌱  RECOVERY ENGINE — DATABASE SEED (65 TRANSACTIONS + TIERS)');
  console.log('═'.repeat(64));

  // 1. Ensure default PolicyConfig exists with tier-based retry limits
  await prisma.policyConfig.deleteMany();
  await prisma.policyConfig.create({
    data: {
      afaThresholdPaise: 1500000, // ₹15,000
      maxRetries: 1,
      vipMaxRetries: 3,
      standardMaxRetries: 1,
      trialMaxRetries: 1,
      maxNudges: 2,
      nudgeWindowStartHour: 10,
      nudgeWindowEndHour: 21,
    },
  });
  console.log('✓ Initialized default PolicyConfig (VIP maxRetries: 3, Standard: 1, Trial: 1)');

  // 2. Clear existing records for complete idempotency
  await prisma.auditLog.deleteMany();
  await prisma.transaction.deleteMany();
  console.log('✓ Cleared all existing AuditLog and Transaction records');

  const seeds: TransactionSeed[] = [];
  let seq = 1;

  const nowBase = Date.now();
  const getRecentDate = (offsetMinutes: number) => {
    return new Date(nowBase - offsetMinutes * 60 * 1000);
  };

  // Tier helper: ~15% VIP, ~70% Standard, ~15% Trial
  const getTier = (index: number): string => {
    const mod = index % 10;
    if (mod === 0) return 'vip';       // 10%
    if (mod === 5) return 'vip';       // +10% -> ~20% VIP
    if (mod === 9) return 'trial';     // ~10% Trial
    if (mod === 4) return 'trial';     // ~10% Trial
    return 'standard';                 // ~60-70% Standard
  };

  // ── Group 1: 30 Gateway/Razorpay Transient Errors ────────────────────────
  const group1ReasonCodes = [
    'payment_timed_out',
    'bank_technical_error',
    'gateway_technical_error',
  ];
  const group1Sources = ['gateway', 'razorpay'];

  for (let i = 0; i < 30; i++) {
    const isRecoverable = i < 25;
    const amount = SMALL_AMOUNTS_PAISE[i % SMALL_AMOUNTS_PAISE.length];
    const outcome = isRecoverable ? 'recovers_on_retry' : 'never_recovers';
    const tier = getTier(i);
    seeds.push({
      externalPaymentId: `pay_test_gw_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: group1ReasonCodes[i % group1ReasonCodes.length],
      source: group1Sources[i % group1Sources.length],
      type: 'payment',
      customerTier: tier,
      customerId: `cust_gw_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 60),
      recovered: false,
      expectedRecoveryOutcome: outcome,
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // ── Group 2: 12 Customer Insufficient Funds ──────────────────────────────
  for (let i = 0; i < 12; i++) {
    const isRecoverable = i < 8;
    const amount = SMALL_AMOUNTS_PAISE[i % SMALL_AMOUNTS_PAISE.length];
    const outcome = isRecoverable ? 'recovers_on_nudge' : 'never_recovers';
    const tier = getTier(i + 30);
    seeds.push({
      externalPaymentId: `pay_test_funds_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: 'insufficient_funds',
      source: 'customer',
      type: 'payment',
      customerTier: tier,
      customerId: `cust_funds_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 80),
      recovered: false,
      expectedRecoveryOutcome: outcome,
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // ── Group 3: 6 Customer Card / Auth Issues ───────────────────────────────
  const group3ReasonCodes = ['card_declined', 'authentication_failed'];
  for (let i = 0; i < 6; i++) {
    const isRecoverable = i < 3;
    const amount = SMALL_AMOUNTS_PAISE[i % SMALL_AMOUNTS_PAISE.length];
    const outcome = isRecoverable ? 'recovers_on_nudge' : 'never_recovers';
    const tier = getTier(i + 42);
    seeds.push({
      externalPaymentId: `pay_test_card_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: group3ReasonCodes[i % group3ReasonCodes.length],
      source: 'customer',
      type: 'payment',
      customerTier: tier,
      customerId: `cust_card_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 90),
      recovered: false,
      expectedRecoveryOutcome: outcome,
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // ── Group 4: 4 High-Value Subscriptions (> ₹15k AFA) ─────────────────────
  for (let i = 0; i < 4; i++) {
    const isRecoverable = i < 3;
    const amount = SUBSCRIPTION_AMOUNTS_PAISE[i];
    const outcome = isRecoverable ? 'requires_approval_then_recovers' : 'never_recovers';
    // Make 2 of them VIP to induce realistic AI auto-retry preference
    const tier = i === 2 ? 'vip' : 'standard';
    seeds.push({
      externalPaymentId: `pay_test_sub_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: 'payment_pending_approval',
      source: 'business',
      type: 'subscription',
      customerTier: tier,
      customerId: `cust_sub_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 100),
      recovered: false,
      expectedRecoveryOutcome: outcome,
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // ── Group 5: 3 Blocked / Non-Retryable Compliance Codes ──────────────────
  const group5ReasonCodes = [
    'payment_risk_check_failed',
    'transaction_daily_limit_exceeded',
    'payment_risk_check_failed',
  ];
  for (let i = 0; i < 3; i++) {
    const amount = SMALL_AMOUNTS_PAISE[i % SMALL_AMOUNTS_PAISE.length];
    // Assign VIP to risk check to trigger AI vs Policy override
    const tier = i === 0 ? 'vip' : 'standard';
    seeds.push({
      externalPaymentId: `pay_test_risk_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: group5ReasonCodes[i],
      source: 'gateway',
      type: 'payment',
      customerTier: tier,
      customerId: `cust_risk_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 110),
      recovered: false,
      expectedRecoveryOutcome: 'never_recovers',
      simulatedRecoveryAmountPaise: null,
    });
    seq++;
  }

  // ── Group 6: 10 Checkout Abandonment Transactions ─────────────────────────
  // Sub-group A: 2 records abandoned < 1 hour ago (30 mins ago) -> too soon
  for (let i = 0; i < 2; i++) {
    const amount = SMALL_AMOUNTS_PAISE[(i + 1) % SMALL_AMOUNTS_PAISE.length];
    const abandonedTime = new Date(nowBase - 30 * 60 * 1000); // 30 mins ago
    seeds.push({
      externalPaymentId: `cart_abnd_recent_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'pending',
      reasonCode: '',
      source: 'customer',
      type: 'checkout_abandon',
      customerTier: 'standard',
      customerId: `cust_abnd_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: abandonedTime,
      abandonedAt: abandonedTime,
      recovered: false,
      expectedRecoveryOutcome: 'recovers_on_nudge',
      simulatedRecoveryAmountPaise: amount,
    });
    seq++;
  }

  // Sub-group B: 5 records abandoned 1-24 hours ago (4 to 8 hours ago) -> active nudge window
  for (let i = 0; i < 5; i++) {
    const isRecoverable = i < 3;
    const amount = SMALL_AMOUNTS_PAISE[(i + 2) % SMALL_AMOUNTS_PAISE.length];
    const hoursAgo = 4 + i;
    const abandonedTime = new Date(nowBase - hoursAgo * 60 * 60 * 1000);
    const tier = i === 0 ? 'vip' : 'standard';
    seeds.push({
      externalPaymentId: `cart_abnd_active_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'pending',
      reasonCode: '',
      source: 'customer',
      type: 'checkout_abandon',
      customerTier: tier,
      customerId: `cust_abnd_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: abandonedTime,
      abandonedAt: abandonedTime,
      recovered: false,
      expectedRecoveryOutcome: isRecoverable ? 'recovers_on_nudge' : 'never_recovers',
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // Sub-group C: 3 records abandoned > 24 hours ago (36-48 hours ago) -> expired window
  for (let i = 0; i < 3; i++) {
    const amount = SMALL_AMOUNTS_PAISE[(i + 3) % SMALL_AMOUNTS_PAISE.length];
    const hoursAgo = 36 + i * 6;
    const abandonedTime = new Date(nowBase - hoursAgo * 60 * 60 * 1000);
    seeds.push({
      externalPaymentId: `cart_abnd_expired_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'pending',
      reasonCode: '',
      source: 'customer',
      type: 'checkout_abandon',
      customerTier: 'trial',
      customerId: `cust_abnd_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: abandonedTime,
      abandonedAt: abandonedTime,
      recovered: false,
      expectedRecoveryOutcome: 'never_recovers',
      simulatedRecoveryAmountPaise: null,
    });
    seq++;
  }

  // 3. Batch insert all records
  await prisma.transaction.createMany({ data: seeds });

  // 4. Explicit Assertions & Validation
  const totalCount = await prisma.transaction.count();
  if (totalCount !== 65) {
    throw new Error(`❌ SEED VALIDATION FAILED: Expected exactly 65 transactions, but found ${totalCount}`);
  }

  console.log(`✓ Inserted and verified exactly ${totalCount} transactions (55 payment + 10 abandonment)\n`);

  // 5. Grouped Distributions
  const allTxs = await prisma.transaction.findMany();

  const byTier = allTxs.reduce<Record<string, number>>((acc: Record<string, number>, tx: any) => {
    acc[tx.customerTier] = (acc[tx.customerTier] || 0) + 1;
    return acc;
  }, {});

  const bySource = allTxs.reduce<Record<string, number>>((acc: Record<string, number>, tx: any) => {
    acc[tx.source] = (acc[tx.source] || 0) + 1;
    return acc;
  }, {});

  const byType = allTxs.reduce<Record<string, number>>((acc: Record<string, number>, tx: any) => {
    acc[tx.type] = (acc[tx.type] || 0) + 1;
    return acc;
  }, {});

  console.log('  📊 Grouped Counts:\n');
  console.log('  [By Customer Tier]');
  for (const [k, v] of Object.entries(byTier)) {
    const numVal = Number(v);
    const pct = ((numVal / totalCount) * 100).toFixed(0);
    console.log(`    • ${k.toUpperCase().padEnd(16)}: ${String(numVal).padStart(2)} records (${pct}%)`);
  }

  console.log('\n  [By Type]');
  for (const [k, v] of Object.entries(byType)) {
    console.log(`    • ${k.padEnd(20)}: ${v} records`);
  }

  console.log('\n  [By Source]');
  for (const [k, v] of Object.entries(bySource)) {
    console.log(`    • ${k.padEnd(20)}: ${v} records`);
  }

  console.log('\n  ' + '─'.repeat(60));
  console.log(`  Total Dataset Size: ${totalCount} transactions`);
  console.log('  ' + '═'.repeat(64) + '\n');
}

// Execute when run directly
if (require.main === module || process.argv[1]?.includes('seed-transactions')) {
  seedDatabase()
    .catch((e) => {
      console.error('❌ Seed failed:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
