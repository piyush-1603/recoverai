/**
 * /data/seed-transactions.ts
 *
 * Deterministic and idempotent seed script that populates exactly 55 failed/pending
 * transactions for testing the recovery policy engine.
 *
 * Distribution Breakdown (Total = 55):
 *  1. Transient Gateway/Razorpay Errors (30 records):
 *     - 25 'recovers_on_retry', 5 'never_recovers'
 *     - reasonCodes: payment_timed_out, bank_technical_error, gateway_technical_error
 *  2. Customer Insufficient Funds (12 records):
 *     - 8 'recovers_on_nudge', 4 'never_recovers'
 *     - reasonCode: insufficient_funds
 *  3. Customer Card/Auth Issues (6 records):
 *     - 3 'recovers_on_nudge', 3 'never_recovers'
 *     - reasonCodes: card_declined, authentication_failed
 *  4. High-Value Subscriptions > ₹15k AFA threshold (4 records):
 *     - 3 'requires_approval_then_recovers', 1 'never_recovers'
 *     - reasonCode: payment_pending_approval
 *  5. Flagged Blocked Codes / Non-Retryable (3 records):
 *     - 3 'never_recovers'
 *     - reasonCodes: payment_risk_check_failed, transaction_daily_limit_exceeded
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
  customerId: string;
  retryCount: number;
  nudgeCount: number;
  createdAt: Date;
  recovered: boolean;
  expectedRecoveryOutcome: string;
  simulatedRecoveryAmountPaise: number | null;
};

export async function seedDatabase() {
  console.log('\n' + '═'.repeat(60));
  console.log('  🌱  RECOVERY ENGINE — DATABASE SEED');
  console.log('═'.repeat(60));

  // 1. Ensure default PolicyConfig exists
  const existingConfig = await prisma.policyConfig.findFirst();
  if (!existingConfig) {
    await prisma.policyConfig.create({
      data: {
        afaThresholdPaise: 1500000, // ₹15,000
        maxRetries: 1,
        maxNudges: 2,
        nudgeWindowStartHour: 10,
        nudgeWindowEndHour: 21,
      },
    });
    console.log('✓ Initialized default PolicyConfig (₹15,000 AFA threshold, window 10-21 IST)');
  }

  // 2. Clear existing records for complete idempotency
  await prisma.auditLog.deleteMany();
  await prisma.transaction.deleteMany();
  console.log('✓ Cleared all existing AuditLog and Transaction records');

  const seeds: TransactionSeed[] = [];
  let seq = 1;

  const getRecentDate = (offsetMinutes: number) => {
    // Deterministic spread over last 5 days
    const now = new Date('2026-08-29T10:00:00.000Z').getTime();
    return new Date(now - offsetMinutes * 60 * 1000);
  };

  // ── Group 1: 30 Gateway/Razorpay Transient Errors ────────────────────────
  // 25 recovers_on_retry, 5 never_recovers
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
    seeds.push({
      externalPaymentId: `pay_test_gw_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: group1ReasonCodes[i % group1ReasonCodes.length],
      source: group1Sources[i % group1Sources.length],
      type: 'payment',
      customerId: `cust_gw_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 120),
      recovered: false,
      expectedRecoveryOutcome: outcome,
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // ── Group 2: 12 Customer Insufficient Funds ──────────────────────────────
  // 8 recovers_on_nudge, 4 never_recovers
  for (let i = 0; i < 12; i++) {
    const isRecoverable = i < 8;
    const amount = SMALL_AMOUNTS_PAISE[i % SMALL_AMOUNTS_PAISE.length];
    const outcome = isRecoverable ? 'recovers_on_nudge' : 'never_recovers';
    seeds.push({
      externalPaymentId: `pay_test_funds_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: 'insufficient_funds',
      source: 'customer',
      type: 'payment',
      customerId: `cust_funds_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 150),
      recovered: false,
      expectedRecoveryOutcome: outcome,
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // ── Group 3: 6 Customer Card / Auth Issues ───────────────────────────────
  // 3 recovers_on_nudge, 3 never_recovers
  const group3ReasonCodes = ['card_declined', 'authentication_failed'];
  for (let i = 0; i < 6; i++) {
    const isRecoverable = i < 3;
    const amount = SMALL_AMOUNTS_PAISE[i % SMALL_AMOUNTS_PAISE.length];
    const outcome = isRecoverable ? 'recovers_on_nudge' : 'never_recovers';
    seeds.push({
      externalPaymentId: `pay_test_card_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: group3ReasonCodes[i % group3ReasonCodes.length],
      source: 'customer',
      type: 'payment',
      customerId: `cust_card_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 180),
      recovered: false,
      expectedRecoveryOutcome: outcome,
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // ── Group 4: 4 High-Value Subscriptions (> ₹15k AFA) ─────────────────────
  // 3 requires_approval_then_recovers, 1 never_recovers
  for (let i = 0; i < 4; i++) {
    const isRecoverable = i < 3;
    const amount = SUBSCRIPTION_AMOUNTS_PAISE[i];
    const outcome = isRecoverable ? 'requires_approval_then_recovers' : 'never_recovers';
    seeds.push({
      externalPaymentId: `pay_test_sub_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: 'payment_pending_approval',
      source: 'business',
      type: 'subscription',
      customerId: `cust_sub_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 200),
      recovered: false,
      expectedRecoveryOutcome: outcome,
      simulatedRecoveryAmountPaise: isRecoverable ? amount : null,
    });
    seq++;
  }

  // ── Group 5: 3 Blocked / Non-Retryable Compliance Codes ──────────────────
  // 3 never_recovers
  const group5ReasonCodes = [
    'payment_risk_check_failed',
    'transaction_daily_limit_exceeded',
    'payment_risk_check_failed',
  ];
  for (let i = 0; i < 3; i++) {
    const amount = SMALL_AMOUNTS_PAISE[i % SMALL_AMOUNTS_PAISE.length];
    seeds.push({
      externalPaymentId: `pay_test_risk_${String(seq).padStart(3, '0')}`,
      amountPaise: amount,
      status: 'failed',
      reasonCode: group5ReasonCodes[i],
      source: 'gateway',
      type: 'payment',
      customerId: `cust_risk_${String(seq).padStart(3, '0')}`,
      retryCount: 0,
      nudgeCount: 0,
      createdAt: getRecentDate(seq * 220),
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
  if (totalCount !== 55) {
    throw new Error(`❌ SEED VALIDATION FAILED: Expected exactly 55 transactions, but found ${totalCount}`);
  }

  console.log(`✓ Inserted and verified exactly ${totalCount} transactions\n`);

  // 5. Grouped Distributions
  const allTxs = await prisma.transaction.findMany();

  const bySource = allTxs.reduce<Record<string, number>>((acc, tx) => {
    acc[tx.source] = (acc[tx.source] || 0) + 1;
    return acc;
  }, {});

  const byType = allTxs.reduce<Record<string, number>>((acc, tx) => {
    acc[tx.type] = (acc[tx.type] || 0) + 1;
    return acc;
  }, {});

  const byReasonCode = allTxs.reduce<Record<string, number>>((acc, tx) => {
    acc[tx.reasonCode] = (acc[tx.reasonCode] || 0) + 1;
    return acc;
  }, {});

  const byOutcome = allTxs.reduce<Record<string, { count: number; amountPaise: number }>>((acc, tx) => {
    if (!acc[tx.expectedRecoveryOutcome]) {
      acc[tx.expectedRecoveryOutcome] = { count: 0, amountPaise: 0 };
    }
    acc[tx.expectedRecoveryOutcome].count += 1;
    acc[tx.expectedRecoveryOutcome].amountPaise += tx.amountPaise;
    return acc;
  }, {});

  console.log('  📊 Grouped Counts:\n');
  console.log('  [By Source]');
  for (const [k, v] of Object.entries(bySource)) {
    console.log(`    • ${k.padEnd(16)}: ${v} records`);
  }

  console.log('\n  [By Type]');
  for (const [k, v] of Object.entries(byType)) {
    console.log(`    • ${k.padEnd(16)}: ${v} records`);
  }

  console.log('\n  [By Reason Code]');
  for (const [k, v] of Object.entries(byReasonCode)) {
    console.log(`    • ${k.padEnd(36)}: ${v} records`);
  }

  console.log('\n  [By Expected Outcome]');
  let totalAtRisk = 0;
  for (const [k, v] of Object.entries(byOutcome)) {
    totalAtRisk += v.amountPaise;
    console.log(`    • ${k.padEnd(36)}: ${String(v.count).padStart(2)} records  (${rupees(v.amountPaise).padStart(12)})`);
  }

  console.log('\n  ' + '─'.repeat(56));
  console.log(`  Total Dataset Size: ${totalCount} transactions (${rupees(totalAtRisk)})`);
  console.log('  ' + '═'.repeat(60) + '\n');
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
