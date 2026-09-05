'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ExternalLink, Zap, Copy, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  useDashboard,
  formatRupees,
  formatTime,
  CountUpRupees,
  CountUpNumber,
  resultLabel,
  resultTone,
  policySignal,
} from './DashboardContext';
import { RecoveryMatrixChart } from './RecoveryMatrixChart';

export default function OverviewPage() {
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
    isTraiOpen,
    setSelectedLog,
    newLogIds,
  } = useDashboard();

  const [copiedLink, setCopiedLink] = useState(false);

  // Latest 6 events for the overview stream
  const recentLogs = auditLogs.slice(0, 6);

  const handleCopyLink = (url: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  return (
    <div className="overview-container">
      {/* Primary KPI Grid: 4 Clean Cards */}
      <section className="kpi-grid">
        <Card className="kpi-card">
          <div className="kpi-label">Revenue at risk</div>
          <div className="kpi-value">
            <CountUpRupees valuePaise={stats?.totalAtRiskPaise || 0} />
          </div>
          <div className="kpi-footer">
            <span>{stats?.totalTransactions || 0} failed transactions evaluated</span>
          </div>
        </Card>

        <Card className="kpi-card">
          <div className="kpi-label">Recovered revenue</div>
          <div className="kpi-value text-success">
            <CountUpRupees valuePaise={stats?.totalRecoveredPaise || 0} />
          </div>
          <div className="kpi-footer">
            <span className="text-success font-medium">
              {stats?.recoveredCount || 0} successful recoveries
            </span>
          </div>
        </Card>

        <Card className="kpi-card">
          <div className="kpi-label">Recovery rate</div>
          <div className="kpi-value">
            <CountUpNumber value={stats?.recoveryRate || 0} suffix="%" decimals={1} />
          </div>
          <div className="kpi-footer">
            <span>Successful recoveries / eligible attempts</span>
          </div>
        </Card>

        <Card className="kpi-card">
          <div className="kpi-label">Compliance holds</div>
          <div className="kpi-value text-warning">
            <CountUpNumber value={stats?.complianceHoldCount || 0} />
          </div>
          <div className="kpi-footer">
            <span>Actions delayed by communication policy</span>
          </div>
        </Card>
      </section>

      {/* Payment Link State / Live Demo Action Card */}
      {paymentLink && (
        <section className="payment-ready-section">
          <Card className="payment-ready-card">
            <div className="payment-ready-content">
              <div className="payment-ready-info">
                <div className="payment-ready-eyebrow">
                  <Badge tone="success">Payment recovery ready</Badge>
                  <span className="payment-ready-tx">
                    Transaction ••••{paymentLink.transactionId.slice(-8)}
                  </span>
                </div>
                <div className="payment-ready-amount">
                  {formatRupees(paymentLink.amountPaise)}
                </div>
                <p className="payment-ready-desc">
                  Payment authorization link generated and ready for customer fulfillment.
                </p>
              </div>

              <div className="payment-ready-actions">
                <div className="payment-link-input-group">
                  <input
                    type="text"
                    readOnly
                    value={paymentLink.url}
                    className="saas-input payment-link-input"
                  />
                  <button
                    type="button"
                    className="btn-icon-subtle"
                    onClick={() => handleCopyLink(paymentLink.url)}
                    title="Copy payment link"
                  >
                    {copiedLink ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                  </button>
                </div>

                <div className="payment-ready-buttons">
                  <a
                    href={paymentLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ui-button ui-button-default"
                  >
                    <span>Open payment page</span>
                    <ExternalLink size={13} style={{ marginLeft: 6 }} />
                  </a>

                  <Button
                    variant="outline"
                    onClick={() => handleSimulateWebhook(paymentLink.transactionId)}
                    disabled={isSimulatingWebhook}
                  >
                    <Zap size={13} style={{ marginRight: 6 }} />
                    <span>{isSimulatingWebhook ? 'Simulating…' : 'Simulate payment'}</span>
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        </section>
      )}

      {/* Main Analytics Row: Recovery Performance & Summary */}
      <section className="analytics-summary-row">
        <Card className="analytics-main-card">
          <CardHeader>
            <div className="card-header-between">
              <div>
                <h2 className="section-title">Recovery performance</h2>
                <p className="section-subtitle">
                  Live recovery performance across payment channels, policy alignment, and cashflow waterfall.
                </p>
              </div>
            </div>
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

        <Card className="summary-side-card">
          <CardHeader>
            <h2 className="section-title">Recovery summary</h2>
            <p className="section-subtitle">Policy and execution status</p>
          </CardHeader>
          <CardContent>
            <div className="summary-metrics-list">
              <div className="summary-metric-row">
                <span className="summary-metric-label">Recovered transactions</span>
                <span className="summary-metric-val font-semibold text-success">
                  {stats?.recoveredCount || 0}
                </span>
              </div>

              <div className="summary-metric-row">
                <span className="summary-metric-label">Pending / deferred</span>
                <span className="summary-metric-val font-medium">
                  {(stats?.pendingCount || 0) + (stats?.deferredCount || 0)}
                </span>
              </div>

              <div className="summary-metric-row">
                <span className="summary-metric-label">Stopped recoveries</span>
                <span className="summary-metric-val font-medium text-muted">
                  {stats?.unrecoverableCount || 0}
                </span>
              </div>

              <div className="summary-metric-row">
                <span className="summary-metric-label">Policy version</span>
                <span className="summary-metric-val mono text-primary font-medium">
                  Policy {policyVersion || 'v1'}
                </span>
              </div>

              <div className="summary-metric-row">
                <span className="summary-metric-label">Communication window</span>
                <div className="summary-metric-val">
                  <Badge tone={isTraiOpen ? 'success' : 'warning'}>
                    {isTraiOpen ? 'Window open' : 'Window closed'}
                  </Badge>
                </div>
              </div>
            </div>

            <div className="summary-window-note">
              <span className="text-secondary">
                Commercial messaging is permitted <strong>10:00–21:00 IST</strong> under TRAI regulations.
              </span>
            </div>

            <div className="summary-quick-links">
              <Link href="/dashboard/compliance" className="summary-nav-link">
                <span>View compliance policies</span>
                <ArrowRight size={14} />
              </Link>
              <Link href="/dashboard/analytics" className="summary-nav-link">
                <span>View recovery economics</span>
                <ArrowRight size={14} />
              </Link>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Recent Activity Table */}
      <section className="recent-activity-section">
        <Card>
          <CardHeader>
            <div className="card-header-between">
              <div>
                <h2 className="section-title">Recent recovery activity</h2>
                <p className="section-subtitle">Latest payment recovery events and execution records.</p>
              </div>
              <Link href="/dashboard/ledger" className="view-all-link">
                <span>View all transactions</span>
                <ArrowRight size={14} />
              </Link>
            </div>
          </CardHeader>
          <CardContent>
            <div className="table-responsive">
              <table className="saas-table">
                <thead>
                  <tr>
                    <th style={{ width: '90px' }}>Time</th>
                    <th style={{ width: '130px' }}>Transaction</th>
                    <th style={{ width: '150px' }}>Suggested action</th>
                    <th style={{ width: '150px' }}>Final action</th>
                    <th>Reason / Details</th>
                    <th style={{ width: '160px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogs.map((log) => {
                    const signal = policySignal(log);
                    const isOverridden = log.actor === 'policy_engine_override';
                    const isNew = newLogIds.has(log.id);

                    // Clean human-readable action label
                    const formatAction = (str: string) => {
                      if (!str) return '—';
                      return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
                    };

                    return (
                      <tr
                        key={log.id}
                        className={`table-row-clickable ${isNew ? 'row-highlight-new' : ''}`}
                        onClick={() => setSelectedLog(log)}
                        title="Click to view transaction details"
                      >
                        <td className="text-secondary text-sm">{formatTime(log.timestamp)}</td>
                        <td className="mono text-sm font-medium">••••{log.transactionId.slice(-8)}</td>
                        <td>
                          <span className="text-secondary text-sm">
                            {formatAction(log.aiRecommendedAction || log.action)}
                          </span>
                        </td>
                        <td>
                          <span className="font-medium text-sm text-primary">
                            {formatAction(log.action)}
                          </span>
                        </td>
                        <td className="text-secondary text-sm cell-reason">
                          <span className="reason-text">{log.reason}</span>
                          {signal && (
                            <span className="signal-pill">Policy adjusted</span>
                          )}
                        </td>
                        <td>
                          <Badge tone={resultTone(log.result)}>
                            {resultLabel(log.result)}
                          </Badge>
                        </td>
                      </tr>
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

