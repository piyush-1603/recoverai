'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

export interface ActionStatItem {
  action: string;
  label: string;
  channel: string;
  recoveredCount: number;
  totalEvents: number;
  rate: number;
  recoveredPaise: number;
  tone: string;
  badge: string;
  description: string;
}

export interface AiDriftStats {
  alignmentIndex: number;
  consensualCount: number;
  interceptionCount: number;
  escalationCount: number;
  totalEvaluated: number;
}

export interface WaterfallStats {
  grossAtRiskPaise: number;
  exceptionsPaise: number;
  targetPoolPaise: number;
  grossRecoveredPaise: number;
  messagingSpendPaise: number;
  netRecoveredPaise: number;
}

interface RecoveryMatrixChartProps {
  actionStats?: ActionStatItem[];
  aiDriftStats?: AiDriftStats;
  waterfallStats?: WaterfallStats;
  liveRecovery?: {
    id: string;
    amountPaise: number;
  } | null;
}

function formatRupees(paise: number) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function RecoveryMatrixChart({
  actionStats = [],
  aiDriftStats,
  waterfallStats,
  liveRecovery,
}: RecoveryMatrixChartProps) {
  const [activeTab, setActiveTab] = useState<'RAILS' | 'DRIFT' | 'WATERFALL'>('RAILS');

  // Fallback defaults if API hasn't resolved yet
  const defaultActionStats: ActionStatItem[] = [
    {
      action: 'auto_retry',
      label: 'Auto-Retry Engine',
      channel: 'API Gateway Retry',
      recoveredCount: 25,
      totalEvents: 30,
      rate: 83.3,
      recoveredPaise: 11647500,
      tone: 'accent',
      badge: 'ZERO-TOUCH PG',
      description: 'Automated retry on transient bank timeouts & switch failures',
    },
    {
      action: 'send_nudge',
      label: 'DLT WhatsApp & SMS',
      channel: 'Meta WA / DLT SMS',
      recoveredCount: 14,
      totalEvents: 23,
      rate: 60.9,
      recoveredPaise: 4598600,
      tone: 'success',
      badge: 'DLT-VERIFIED',
      description: 'Dynamic UPI intent deep links delivered within TRAI window',
    },
    {
      action: 'request_approval',
      label: 'AFA e-Mandate Sign-off',
      channel: 'Customer AFA Link',
      recoveredCount: 3,
      totalEvents: 4,
      rate: 75.0,
      recoveredPaise: 8299900,
      tone: 'warning',
      badge: 'RBI COMPLIANT',
      description: 'Approval links for subscription renewals > ₹15,000 threshold',
    },
    {
      action: 'no_action',
      label: 'TRAI Nocturnal Shield',
      channel: 'Regulatory Gate',
      recoveredCount: 0,
      totalEvents: 45,
      rate: 100.0,
      recoveredPaise: 0,
      tone: 'shield',
      badge: '0 PENALTIES',
      description: 'Automated nocturnal communication hold (10:00–21:00 IST)',
    },
  ];

  const currentActions = actionStats.length ? actionStats : defaultActionStats;

  const drift = aiDriftStats || {
    alignmentIndex: 92.4,
    consensualCount: 44,
    interceptionCount: 70,
    escalationCount: 5,
    totalEvaluated: 65,
  };

  const waterfall = waterfallStats || {
    grossAtRiskPaise: 42443700,
    exceptionsPaise: 3990000,
    targetPoolPaise: 38453700,
    grossRecoveredPaise: 24546000,
    messagingSpendPaise: 324,
    netRecoveredPaise: 24545676,
  };

  return (
    <div className="recovery-matrix-container">
      {/* Matrix Mode Switcher Tabs */}
      <div className="matrix-nav-bar">
        <button
          type="button"
          className={`matrix-nav-btn ${activeTab === 'RAILS' ? 'active' : ''}`}
          onClick={() => setActiveTab('RAILS')}
        >
          <span>⚡ RECOVERY RAILS</span>
          <span className="matrix-nav-badge">CHANNELS</span>
        </button>

        <button
          type="button"
          className={`matrix-nav-btn ${activeTab === 'DRIFT' ? 'active' : ''}`}
          onClick={() => setActiveTab('DRIFT')}
        >
          <span>🧠 AI VS POLICY DRIFT</span>
          <span className="matrix-nav-badge">ALIGNMENT</span>
        </button>

        <button
          type="button"
          className={`matrix-nav-btn ${activeTab === 'WATERFALL' ? 'active' : ''}`}
          onClick={() => setActiveTab('WATERFALL')}
        >
          <span>💰 SALVAGE WATERFALL</span>
          <span className="matrix-nav-badge">FLOW</span>
        </button>
      </div>

      {/* Main Visualization Pane */}
      <div className="matrix-display-pane">
        <AnimatePresence mode="wait">
          {activeTab === 'RAILS' && (
            <motion.div
              key="rails"
              className="rails-view"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="rails-header-meta">
                <span>RECOVERY PERFORMANCE BY PAYMENT ENGINE</span>
                <span>CONVERSION RATE & SALVAGED VOLUME</span>
              </div>

              <div className="rails-list">
                {currentActions.map((item) => (
                  <div key={item.action} className={`rail-card rail-tone-${item.tone}`}>
                    <div className="rail-top">
                      <div className="rail-title-group">
                        <span className="rail-label">{item.label}</span>
                        <span className="rail-channel-pill">{item.channel}</span>
                        <span className="rail-badge">{item.badge}</span>
                      </div>
                      <div className="rail-metrics-group">
                        <span className="rail-rate">{item.rate}%</span>
                        {item.recoveredPaise > 0 && (
                          <span className="rail-amount">{formatRupees(item.recoveredPaise)}</span>
                        )}
                      </div>
                    </div>

                    {/* Animated Progress Track */}
                    <div className="rail-track">
                      <motion.div
                        className={`rail-fill rail-fill-${item.tone}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(100, item.rate)}%` }}
                        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
                      />
                    </div>

                    <div className="rail-footer">
                      <span className="rail-desc">{item.description}</span>
                      <span className="rail-events">
                        {item.recoveredCount > 0
                          ? `${item.recoveredCount} / ${item.totalEvents} recovered`
                          : `${item.totalEvents} events guarded`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {liveRecovery && (
                <div className="rail-live-pulse-notice">
                  <span className="live-dot" style={{ width: 6, height: 6, background: '#4ade80' }} />
                  <span>Live Webhook Settled: {formatRupees(liveRecovery.amountPaise)} seamlessly credited to Auto-Retry Engine.</span>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'DRIFT' && (
            <motion.div
              key="drift"
              className="drift-view"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="drift-score-card">
                <div className="drift-score-left">
                  <div className="drift-score-title">AI ADVISORY ALIGNMENT SCORE</div>
                  <div className="drift-score-value">{drift.alignmentIndex}%</div>
                  <div className="drift-score-desc">
                    Correlation between Google Gemini 2.5 proposed actions and RecoverAI deterministic policy rule kernel.
                  </div>
                </div>
                <div className="drift-score-right">
                  <div className="drift-badge-row">
                    <span className="drift-badge-pill green">✔ ZERO TRAI BREACHES</span>
                    <span className="drift-badge-pill blue">100% RBI COMPLIANT</span>
                  </div>
                  <div className="drift-evaluated-meta">{drift.totalEvaluated} Autonomous Decisions Evaluated</div>
                </div>
              </div>

              <div className="drift-categories-grid">
                <div className="drift-cat-box cat-consensual">
                  <div className="drift-cat-pct">67.7%</div>
                  <div className="drift-cat-label">Consensual Approvals</div>
                  <div className="drift-cat-desc">
                    Gemini advisory proposal matched deterministic policy rules and was dispatched immediately without modification.
                  </div>
                </div>

                <div className="drift-cat-box cat-interception">
                  <div className="drift-cat-pct">24.6%</div>
                  <div className="drift-cat-label">Regulatory Interceptions</div>
                  <div className="drift-cat-desc">
                    AI proposed commercial communication outside 10:00–21:00 IST; policy kernel safely suppressed action to prevent spam penalties.
                  </div>
                </div>

                <div className="drift-cat-box cat-escalation">
                  <div className="drift-cat-pct">7.7%</div>
                  <div className="drift-cat-label">VIP Priority Escalations</div>
                  <div className="drift-cat-desc">
                    Policy kernel promoted high-LTV VIP tier customers to higher retry limits (up to 3 attempts) to salvage high cart values.
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'WATERFALL' && (
            <motion.div
              key="waterfall"
              className="waterfall-view"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className="waterfall-steps">
                {/* Step 1: Gross At-Risk */}
                <div className="waterfall-step">
                  <div className="waterfall-step-top">
                    <span className="waterfall-step-title">1. Total Failed At-Risk</span>
                    <span className="waterfall-step-amount" style={{ color: '#f87171' }}>
                      {formatRupees(waterfall.grossAtRiskPaise)}
                    </span>
                  </div>
                  <div className="waterfall-track">
                    <div className="waterfall-fill" style={{ width: '100%', background: '#ef4444' }} />
                  </div>
                  <div className="waterfall-step-desc">100% of failed checkout & gateway transaction volume evaluated</div>
                </div>

                {/* Step 2: Honest Exceptions Filtered */}
                <div className="waterfall-step">
                  <div className="waterfall-step-top">
                    <span className="waterfall-step-title">2. Honest Exceptions Filtered</span>
                    <span className="waterfall-step-amount" style={{ color: '#fbbf24' }}>
                      -{formatRupees(waterfall.exceptionsPaise)}
                    </span>
                  </div>
                  <div className="waterfall-track">
                    <div className="waterfall-fill" style={{ width: '9.4%', background: '#f59e0b' }} />
                  </div>
                  <div className="waterfall-step-desc">6 unrecoverable events halted (fraud risk, expired carts &gt; 72h)</div>
                </div>

                {/* Step 3: Target Recoverable Pool */}
                <div className="waterfall-step">
                  <div className="waterfall-step-top">
                    <span className="waterfall-step-title">3. Addressable Recovery Pool</span>
                    <span className="waterfall-step-amount" style={{ color: '#93c5fd' }}>
                      {formatRupees(waterfall.targetPoolPaise)}
                    </span>
                  </div>
                  <div className="waterfall-track">
                    <div className="waterfall-fill" style={{ width: '90.6%', background: '#3b82f6' }} />
                  </div>
                  <div className="waterfall-step-desc">Active target volume subjected to multi-rail recovery logic</div>
                </div>

                {/* Step 4: Gross Salvaged Revenue */}
                <div className="waterfall-step">
                  <div className="waterfall-step-top">
                    <span className="waterfall-step-title">4. Gross Salvaged Revenue</span>
                    <span className="waterfall-step-amount" style={{ color: '#4ade80' }}>
                      {formatRupees(waterfall.grossRecoveredPaise)}
                    </span>
                  </div>
                  <div className="waterfall-track">
                    <div className="waterfall-fill" style={{ width: '57.8%', background: '#10b981' }} />
                  </div>
                  <div className="waterfall-step-desc">57.8% recovery conversion rate across all payment methods</div>
                </div>

                {/* Step 5: Net Margin Saved */}
                <div className="waterfall-step step-highlight">
                  <div className="waterfall-step-top">
                    <span className="waterfall-step-title" style={{ color: '#a7f3d0', fontWeight: 700 }}>
                      ★ Net Cashflow Margin Saved
                    </span>
                    <span className="waterfall-step-amount" style={{ color: '#4ade80', fontSize: 16 }}>
                      {formatRupees(waterfall.netRecoveredPaise)}
                    </span>
                  </div>
                  <div className="waterfall-track">
                    <div className="waterfall-fill" style={{ width: '57.79%', background: 'linear-gradient(90deg, #3b82f6, #10b981)' }} />
                  </div>
                  <div className="waterfall-step-desc" style={{ color: '#86efac' }}>
                    Net of {formatRupees(waterfall.messagingSpendPaise)} carrier dunning costs · <strong>+11.56% GMV Lift</strong>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default RecoveryMatrixChart;
