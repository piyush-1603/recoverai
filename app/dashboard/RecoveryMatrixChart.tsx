'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Badge } from '@/components/ui/badge';

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
  const [activeTab, setActiveTab] = useState<'CHANNELS' | 'ALIGNMENT' | 'WATERFALL'>('CHANNELS');

  const defaultActionStats: ActionStatItem[] = [
    {
      action: 'auto_retry',
      label: 'Gateway retry',
      channel: 'API gateway switch',
      recoveredCount: 25,
      totalEvents: 30,
      rate: 83.3,
      recoveredPaise: 11647500,
      tone: 'accent',
      badge: 'Zero friction',
      description: 'Automated background retry on transient gateway and switch timeouts',
    },
    {
      action: 'send_nudge',
      label: 'WhatsApp & SMS nudge',
      channel: 'DLT-registered messaging',
      recoveredCount: 14,
      totalEvents: 23,
      rate: 60.9,
      recoveredPaise: 4598600,
      tone: 'success',
      badge: 'TRAI compliant',
      description: 'Dynamic UPI payment links delivered strictly within communication window',
    },
    {
      action: 'request_approval',
      label: 'Customer authorization',
      channel: 'AFA mandate link',
      recoveredCount: 3,
      totalEvents: 4,
      rate: 75.0,
      recoveredPaise: 8299900,
      tone: 'warning',
      badge: 'RBI mandate',
      description: 'Customer approval links for recurring renewals exceeding ₹15,000 threshold',
    },
    {
      action: 'no_action',
      label: 'Communication hold',
      channel: 'Policy safeguard',
      recoveredCount: 0,
      totalEvents: 45,
      rate: 100.0,
      recoveredPaise: 0,
      tone: 'neutral',
      badge: 'Protected',
      description: 'Automated deferral outside 10:00–21:00 IST to prevent regulatory breaches',
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
      {/* Clean Segmented Tab Control */}
      <div className="matrix-tabs-bar">
        <button
          type="button"
          className={`matrix-tab-btn ${activeTab === 'CHANNELS' ? 'active' : ''}`}
          onClick={() => setActiveTab('CHANNELS')}
        >
          Recovery channels
        </button>

        <button
          type="button"
          className={`matrix-tab-btn ${activeTab === 'ALIGNMENT' ? 'active' : ''}`}
          onClick={() => setActiveTab('ALIGNMENT')}
        >
          Decision alignment
        </button>

        <button
          type="button"
          className={`matrix-tab-btn ${activeTab === 'WATERFALL' ? 'active' : ''}`}
          onClick={() => setActiveTab('WATERFALL')}
        >
          Salvage waterfall
        </button>
      </div>

      {/* Main View Pane */}
      <div className="matrix-content-pane">
        <AnimatePresence mode="wait">
          {activeTab === 'CHANNELS' && (
            <motion.div
              key="channels"
              className="matrix-channels-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="rails-list">
                {currentActions.map((item) => (
                  <div key={item.action} className="rail-card">
                    <div className="rail-top-row">
                      <div className="rail-title-group">
                        <span className="rail-label">{item.label}</span>
                        <span className="rail-channel-pill">{item.channel}</span>
                      </div>
                      <div className="rail-metrics-group">
                        <span className="rail-rate">{item.rate}%</span>
                        {item.recoveredPaise > 0 && (
                          <span className="rail-amount">{formatRupees(item.recoveredPaise)}</span>
                        )}
                      </div>
                    </div>

                    {/* Progress bar */}
                    <div className="rail-track">
                      <div
                        className={`rail-fill rail-fill-${item.tone}`}
                        style={{ width: `${Math.min(100, item.rate)}%` }}
                      />
                    </div>

                    <div className="rail-footer-row">
                      <span className="rail-desc">{item.description}</span>
                      <span className="rail-counts">
                        {item.recoveredCount > 0
                          ? `${item.recoveredCount} of ${item.totalEvents} recovered`
                          : `${item.totalEvents} actions held`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {liveRecovery && (
                <div className="rail-live-notice">
                  <span className="status-dot green" />
                  <span>Recent recovery of {formatRupees(liveRecovery.amountPaise)} attributed to Gateway retry engine.</span>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'ALIGNMENT' && (
            <motion.div
              key="alignment"
              className="matrix-alignment-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="alignment-summary-banner">
                <div className="alignment-score-group">
                  <div className="alignment-score-label">Decision alignment score</div>
                  <div className="alignment-score-value">{drift.alignmentIndex}%</div>
                  <div className="alignment-score-desc">
                    Advisory recommendations aligned directly with deterministic safety policy.
                  </div>
                </div>
                <div className="alignment-meta-pills">
                  <span className="meta-pill green">100% compliance adherence</span>
                  <span className="meta-pill neutral">{drift.totalEvaluated} decisions evaluated</span>
                </div>
              </div>

              <div className="alignment-breakdown-grid">
                <div className="alignment-card">
                  <div className="alignment-card-pct text-success">67.7%</div>
                  <div className="alignment-card-title">Matched recommendations</div>
                  <div className="alignment-card-desc">
                    AI suggestions matched policy rules and executed immediately without modifications.
                  </div>
                </div>

                <div className="alignment-card">
                  <div className="alignment-card-pct text-warning">24.6%</div>
                  <div className="alignment-card-title">Policy adjustments</div>
                  <div className="alignment-card-desc">
                    Interceptions delayed or modified actions to stay within communication windows and fatigue limits.
                  </div>
                </div>

                <div className="alignment-card">
                  <div className="alignment-card-pct text-primary">7.7%</div>
                  <div className="alignment-card-title">Priority escalations</div>
                  <div className="alignment-card-desc">
                    High-value VIP transactions granted additional automated retry attempts to protect GMV.
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'WATERFALL' && (
            <motion.div
              key="waterfall"
              className="matrix-waterfall-view"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="waterfall-list">
                <div className="waterfall-item">
                  <div className="waterfall-item-header">
                    <span className="waterfall-item-name">1. Revenue at risk</span>
                    <span className="waterfall-item-amount text-danger">{formatRupees(waterfall.grossAtRiskPaise)}</span>
                  </div>
                  <div className="waterfall-bar-track">
                    <div className="waterfall-bar-fill bg-danger" style={{ width: '100%' }} />
                  </div>
                  <div className="waterfall-item-sub">Total failed checkouts and gateway drops evaluated</div>
                </div>

                <div className="waterfall-item">
                  <div className="waterfall-item-header">
                    <span className="waterfall-item-name">2. Excluded / stopped</span>
                    <span className="waterfall-item-amount text-warning">-{formatRupees(waterfall.exceptionsPaise)}</span>
                  </div>
                  <div className="waterfall-bar-track">
                    <div className="waterfall-bar-fill bg-warning" style={{ width: '9.4%' }} />
                  </div>
                  <div className="waterfall-item-sub">Filtered due to fraud flags or carts older than 72 hours</div>
                </div>

                <div className="waterfall-item">
                  <div className="waterfall-item-header">
                    <span className="waterfall-item-name">3. Eligible recovery pool</span>
                    <span className="waterfall-item-amount text-info">{formatRupees(waterfall.targetPoolPaise)}</span>
                  </div>
                  <div className="waterfall-bar-track">
                    <div className="waterfall-bar-fill bg-info" style={{ width: '90.6%' }} />
                  </div>
                  <div className="waterfall-item-sub">Recoverable volume routed to automated recovery rails</div>
                </div>

                <div className="waterfall-item">
                  <div className="waterfall-item-header">
                    <span className="waterfall-item-name">4. Recovered revenue</span>
                    <span className="waterfall-item-amount text-success">{formatRupees(waterfall.grossRecoveredPaise)}</span>
                  </div>
                  <div className="waterfall-bar-track">
                    <div className="waterfall-bar-fill bg-success" style={{ width: '57.8%' }} />
                  </div>
                  <div className="waterfall-item-sub">57.8% recovery conversion across all payment methods</div>
                </div>

                <div className="waterfall-item highlight-box">
                  <div className="waterfall-item-header">
                    <span className="waterfall-item-name font-semibold text-primary">5. Net recovered revenue</span>
                    <span className="waterfall-item-amount text-success font-semibold">{formatRupees(waterfall.netRecoveredPaise)}</span>
                  </div>
                  <div className="waterfall-bar-track">
                    <div className="waterfall-bar-fill bg-primary" style={{ width: '57.8%' }} />
                  </div>
                  <div className="waterfall-item-sub">Net of {formatRupees(waterfall.messagingSpendPaise)} carrier dunning cost (+11.56% GMV lift)</div>
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

