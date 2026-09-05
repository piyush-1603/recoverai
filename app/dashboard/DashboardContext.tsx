'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { animate } from 'framer-motion';
import { triggerDashboardDemo, simulateWebhookPayment } from './actions';
import { isSimulatedFallbackOutcome, isSuccessfulRecoveryOutcome } from '@/lib/recovery-outcomes';
import { calculateRoi } from '@/lib/roi-calculator';
import { ActionStatItem, AiDriftStats, WaterfallStats } from './RecoveryMatrixChart';

export type Stats = {
  totalTransactions: number;
  totalAtRiskPaise: number;
  totalRecoveredPaise: number;
  recoveryRate: number;
  recoveredCount: number;
  unrecoverableCount: number;
  pendingCount: number;
  failedCount?: number;
  deferredCount?: number;
  openCount?: number;
  complianceHoldCount?: number;
  messagingSpendPaise?: number;
  messagingSpendEstimatedPaise?: number;
  netRecoveredPaise?: number;
};

export type ComplianceHoldItem = {
  transactionId: string;
  externalPaymentId?: string;
  amountPaise: number;
  reason: string;
  action: string;
  timestamp: string;
  aiRecommendation?: any;
};

export type AuditLog = {
  id: string;
  transactionId: string;
  eventId: string;
  actor: string;
  action: string;
  reason: string;
  result: string;
  timestamp: string;
  policyVersion?: string;
  provider?: string | null;
  model?: string | null;
  amountPaise?: number | null;
  recoveredAmountPaise?: number | null;
  simulated?: boolean;
  ruleId?: string | null;
  channel?: string | null;
  messagingCostPaise?: number | null;
  razorpayEntityId?: string | null;
  providerLatencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  aiRecommendedAction?: string | null;
  aiReasoning?: string | null;
  aiPrompt?: string | null;
  metadata?: string | null;
};

export type ExceptionItem = {
  id: string;
  externalPaymentId: string | null;
  amountPaise: number;
  source: string;
  type: string;
  reasonCode: string;
  createdAt: string;
};

export function formatRupees(paise: number) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatLakhsOrCrores(rupees: number) {
  if (rupees >= 10000000) {
    return `₹${(rupees / 10000000).toFixed(2)} Cr`;
  }
  if (rupees >= 100000) {
    return `₹${(rupees / 100000).toFixed(1)} Lakh`;
  }
  return `₹${rupees.toLocaleString('en-IN')}`;
}

export function formatTime(iso: string) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

// Animated count-up component for Rupee values
export function CountUpRupees({ valuePaise, duration = 0.75 }: { valuePaise: number; duration?: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  const prevValue = useRef(0);

  useEffect(() => {
    const start = prevValue.current;
    const end = valuePaise;
    prevValue.current = end;

    const controls = animate(start, end, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        setDisplayValue(Math.round(latest));
      },
    });

    return () => controls.stop();
  }, [valuePaise, duration]);

  return <span>{formatRupees(displayValue)}</span>;
}

// Animated count-up component for numeric counts and percentages
export function CountUpNumber({
  value,
  suffix = '',
  decimals = 0,
  duration = 0.75,
}: {
  value: number;
  suffix?: string;
  decimals?: number;
  duration?: number;
}) {
  const [displayValue, setDisplayValue] = useState(0);
  const prevValue = useRef(0);

  useEffect(() => {
    const start = prevValue.current;
    const end = value;
    prevValue.current = end;

    const controls = animate(start, end, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (latest) => {
        setDisplayValue(decimals > 0 ? Number(latest.toFixed(decimals)) : Math.round(latest));
      },
    });

    return () => controls.stop();
  }, [value, duration, decimals]);

  return (
    <span>
      {decimals > 0 ? displayValue.toFixed(decimals) : displayValue}
      {suffix}
    </span>
  );
}

const RESULT_LABELS: Record<string, string> = {
  retry_simulated_fallback: 'simulated fallback / unconfirmed',
  retry_simulated_fallback_no_recovery: 'simulated fallback / no recovery',
  webhook_processed: 'recovered via webhook',
  compliance_deferred: 'compliance hold (TRAI)',
};

export function resultLabel(result: string) {
  return RESULT_LABELS[result] ?? result.replace(/_/g, ' ');
}

export function resultTone(result: string) {
  return isSimulatedFallbackOutcome(result)
    ? 'warning'
    : isSuccessfulRecoveryOutcome(result)
    ? 'success'
    : result.includes('unrecoverable') || result.includes('failed')
    ? 'danger'
    : result.includes('overridden') || result.includes('hold') || result.includes('compliance')
    ? 'warning'
    : 'neutral';
}

export function tierFromReason(reason: string) {
  return reason.match(/\b(vip|standard|trial)\b/i)?.[1]?.toUpperCase();
}

export function policySignal(log: AuditLog) {
  if (log.actor !== 'policy_engine_override') return null;
  return {
    ai: log.aiRecommendedAction || (log.reason.match(/recommended [“"]([^”"]+)[”"]/)?.[1] ?? 'recommendation'),
    enforced: log.reason.match(/policy engine enforced [“"]([^”"]+)[”"]/)?.[1] ?? log.action,
  };
}

export function generateReplayCurl(log: AuditLog | null): string {
  if (!log) return '';
  const entityId = log.razorpayEntityId || 'pay_sim_' + log.id.slice(-8);
  const amount = log.amountPaise || 49900;
  return `curl -X POST http://localhost:3000/api/webhook \\
  -H "Content-Type: application/json" \\
  -H "x-razorpay-signature: [SIMULATED_HMAC_SHA256]" \\
  -d '{
    "entity": "event",
    "event": "payment.captured",
    "contains": ["payment"],
    "payload": {
      "payment": {
        "entity": {
          "id": "${entityId}",
          "amount": ${amount},
          "currency": "INR",
          "status": "captured",
          "order_id": "order_${log.transactionId.slice(-8)}",
          "notes": { "transactionId": "${log.transactionId}" }
        }
      }
    }
  }'`;
}

export interface DashboardContextType {
  stats: Stats | null;
  auditLogs: AuditLog[];
  exceptions: ExceptionItem[];
  actionStats: ActionStatItem[];
  aiDriftStats: AiDriftStats | undefined;
  waterfallStats: WaterfallStats | undefined;
  loading: boolean;
  isRefreshing: boolean;
  refreshCompleted: boolean;
  lastRefreshed: Date;
  newLogIds: Set<string>;
  istTime: Date;
  istHour: number;
  isTraiOpen: boolean;
  policyVersion: string;
  triggering: 'live' | 'compliance' | null;
  triggerNotification: string | null;
  setTriggerNotification: (msg: string | null) => void;
  paymentLink: {
    url: string;
    linkId: string;
    amountPaise: number;
    transactionId: string;
  } | null;
  setPaymentLink: React.Dispatch<
    React.SetStateAction<{
      url: string;
      linkId: string;
      amountPaise: number;
      transactionId: string;
    } | null>
  >;
  complianceHold: ComplianceHoldItem | null;
  setComplianceHold: React.Dispatch<React.SetStateAction<ComplianceHoldItem | null>>;
  dismissComplianceHold: () => void;
  liveRecovery: {
    id: string;
    amountPaise: number;
    resolvedAt: string | null;
    paymentId: string | null;
  } | null;
  selectedLog: AuditLog | null;
  setSelectedLog: (log: AuditLog | null) => void;
  showTerminal: boolean;
  setShowTerminal: (show: boolean) => void;
  showShortcuts: boolean;
  setShowShortcuts: (show: boolean) => void;
  showRoiModal: boolean;
  setShowRoiModal: (show: boolean) => void;
  showWebhookModal: boolean;
  setShowWebhookModal: (show: boolean) => void;
  isSimulatingWebhook: boolean;
  roiGmv: number;
  setRoiGmv: (val: number) => void;
  roiFailureRate: number;
  setRoiFailureRate: (val: number) => void;
  roiAov: number;
  setRoiAov: (val: number) => void;
  roiWaShare: number;
  setRoiWaShare: (val: number) => void;
  roiProjection: any;
  handleManualRefresh: () => Promise<void>;
  handleTrigger: (kind: 'live' | 'compliance') => Promise<void>;
  handleSimulateWebhook: (targetTxId?: string) => Promise<void>;
}

const DashboardContext = createContext<DashboardContextType | null>(null);

export function DashboardProvider({ children }: { children: React.ReactNode }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [actionStats, setActionStats] = useState<ActionStatItem[]>([]);
  const [aiDriftStats, setAiDriftStats] = useState<AiDriftStats | undefined>(undefined);
  const [waterfallStats, setWaterfallStats] = useState<WaterfallStats | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshCompleted, setRefreshCompleted] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(new Date());
  const knownLogIds = useRef(new Set<string>());
  const [newLogIds, setNewLogIds] = useState<Set<string>>(new Set());

  // Interactive UI state
  const [istTime, setIstTime] = useState<Date>(new Date());
  const [selectedLog, setSelectedLog] = useState<AuditLog | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showRoiModal, setShowRoiModal] = useState(false);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [isSimulatingWebhook, setIsSimulatingWebhook] = useState(false);
  const [triggering, setTriggering] = useState<'live' | 'compliance' | null>(null);
  const [triggerNotification, setTriggerNotification] = useState<string | null>(null);
  const [paymentLink, setPaymentLink] = useState<{
    url: string;
    linkId: string;
    amountPaise: number;
    transactionId: string;
  } | null>(null);
  const [complianceHold, setComplianceHold] = useState<ComplianceHoldItem | null>(null);
  const complianceHoldDismissed = useRef(false);
  const [liveRecovery, setLiveRecovery] = useState<{
    id: string;
    amountPaise: number;
    resolvedAt: string | null;
    paymentId: string | null;
  } | null>(null);

  // ROI Calculator input state
  const [roiGmv, setRoiGmv] = useState(10000000); // ₹1 Crore
  const [roiFailureRate, setRoiFailureRate] = useState(20); // 20%
  const [roiAov, setRoiAov] = useState(1500); // ₹1,500
  const [roiWaShare, setRoiWaShare] = useState(60); // 60%

  // Live IST Clock
  useEffect(() => {
    const timer = setInterval(() => setIstTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const istHour = useMemo(() => {
    const hourStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      hour12: false,
    }).format(istTime);
    return parseInt(hourStr, 10);
  }, [istTime]);

  const isTraiOpen = istHour >= 10 && istHour < 21;

  const roiProjection = useMemo(() => {
    return calculateRoi({
      monthlyGmvRupees: roiGmv,
      failureRatePercent: roiFailureRate,
      averageOrderValueRupees: roiAov,
      whatsAppSharePercent: roiWaShare,
    });
  }, [roiGmv, roiFailureRate, roiAov, roiWaShare]);

  const fetchData = async () => {
    try {
      const response = await fetch('/api/audit');
      if (!response.ok) return;
      const data = await response.json();
      const received: AuditLog[] = data.auditLogs || [];
      setNewLogIds(
        new Set(
          knownLogIds.current.size ? received.filter((entry) => !knownLogIds.current.has(entry.id)).map((entry) => entry.id) : []
        )
      );
      knownLogIds.current = new Set(received.map((entry) => entry.id));
      setStats(data.stats);
      setAuditLogs(received);
      setExceptions(data.exceptions || []);
      if (data.actionStats) setActionStats(data.actionStats);
      if (data.aiDriftStats) setAiDriftStats(data.aiDriftStats);
      if (data.waterfallStats) setWaterfallStats(data.waterfallStats);
      setLastRefreshed(new Date());

      if (data.liveDemo?.lastRecovered) {
        setLiveRecovery(data.liveDemo.lastRecovered);
        setPaymentLink((current) => {
          if (current && current.transactionId === data.liveDemo.lastRecovered.id) {
            return null;
          }
          return current;
        });
      }

      if (data.liveDemo?.latestComplianceHold && !complianceHoldDismissed.current) {
        setComplianceHold((current) => current ?? data.liveDemo.latestComplianceHold);
      }
    } catch (error) {
      console.error('Failed to poll /api/audit:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleManualRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    setRefreshCompleted(false);
    try {
      await Promise.all([
        fetchData(),
        new Promise((resolve) => setTimeout(resolve, 650)),
      ]);
      setRefreshCompleted(true);
      setTimeout(() => setRefreshCompleted(false), 1400);
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = window.setInterval(fetchData, 3000);
    return () => window.clearInterval(interval);
  }, []);

  const handleTrigger = async (kind: 'live' | 'compliance') => {
    setTriggering(kind);
    setTriggerNotification(null);
    if (kind === 'live') {
      setPaymentLink(null);
    }
    try {
      const data = await triggerDashboardDemo(kind);
      const action = data.decision?.action?.replace(/_/g, ' ').toUpperCase() || 'EVENT';
      setTriggerNotification(
        `${kind === 'compliance' ? 'Compliance test' : 'Live event'} recorded — ${action} on #${data.transactionId?.slice(-8)}. ${
          data.decision?.reason || ''
        }`
      );

      if (kind === 'compliance') {
        complianceHoldDismissed.current = false;
        setComplianceHold({
          transactionId: data.transactionId,
          externalPaymentId: data.externalPaymentId || 'pay_demo_compliance_01',
          amountPaise: data.amountPaise || 49900,
          reason: data.decision?.reason || 'outside compliant nudge window (TRAI SMS timing rules), deferred to next window',
          action: data.decision?.action || 'no_action',
          timestamp: data.timestamp || new Date().toISOString(),
          aiRecommendation: data.aiRecommendation,
        });
      }

      if (data.result?.razorpayDetails?.shortUrl) {
        setPaymentLink({
          url: data.result.razorpayDetails.shortUrl,
          linkId: data.result.razorpayDetails.paymentLinkId,
          amountPaise: data.amountPaise || 49900,
          transactionId: data.transactionId,
        });
      }

      await fetchData();
    } catch (error) {
      console.error('Trigger error:', error);
      setTriggerNotification('The live trigger could not be completed. Check the server log and retry.');
    } finally {
      setTriggering(null);
    }
  };

  const handleSimulateWebhook = async (targetTxId?: string) => {
    if (isSimulatingWebhook) return;
    setIsSimulatingWebhook(true);
    try {
      const res = await simulateWebhookPayment(targetTxId ? { transactionId: targetTxId } : undefined);
      const amountPaise = res.amountPaise ?? res.transaction?.amountPaise ?? 249900;
      const paymentId = res.simulatedPaymentId ?? 'pay_sim';
      const txId = res.transaction?.id ?? res.transactionId ?? 'tx';
      setTriggerNotification(
        `⚡ Simulated Razorpay Webhook [${res.event}] captured ${formatRupees(amountPaise)} on #${txId.slice(-8)} · Payment ID: ${paymentId}`
      );
      await fetchData();
    } catch (error: any) {
      console.error('Webhook simulation failed:', error);
      setTriggerNotification(`Webhook simulation failed: ${error?.message || 'Server error'}`);
    } finally {
      setIsSimulatingWebhook(false);
    }
  };

  const dismissComplianceHold = () => {
    complianceHoldDismissed.current = true;
    setComplianceHold(null);
  };

  const policyVersion = auditLogs.find((log) => log.policyVersion)?.policyVersion || 'v1';

  return (
    <DashboardContext.Provider
      value={{
        stats,
        auditLogs,
        exceptions,
        actionStats,
        aiDriftStats,
        waterfallStats,
        loading,
        isRefreshing,
        refreshCompleted,
        lastRefreshed,
        newLogIds,
        istTime,
        istHour,
        isTraiOpen,
        policyVersion,
        triggering,
        triggerNotification,
        setTriggerNotification,
        paymentLink,
        setPaymentLink,
        complianceHold,
        setComplianceHold,
        dismissComplianceHold,
        liveRecovery,
        selectedLog,
        setSelectedLog,
        showTerminal,
        setShowTerminal,
        showShortcuts,
        setShowShortcuts,
        showRoiModal,
        setShowRoiModal,
        showWebhookModal,
        setShowWebhookModal,
        isSimulatingWebhook,
        roiGmv,
        setRoiGmv,
        roiFailureRate,
        setRoiFailureRate,
        roiAov,
        setRoiAov,
        roiWaShare,
        setRoiWaShare,
        roiProjection,
        handleManualRefresh,
        handleTrigger,
        handleSimulateWebhook,
      }}
    >
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error('useDashboard must be used within a DashboardProvider');
  }
  return context;
}
