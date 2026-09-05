'use client';

import React from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  useDashboard,
  formatRupees,
  formatLakhsOrCrores,
} from '../DashboardContext';

export default function AnalyticsPage() {
  const {
    roiGmv,
    setRoiGmv,
    roiFailureRate,
    setRoiFailureRate,
    roiAov,
    setRoiAov,
    roiWaShare,
    setRoiWaShare,
    roiProjection,
    waterfallStats,
  } = useDashboard();

  const waterfall = waterfallStats || {
    grossAtRiskPaise: 42443700,
    exceptionsPaise: 3990000,
    targetPoolPaise: 38453700,
    grossRecoveredPaise: 24546000,
    messagingSpendPaise: 324,
    netRecoveredPaise: 24545676,
  };

  return (
    <div className="analytics-page-container">
      {/* Top Section: Interactive Merchant ROI Modeler */}
      <section className="analytics-section">
        <Card>
          <CardHeader>
            <div className="eyebrow">Financial Impact Modeler</div>
            <h2 className="section-title">Merchant ROI & Revenue Salvage Simulation</h2>
            <p className="section-subtitle">
              Dynamic financial projection calibrated to Indian eCommerce/SaaS payment failure profiles and TRAI/DLT carrier rate cards.
            </p>
          </CardHeader>
          <CardContent>
            <div className="roi-calculator-layout">
              {/* Sliders Form Column */}
              <div className="roi-controls-col">
                <div className="roi-slider-row">
                  <div className="roi-slider-label">
                    <span>Monthly Gross Merchandise Value (GMV)</span>
                    <strong style={{ color: '#60a5fa' }}>{formatLakhsOrCrores(roiGmv)}</strong>
                  </div>
                  <input
                    type="range"
                    className="roi-range-input"
                    min={500000}
                    max={50000000}
                    step={500000}
                    value={roiGmv}
                    onChange={(e) => setRoiGmv(Number(e.target.value))}
                  />
                  <div className="slider-limits">
                    <span>₹5 Lakh</span>
                    <span>₹5 Crore</span>
                  </div>
                </div>

                <div className="roi-slider-row">
                  <div className="roi-slider-label">
                    <span>Payment Failure Rate</span>
                    <strong style={{ color: '#f87171' }}>{roiFailureRate}%</strong>
                  </div>
                  <input
                    type="range"
                    className="roi-range-input"
                    min={5}
                    max={40}
                    step={1}
                    value={roiFailureRate}
                    onChange={(e) => setRoiFailureRate(Number(e.target.value))}
                  />
                  <div className="slider-limits">
                    <span>5% (Optimized)</span>
                    <span>40% (High Friction)</span>
                  </div>
                </div>

                <div className="roi-slider-row">
                  <div className="roi-slider-label">
                    <span>Average Order Value (AOV)</span>
                    <strong style={{ color: '#4ade80' }}>₹{roiAov.toLocaleString('en-IN')}</strong>
                  </div>
                  <input
                    type="range"
                    className="roi-range-input"
                    min={200}
                    max={10000}
                    step={100}
                    value={roiAov}
                    onChange={(e) => setRoiAov(Number(e.target.value))}
                  />
                  <div className="slider-limits">
                    <span>₹200</span>
                    <span>₹10,000</span>
                  </div>
                </div>

                <div className="roi-slider-row">
                  <div className="roi-slider-label">
                    <span>WhatsApp vs SMS Dunning Mix</span>
                    <strong style={{ color: '#c084fc' }}>
                      {roiWaShare}% WhatsApp / {100 - roiWaShare}% SMS
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="roi-range-input"
                    min={0}
                    max={100}
                    step={5}
                    value={roiWaShare}
                    onChange={(e) => setRoiWaShare(Number(e.target.value))}
                  />
                  <div className="slider-limits">
                    <span>100% SMS (₹0.12/msg)</span>
                    <span>100% WhatsApp (₹0.48/msg)</span>
                  </div>
                </div>
              </div>

              {/* Real-time Outputs KPI Column */}
              <div className="roi-results-col">
                <div className="roi-results-grid">
                  <div className="roi-stat-box">
                    <div className="roi-stat-label">Monthly At-Risk Volume</div>
                    <div className="roi-stat-val" style={{ color: '#f87171' }}>
                      {formatLakhsOrCrores(roiProjection.monthlyAtRiskRupees)}
                    </div>
                    <div className="roi-stat-sub">Failed checkouts / dropoffs</div>
                  </div>

                  <div className="roi-stat-box">
                    <div className="roi-stat-label">Monthly Net Salvaged</div>
                    <div className="roi-stat-val roi-stat-highlight">
                      {formatLakhsOrCrores(roiProjection.netRecoveredRupees)}
                    </div>
                    <div className="roi-stat-sub">Direct cashflow retained</div>
                  </div>

                  <div className="roi-stat-box">
                    <div className="roi-stat-label">Net Margin Lift</div>
                    <div className="roi-stat-val" style={{ color: '#60a5fa' }}>
                      +{roiProjection.netMarginUpliftPercent}%
                    </div>
                    <div className="roi-stat-sub">Incremental top-line growth</div>
                  </div>

                  <div className="roi-stat-box">
                    <div className="roi-stat-label">Transactions Salvaged</div>
                    <div className="roi-stat-val" style={{ color: '#e2e8f0' }}>
                      {roiProjection.recoveredTransactionsCount.toLocaleString('en-IN')}
                    </div>
                    <div className="roi-stat-sub">Orders restored / month</div>
                  </div>

                  <div className="roi-stat-box">
                    <div className="roi-stat-label">Carrier Dunning Spend</div>
                    <div className="roi-stat-val" style={{ color: '#94a3b8' }}>
                      ₹{roiProjection.totalMessagingCostRupees.toLocaleString('en-IN')}
                    </div>
                    <div className="roi-stat-sub">DLT SMS & Meta WhatsApp</div>
                  </div>

                  <div className="roi-stat-box">
                    <div className="roi-stat-label">Net ROI Multiplier</div>
                    <div className="roi-stat-val" style={{ color: '#fde047' }}>
                      {roiProjection.roiMultiple}x
                    </div>
                    <div className="roi-stat-sub">Return on dunning spend</div>
                  </div>
                </div>

                <div className="roi-banner-annual">
                  <div>
                    <span className="annual-label">PROJECTED ANNUAL REVENUE RECOVERY:</span>
                    <strong className="annual-amount">
                      {formatLakhsOrCrores(roiProjection.annualizedNetRecoveredRupees)} / year
                    </strong>
                  </div>
                  <span className="annual-pill">+11.5% TOP-LINE EXPANSION</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Financial Salvage Waterfall & Dunning Unit Economics */}
      <section className="analytics-two-col">
        {/* Waterfall Flow */}
        <Card>
          <CardHeader>
            <div className="eyebrow">Cashflow Retention</div>
            <h2 className="section-title">Benchmark Salvage Waterfall</h2>
            <p className="section-subtitle">
              Measured progression from gross at-risk volume to net retained profit margin across the 65-scenario benchmark.
            </p>
          </CardHeader>
          <CardContent>
            <div className="waterfall-view">
              {/* Step 1: Gross at-risk */}
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
                <div className="waterfall-step-desc">100% of failed checkout & gateway volume evaluated</div>
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

              {/* Step 4: Gross Salvaged */}
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

              {/* Step 5: Net Cashflow Margin */}
              <div className="waterfall-step waterfall-highlight">
                <div className="waterfall-step-top">
                  <span className="waterfall-step-title">★ Net Cashflow Margin Saved</span>
                  <span className="waterfall-step-amount" style={{ color: '#86efac', fontWeight: 800 }}>
                    {formatRupees(waterfall.netRecoveredPaise)}
                  </span>
                </div>
                <div className="waterfall-track">
                  <div className="waterfall-fill" style={{ width: '57.8%', background: '#22c55e' }} />
                </div>
                <div className="waterfall-step-desc">
                  Net of {formatRupees(waterfall.messagingSpendPaise)} carrier dunning costs · +11.56% GMV Lift
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Dunning Channel Unit Economics Card */}
        <Card>
          <CardHeader>
            <div className="eyebrow">Cost-Per-Recovery Attribution</div>
            <h2 className="section-title">Channel Unit Economics</h2>
            <p className="section-subtitle">
              Carrier spend breakdown and conversion efficiency for each autonomous recovery rail.
            </p>
          </CardHeader>
          <CardContent>
            <div className="channel-economics-list">
              <div className="channel-econ-item">
                <div className="channel-econ-header">
                  <div>
                    <span className="channel-econ-name">Zero-Touch PG Retry</span>
                    <span className="channel-econ-badge free">₹0.00 SPEND</span>
                  </div>
                  <span className="channel-econ-rate">83.9% RATE</span>
                </div>
                <div className="channel-econ-details">
                  <span>API Switch Retry · Zero customer friction · 26 of 31 recovered</span>
                  <strong style={{ color: '#60a5fa' }}>₹1,16,974 Retained</strong>
                </div>
              </div>

              <div className="channel-econ-item">
                <div className="channel-econ-header">
                  <div>
                    <span className="channel-econ-name">Meta WhatsApp Deep Link</span>
                    <span className="channel-econ-badge wa">₹0.48 / MSG</span>
                  </div>
                  <span className="channel-econ-rate">60.9% RATE</span>
                </div>
                <div className="channel-econ-details">
                  <span>Dynamic UPI Intent · Interactive payment card · 14 of 23 recovered</span>
                  <strong style={{ color: '#4ade80' }}>₹45,986 Retained</strong>
                </div>
              </div>

              <div className="channel-econ-item">
                <div className="channel-econ-header">
                  <div>
                    <span className="channel-econ-name">DLT-Registered SMS</span>
                    <span className="channel-econ-badge sms">₹0.12 / MSG</span>
                  </div>
                  <span className="channel-econ-rate">54.2% RATE</span>
                </div>
                <div className="channel-econ-details">
                  <span>Single GSM-7 segment · Header RAZORP-REC · High deliverability</span>
                  <strong style={{ color: '#fbbf24' }}>₹32,150 Retained</strong>
                </div>
              </div>

              <div className="channel-econ-item">
                <div className="channel-econ-header">
                  <div>
                    <span className="channel-econ-name">Customer AFA Mandate</span>
                    <span className="channel-econ-badge free">₹0.00 SPEND</span>
                  </div>
                  <span className="channel-econ-rate">75.0% RATE</span>
                </div>
                <div className="channel-econ-details">
                  <span>RBI Compliant &gt; ₹15,000 threshold approval links · 3 of 4 recovered</span>
                  <strong style={{ color: '#c084fc' }}>₹82,999 Retained</strong>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
