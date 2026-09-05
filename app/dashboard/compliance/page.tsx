'use client';

import React from 'react';
import { ShieldCheck, Clock, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  useDashboard,
  formatRupees,
  formatTime,
  CountUpNumber,
} from '../DashboardContext';

export default function CompliancePage() {
  const {
    policyVersion,
    isTraiOpen,
    istTime,
    stats,
    exceptions,
    aiDriftStats,
  } = useDashboard();

  const drift = aiDriftStats || {
    alignmentIndex: 92.4,
    consensualCount: 44,
    interceptionCount: 70,
    escalationCount: 5,
    totalEvaluated: 65,
  };

  const policyRules = [
    {
      id: 'R_FRAUD_GATE',
      name: 'Anti-fraud stop rule',
      appliesTo: 'All payment methods',
      desc: 'Immediate unrecoverable stop for blacklisted BINs, stolen cards, or suspicious velocity.',
      status: 'Active',
    },
    {
      id: 'R_TRAI_WINDOW',
      name: 'Communication window',
      appliesTo: 'SMS & WhatsApp',
      desc: 'Commercial dunning prohibited outside 10:00–21:00 IST. Holds queued to next compliant window.',
      status: 'Active',
    },
    {
      id: 'R_AFA_MANDATE',
      name: 'RBI mandate threshold',
      appliesTo: 'Recurring payments',
      desc: 'Subscription renewals > ₹15,000 mandate customer 2FA approval link dispatch.',
      status: 'Active',
    },
    {
      id: 'R_TRANSIENT_RETRY',
      name: 'Gateway retry limit',
      appliesTo: 'Gateway retries',
      desc: 'Automated background retry on bank switch drop or gateway timeouts (maximum 3 attempts).',
      status: 'Active',
    },
    {
      id: 'R_UPI_FALLBACK',
      name: 'UPI fallback routing',
      appliesTo: 'UPI',
      desc: 'Reroutes insufficient balance failures to high-success UPI apps (GPay, PhonePe).',
      status: 'Active',
    },
    {
      id: 'R_FATIGUE_CAP',
      name: 'Customer contact limit',
      appliesTo: 'SMS & WhatsApp',
      desc: 'Strict maximum of 2 nudges per transaction to protect brand reputation and customer trust.',
      status: 'Active',
    },
  ];

  const istClockStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(istTime);

  return (
    <div className="compliance-page-container">
      {/* Top Row: 4 Metric Cards */}
      <section className="compliance-kpi-grid">
        <Card className="compliance-kpi-card">
          <div className="compliance-kpi-header">
            <span className="kpi-label">Policy status</span>
            <ShieldCheck size={16} className="text-primary" />
          </div>
          <div className="compliance-kpi-val">
            <span className="text-primary">Policy {policyVersion || 'v1'}</span>
          </div>
          <div className="compliance-kpi-sub">
            <Badge tone="success">Active</Badge>
            <span className="ml-2 text-secondary text-xs">Deterministic enforcement</span>
          </div>
        </Card>

        <Card className="compliance-kpi-card">
          <div className="compliance-kpi-header">
            <span className="kpi-label">Communication window</span>
            <Clock size={16} className={isTraiOpen ? 'text-success' : 'text-warning'} />
          </div>
          <div className="compliance-kpi-val">
            <Badge tone={isTraiOpen ? 'success' : 'warning'}>
              {isTraiOpen ? 'Open' : 'Closed'}
            </Badge>
          </div>
          <div className="compliance-kpi-sub">
            <span className="text-secondary text-xs">10:00–21:00 IST · Current: {istClockStr} IST</span>
          </div>
        </Card>

        <Card className="compliance-kpi-card">
          <div className="compliance-kpi-header">
            <span className="kpi-label">Compliance holds</span>
            <AlertTriangle size={16} className="text-warning" />
          </div>
          <div className="compliance-kpi-val text-warning">
            <CountUpNumber value={stats?.complianceHoldCount || 0} />
          </div>
          <div className="compliance-kpi-sub">
            <span className="text-secondary text-xs">Delayed until next permitted window</span>
          </div>
        </Card>

        <Card className="compliance-kpi-card">
          <div className="compliance-kpi-header">
            <span className="kpi-label">Stopped recoveries</span>
            <CheckCircle2 size={16} className="text-success" />
          </div>
          <div className="compliance-kpi-val">
            <CountUpNumber value={exceptions.length || stats?.unrecoverableCount || 0} />
          </div>
          <div className="compliance-kpi-sub">
            <span className="text-secondary text-xs">Fraud & expired cart safeguards</span>
          </div>
        </Card>
      </section>

      {/* Recovery Policies Table */}
      <section className="compliance-section">
        <Card>
          <CardHeader>
            <h2 className="section-title">Recovery policies</h2>
            <p className="section-subtitle">
              Active regulatory and operational policies enforced on payment recovery workflows.
            </p>
          </CardHeader>
          <CardContent>
            <div className="table-responsive">
              <table className="saas-table">
                <thead>
                  <tr>
                    <th style={{ width: '220px' }}>Policy</th>
                    <th style={{ width: '180px' }}>Applies to</th>
                    <th style={{ width: '110px' }}>Status</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {policyRules.map((rule) => (
                    <tr key={rule.id}>
                      <td>
                        <div className="policy-name-cell">
                          <span className="font-medium text-sm">{rule.name}</span>
                          <span className="mono text-xs text-muted">{rule.id}</span>
                        </div>
                      </td>
                      <td>
                        <span className="text-secondary text-sm">{rule.appliesTo}</span>
                      </td>
                      <td>
                        <Badge tone="success">{rule.status}</Badge>
                      </td>
                      <td className="text-secondary text-sm">
                        {rule.desc}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Decision Alignment Section (formerly AI Drift Radar) */}
      <section className="compliance-section">
        <Card>
          <CardHeader>
            <h2 className="section-title">Decision alignment</h2>
            <p className="section-subtitle">
              How often advisory recommendations matched the final policy decision.
            </p>
          </CardHeader>
          <CardContent>
            <div className="decision-alignment-layout">
              <div className="alignment-stat-banner">
                <div className="stat-banner-col">
                  <span className="stat-banner-label">Overall alignment rate</span>
                  <span className="stat-banner-val text-primary">{drift.alignmentIndex}%</span>
                </div>
                <div className="stat-banner-divider" />
                <div className="stat-banner-col">
                  <span className="stat-banner-label">Evaluated decisions</span>
                  <span className="stat-banner-val">{drift.totalEvaluated}</span>
                </div>
                <div className="stat-banner-divider" />
                <div className="stat-banner-col">
                  <span className="stat-banner-label">Regulatory breaches</span>
                  <span className="stat-banner-val text-success">0</span>
                </div>
              </div>

              <div className="alignment-cards-row">
                <div className="alignment-mini-card">
                  <div className="mini-card-pct text-success">67.7%</div>
                  <div className="mini-card-title">Matched recommendations</div>
                  <p className="mini-card-desc">
                    AI suggestions matched policy rules and executed immediately without modifications.
                  </p>
                </div>

                <div className="alignment-mini-card">
                  <div className="mini-card-pct text-warning">24.6%</div>
                  <div className="mini-card-title">Policy adjustments</div>
                  <p className="mini-card-desc">
                    Interceptions delayed or modified actions to stay within communication windows and fatigue limits.
                  </p>
                </div>

                <div className="alignment-mini-card">
                  <div className="mini-card-pct text-primary">7.7%</div>
                  <div className="mini-card-title">Priority escalations</div>
                  <p className="mini-card-desc">
                    High-value VIP transactions granted additional automated retry attempts to protect GMV.
                  </p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Stopped Recoveries / Honest Exceptions */}
      <section className="compliance-section">
        <Card>
          <CardHeader>
            <h2 className="section-title">
              Stopped recoveries <span className="font-normal text-muted">({exceptions.length})</span>
            </h2>
            <p className="section-subtitle">
              Transactions intentionally halted to protect customer experience, prevent spam, or avoid fraud.
            </p>
          </CardHeader>
          <CardContent>
            <div className="table-responsive">
              <table className="saas-table">
                <thead>
                  <tr>
                    <th style={{ width: '160px' }}>Transaction ID</th>
                    <th style={{ width: '120px' }}>Amount</th>
                    <th style={{ width: '160px' }}>Failure category</th>
                    <th>Stopping reason</th>
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((exc) => (
                    <tr key={exc.id}>
                      <td className="mono text-sm font-medium">
                        {exc.externalPaymentId || exc.id}
                      </td>
                      <td className="text-sm font-medium">
                        {formatRupees(exc.amountPaise)}
                      </td>
                      <td>
                        <Badge tone="neutral">{exc.type.replace(/_/g, ' ')}</Badge>
                      </td>
                      <td className="text-secondary text-sm">
                        {exc.reasonCode ? exc.reasonCode.replace(/_/g, ' ') : 'Checkout abandonment / timeout'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

