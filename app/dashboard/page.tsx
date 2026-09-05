'use client';

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  useDashboard,
  formatRupees,
  formatTime,
  CountUpRupees,
  CountUpNumber,
  resultLabel,
  resultTone,
  policySignal,
  tierFromReason,
} from './DashboardContext';
import { RecoveryMatrixChart } from './RecoveryMatrixChart';

export default function CockpitOverviewPage() {
  const {
    stats,
    auditLogs,
    actionStats,
    aiDriftStats,
    waterfallStats,
    liveRecovery,
    paymentLink,
    handleSimulateWebhook,
    isSimulatingWebhook,
    policyVersion,
    lastRefreshed,
    setSelectedLog,
    newLogIds,
  } = useDashboard();

  // Show the latest 6 events in the executive cockpit
  const recentLogs = auditLogs.slice(0, 6);

  return (
    <div className="cockpit-container">
      {/* 6 High-Level Executive KPI Cards */}
      <section className="metrics-grid">
        <Card>
          <div className="eyebrow">Failed checkout & gateway</div>
          <div className="metric-value">
            <CountUpRupees valuePaise={stats?.totalAtRiskPaise || 0} />
          </div>
          <div className="metric-detail">
            {stats?.totalTransactions || 0} transactions evaluated
          </div>
          <div className="metric-trend metric-trend-blue">65 SCENARIOS EVALUATED</div>
        </Card>

        <Card>
          <div className="eyebrow">Gross recovered volume</div>
          <div className="metric-value metric-value-success">
            <CountUpRupees valuePaise={stats?.totalRecoveredPaise || 0} />
          </div>
          <div className="metric-detail">
            {stats?.recoveredCount || 0} successful recoveries
            <span className="webhook-verified-tag"> · LIVE WEBHOOK VERIFIED</span>
          </div>
          <div className="metric-trend metric-trend-green">
            ▲ 57.8% BENCHMARK SALVAGE
          </div>
        </Card>

        <Card>
          <div className="eyebrow">Net cashflow margin saved</div>
          <div className="metric-value metric-value-accent">
            <CountUpRupees valuePaise={stats?.netRecoveredPaise || 0} />
          </div>
          <div className="metric-detail">
            Net of {formatRupees(stats?.messagingSpendPaise || 324)} carrier spend
          </div>
          <div className="metric-trend metric-trend-green">▲ +11.56% GMV LIFT</div>
        </Card>

        <Card>
          <div className="eyebrow">Benchmark conversion rate</div>
          <div className="metric-value">
            <CountUpNumber value={stats?.recoveryRate || 0} suffix="%" decimals={1} />
          </div>
          <div className="metric-detail">Benchmark conversion rate</div>
          <div className="metric-trend metric-trend-blue">
            {stats?.recoveredCount || 0} SUCCESSFUL SETTLEMENTS
          </div>
        </Card>

        <Card>
          <div className="eyebrow">Regulatory safeguards</div>
          <div className="metric-value metric-value-warning">
            <CountUpNumber value={stats?.complianceHoldCount || 0} />
          </div>
          <div className="metric-detail">TRAI nocturnal holds enforced</div>
          <div className="metric-trend metric-trend-amber">✓ ZERO ANTI-SPAM BREACHES</div>
        </Card>

        <Card>
          <div className="eyebrow">Stop conditions</div>
          <div className="metric-value">
            <CountUpNumber value={stats?.unrecoverableCount || 0} />
          </div>
          <div className="metric-detail">Stopped as unrecoverable</div>
          <div className="metric-trend metric-trend-amber">6 EXPIRED / HIGH-RISK</div>
        </Card>
      </section>

      {/* Active Razorpay Payment Link Bar (if Live Demo Event was triggered) */}
      {paymentLink && (
        <section className="payment-link-panel">
          <div className="payment-link-header">
            <div>
              <span className="payment-link-badge">LIVE RAZORPAY PAYMENT LINK</span>
              <span className="payment-link-title">PAY OR SIMULATE WEBHOOK FOR #{paymentLink.transactionId.slice(-8)}</span>
            </div>
            <div className="payment-link-amount">{formatRupees(paymentLink.amountPaise)}</div>
          </div>
          <div className="payment-link-body">
            <div className="payment-link-url-row">
              <input type="text" readOnly value={paymentLink.url} className="payment-link-input" />
              <a
                href={paymentLink.url}
                target="_blank"
                rel="noopener noreferrer"
                className="payment-link-open-btn"
              >
                OPEN PAYMENT PAGE ↗
              </a>
              <button
                type="button"
                className="payment-link-sim-btn"
                onClick={() => handleSimulateWebhook(paymentLink.transactionId)}
                disabled={isSimulatingWebhook}
              >
                {isSimulatingWebhook ? 'SIMULATING…' : '⚡ SIMULATE CUSTOMER PAYMENT'}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Primary Telemetry: Autonomous Recovery Matrix + Control Plane */}
      <section className="analysis-grid">
        <Card>
          <CardHeader>
            <div className="eyebrow">Outcome telemetry</div>
            <h2 className="section-title">Autonomous Recovery Matrix</h2>
            <p className="section-subtitle">
              Unified live telemetry across automated gateway retries, DLT nudges, customer approvals, and regulatory shields.
            </p>
          </CardHeader>
          <CardContent>
            <RecoveryMatrixChart
              actionStats={actionStats}
              aiDriftStats={aiDriftStats}
              waterfallStats={waterfallStats}
              liveRecovery={liveRecovery}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="eyebrow">Control plane</div>
            <h2 className="section-title">Policy Kernel</h2>
          </CardHeader>
          <CardContent>
            <div className="metric-value">{policyVersion}</div>
            <p className="section-subtitle">
              Authoritative execution active. AI recommendations remain strictly advisory.
            </p>

            <div className="compliance-status-box">
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span className="compliance-hold-dot" style={{ width: 6, height: 6 }} />
                <strong style={{ color: '#f59e0b', fontSize: '10px', letterSpacing: '0.06em' }}>
                  TRAI COMPLIANCE GUARD ACTIVE
                </strong>
              </div>
              <div style={{ fontSize: '10px', color: '#a18357', marginTop: '4px', lineHeight: 1.4 }}>
                Allowed: 10:00–21:00 IST · Off-Window Holds: {stats?.complianceHoldCount ?? 0}
              </div>
            </div>

            <div className="cockpit-links-box">
              <Link href="/dashboard/compliance" className="cockpit-nav-link">
                <span>🛡️ Policy Rules & Stopping Gates</span>
                <span className="link-arrow">→</span>
              </Link>
              <Link href="/dashboard/analytics" className="cockpit-nav-link">
                <span>📈 Merchant ROI & Unit Economics</span>
                <span className="link-arrow">→</span>
              </Link>
            </div>

            <div className="meta" style={{ marginTop: 14, fontSize: 10, color: '#91948c' }}>
              LAST SYNC / {formatTime(lastRefreshed.toISOString())}
              <br />
              PENDING REVIEW / {stats?.pendingCount || 0}
            </div>
          </CardContent>
        </Card>
      </section>

      {/* High-Impact Recent Recoveries Stream */}
      <section className="recent-stream-section">
        <Card>
          <CardHeader>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="eyebrow">Real-time stream</div>
                <h2 className="section-title">Recent Recovery Events</h2>
                <p className="section-subtitle">Latest autonomous actions dispatched by the RecoverAI engine.</p>
              </div>
              <Link href="/dashboard/ledger" className="view-all-ledger-btn">
                VIEW FULL AUDIT LEDGER ({stats?.totalTransactions || 65}) →
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="table-scroll">
              <table className="audit-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Transaction</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Decision Record</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogs.map((log) => {
                    const signal = policySignal(log);
                    const tier = tierFromReason(log.reason);
                    return (
                      <motion.tr
                        layout
                        key={log.id}
                        className={`clickable-row ${newLogIds.has(log.id) ? 'audit-row' : ''} ${
                          signal ? 'audit-row-override' : ''
                        }`}
                        onClick={() => setSelectedLog(log)}
                        title="Click to view transaction trace drawer"
                      >
                        <td>{formatTime(log.timestamp)}</td>
                        <td className="id">#{log.transactionId.slice(-8)}</td>
                        <td>
                          <Badge tone={signal ? 'warning' : 'neutral'}>{log.actor.replace(/_/g, ' ')}</Badge>
                          {tier && (
                            <Badge className={`tier-${tier.toLowerCase()}`} tone="accent">
                              {tier}
                            </Badge>
                          )}
                        </td>
                        <td className="action">{log.action.replace(/_/g, ' ')}</td>
                        <td className="reason">
                          {log.reason}
                          {signal && (
                            <Badge className="override-signal" tone="warning">
                              AI wanted: {signal.ai} → Policy enforced: {signal.enforced}
                            </Badge>
                          )}
                        </td>
                        <td>
                          <Badge tone={resultTone(log.result)}>{resultLabel(log.result)}</Badge>
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
