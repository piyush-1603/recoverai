/**
 * /lib/roi-calculator.ts
 *
 * Financial ROI & Salvage Modeling Engine for RecoverAI.
 *
 * Models merchant revenue recovery economics based on:
 * - Monthly At-Risk GMV
 * - Industry baseline payment failure rates in India (15% - 28%)
 * - RecoverAI benchmark recovery rate (57.8%)
 * - Carrier messaging costs: DLT-registered SMS (₹0.12) vs Meta WhatsApp Utility (₹0.48)
 *
 * Pure function — zero side effects, runnable client-side and server-side.
 */

export type RoiInputs = {
  monthlyGmvRupees: number;
  failureRatePercent: number; // e.g. 20 for 20%
  averageOrderValueRupees: number; // e.g. 1500 for ₹1,500
  recoveryRatePercent?: number; // defaults to 57.8% (RecoverAI benchmark)
  whatsAppSharePercent?: number; // percentage of nudges sent via WhatsApp vs SMS (default 60%)
};

export type RoiProjection = {
  monthlyGmvRupees: number;
  monthlyAtRiskRupees: number;
  failedTransactionsCount: number;
  recoveredTransactionsCount: number;
  grossRecoveredRupees: number;
  smsSentCount: number;
  whatsAppSentCount: number;
  totalMessagingCostRupees: number;
  netRecoveredRupees: number;
  roiMultiple: number; // e.g. 250x
  netMarginUpliftPercent: number; // percentage point lift on GMV
  annualizedGrossRecoveredRupees: number;
  annualizedNetRecoveredRupees: number;
};

export const COST_PER_SMS_RUPEES = 0.12;
export const COST_PER_WHATSAPP_RUPEES = 0.48;
export const BENCHMARK_RECOVERY_RATE_PERCENT = 57.8;

export function calculateRoi(inputs: RoiInputs): RoiProjection {
  const {
    monthlyGmvRupees,
    failureRatePercent,
    averageOrderValueRupees,
    recoveryRatePercent = BENCHMARK_RECOVERY_RATE_PERCENT,
    whatsAppSharePercent = 60,
  } = inputs;

  const safeGmv = Math.max(0, monthlyGmvRupees);
  const safeAov = Math.max(10, averageOrderValueRupees);
  const safeFailureRate = Math.min(100, Math.max(0, failureRatePercent)) / 100;
  const safeRecoveryRate = Math.min(100, Math.max(0, recoveryRatePercent)) / 100;
  const safeWaShare = Math.min(100, Math.max(0, whatsAppSharePercent)) / 100;

  // 1. Volumes
  const monthlyAtRiskRupees = safeGmv * safeFailureRate;
  const failedTransactionsCount = Math.round(monthlyAtRiskRupees / safeAov);
  const recoveredTransactionsCount = Math.round(failedTransactionsCount * safeRecoveryRate);
  const grossRecoveredRupees = Math.round(monthlyAtRiskRupees * safeRecoveryRate);

  // 2. Messaging costs (assuming ~1.4 nudges per failed customer transaction)
  const totalNudgesDispatched = Math.round(failedTransactionsCount * 0.75); // ~75% receive nudge, 25% are auto-retry (₹0 PG cost)
  const whatsAppSentCount = Math.round(totalNudgesDispatched * safeWaShare);
  const smsSentCount = totalNudgesDispatched - whatsAppSentCount;

  const totalMessagingCostRupees = Number(
    (smsSentCount * COST_PER_SMS_RUPEES + whatsAppSentCount * COST_PER_WHATSAPP_RUPEES).toFixed(2),
  );

  // 3. Net margins
  const netRecoveredRupees = Math.max(0, grossRecoveredRupees - totalMessagingCostRupees);
  const roiMultiple = totalMessagingCostRupees > 0
    ? Number((netRecoveredRupees / totalMessagingCostRupees).toFixed(1))
    : grossRecoveredRupees > 0 ? 999 : 0;

  const netMarginUpliftPercent = safeGmv > 0
    ? Number(((netRecoveredRupees / safeGmv) * 100).toFixed(2))
    : 0;

  return {
    monthlyGmvRupees: safeGmv,
    monthlyAtRiskRupees: Math.round(monthlyAtRiskRupees),
    failedTransactionsCount,
    recoveredTransactionsCount,
    grossRecoveredRupees,
    smsSentCount,
    whatsAppSentCount,
    totalMessagingCostRupees,
    netRecoveredRupees: Math.round(netRecoveredRupees),
    roiMultiple,
    netMarginUpliftPercent,
    annualizedGrossRecoveredRupees: grossRecoveredRupees * 12,
    annualizedNetRecoveredRupees: Math.round(netRecoveredRupees * 12),
  };
}
