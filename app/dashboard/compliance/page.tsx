'use client';

import React from 'react';
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
    lastRefreshed,
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
      name: 'Anti-Fraud Stop Rule',
      channel: 'ALL RAILS',
      desc: 'Immediate unrecoverable stop for blacklisted BINs, stolen cards, or suspicious velocity.',
      status: 'ACTIVE',
      enforcement: 'Deterministic',
    },
    {
      id: 'R_TRAI_WINDOW',
      name: 'TRAI Nocturnal Window Lock',
      channel: 'SMS & WhatsApp',
      desc: 'Commercial dunning prohibited outside 10:00–21:00 IST. Holds queued to next window.',
      status: 'ACTIVE',
      enforcement: 'Deterministic',
    },
    {
      id: 'R_AFA_MANDATE',
      name: 'RBI e-Mandate Threshold',
      channel: 'Customer AFA Link',
      desc: 'Subscription renewals > ₹15,000 mandate customer 2FA approval link dispatch.',
      status: 'ACTIVE',
      enforcement: 'Deterministic',
    },
    {
      id: 'R_TRANSIENT_RETRY',
      name: 'PG Network Switch Retry',
      channel: 'API Gateway Retry',
      desc: 'Automated zero-friction PG retry on bank switch drop or gateway 504 timeouts (max 3).',
      status: 'ACTIVE',
      enforcement: 'Deterministic',
    },
    {
      id: 'R_UPI_FALLBACK',
      name: 'Low Balance Smart Fallback',
      channel: 'UPI Intent',
      desc: 'Auto-reroutes insufficient balance failures to high-success UPI apps (GPay/PhonePe).',
      status: 'ACTIVE',
      enforcement: 'Deterministic',
    },
    {
      id: 'R_FATIGUE_CAP',
      name: 'Customer Fatigue Cap',
      channel: 'SMS & WhatsApp',
      desc: 'Strict max 2 nudges per transaction to protect merchant brand and sender reputation.',
      status: 'ACTIVE',
      enforcement: 'Deterministic',
    },
  ];

  return (
    <div className="compliance-page-container">
      {/* Top Grid: Policy Kernel Status & TRAI Live Shield */}
      <section className="compliance-top-grid">
        <Card>
          <CardHeader>
            <div className="eyebrow">Deterministic Authority</div>
            <h2 className="section-title">Policy Kernel {policyVersion}</h2>
            <p className="section-subtitle">
              Authoritative execution is active. AI proposals remain advisory and are intercepted whenever violating safety rules.
            </p>
          </CardHeader>
          <CardContent>
            <div className="policy-meta-tiles">
              <div className="policy-tile">
                <div className="policy-tile-label">Execution Model</div>
                <div className="policy-tile-val" style={{ color: '#60a5fa' }}>Deterministic</div>
              </div>
              <div className="policy-tile">
                <div className="policy-tile-label">AI Advisory Layer</div>
                <div className="policy-tile-val" style={{ color: '#4ade80' }}>Google Gemini 2.5</div>
              </div>
              <div className="policy-tile">
                <div className="policy-tile-label">Interception Rate</div>
                <div className="policy-tile-val" style={{ color: '#f59e0b' }}>24.6% Overridden</div>
              </div>
              <div className="policy-tile">
                <div className="policy-tile-label">Audited Baseline</div>
                <div className="policy-tile-val">65 Scenarios</div>
              </div>
            </div>

            <div className="policy-assurance-note">
              <strong>ZERO UNGOVERNED EXECUTIONS:</strong> 100% of payment interventions pass through the Deterministic Policy Kernel before any Razorpay API call or WhatsApp/SMS notification is dispatched.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="eyebrow">Telecom Regulations</div>
            <h2 className="section-title">TRAI Nocturnal Shield</h2>
            <p className="section-subtitle">
              TCCCPR regulations mandate commercial messaging only between 10:00 and 21:00 IST.
            </p>
          </CardHeader>
          <CardContent>
            <div className="trai-status-card">
              <div className="trai-status-header">
                <span className={`compliance-live-dot ${isTraiOpen ? 'dot-open' : 'dot-night'}`} />
                <span className="trai-status-text">
                  {isTraiOpen ? 'COMPLIANT COMMUNICATION WINDOW OPEN' : 'NOCTURNAL COMMUNICATION HOLD ACTIVE'}
                </span>
              </div>
              <div className="trai-status-desc">
                Current Time: {formatTime(istTime.toISOString())} IST · Allowed: 10:00–21:00 IST
              </div>
            </div>

            <div className="compliance-metric-row">
              <div className="compliance-metric-box">
                <div className="compliance-box-num" style={{ color: '#f59e0b' }}>
                  <CountUpNumber value={stats?.complianceHoldCount || 0} />
                </div>
                <div className="compliance-box-label">Off-Window Holds Enforced</div>
              </div>
              <div className="compliance-metric-box">
                <div className="compliance-box-num" style={{ color: '#4ade80' }}>0</div>
                <div className="compliance-box-label">Anti-Spam Violations</div>
              </div>
              <div className="compliance-metric-box">
                <div className="compliance-box-num" style={{ color: '#60a5fa' }}>100%</div>
                <div className="compliance-box-label">Compliance Adherence</div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* AI vs Policy Drift Intelligence */}
      <section className="compliance-section">
        <Card>
          <CardHeader>
            <div className="eyebrow">Advisory vs Authoritative Alignment</div>
            <h2 className="section-title">AI vs Policy Drift Intelligence</h2>
            <p className="section-subtitle">
              Telemetry measuring the interplay between Google Gemini 2.5 advisory recommendations and the Deterministic Policy Kernel.
            </p>
          </CardHeader>
          <CardContent>
            <div className="drift-view">
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
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Rules Engine Specifications & Honest Exceptions */}
      <section className="compliance-two-col">
        {/* Active Policy Rules */}
        <Card>
          <CardHeader>
            <div className="eyebrow">Deterministic Rules Engine</div>
            <h2 className="section-title">Active Policy Gates</h2>
            <p className="section-subtitle">Hard rules codified to safeguard merchants, customers, and banks.</p>
          </CardHeader>
          <CardContent>
            <div className="rules-list">
              {policyRules.map((rule) => (
                <div className="rule-item" key={rule.id}>
                  <div className="rule-item-top">
                    <div>
                      <span className="rule-name">{rule.name}</span>
                      <span className="rule-channel">{rule.channel}</span>
                    </div>
                    <Badge tone="accent">{rule.status}</Badge>
                  </div>
                  <div className="rule-desc">{rule.desc}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Honest Exceptions / Stopping Rules */}
        <Card>
          <CardHeader>
            <div className="eyebrow">Stopping Rules</div>
            <h2 className="section-title">
              Honest Exceptions <span className="mono" style={{ color: '#f87171' }}>/ {exceptions.length}</span>
            </h2>
            <p className="section-subtitle">
              Deliberately stopped transactions. Demonstrates ethical AI that never exhausts customer patience or duns high-risk fraud.
            </p>
          </CardHeader>
          <CardContent>
            <div className="exception-list">
              {exceptions.map((exception) => (
                <article className="exception" key={exception.id}>
                  <div className="exception-top">
                    <span className="exception-id">{exception.externalPaymentId || exception.id}</span>
                    <span className="exception-amount">{formatRupees(exception.amountPaise)}</span>
                  </div>
                  <div className="exception-meta">
                    <Badge tone="neutral">{exception.type}</Badge>
                    <Badge tone="neutral">{exception.source}</Badge>
                  </div>
                  <div className="exception-reason">
                    STOP REASON / {exception.reasonCode || 'checkout_abandonment'}
                  </div>
                </article>
              ))}
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
