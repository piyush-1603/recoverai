'use client';

import React from 'react';
import { TrendingUp, ArrowUpRight, DollarSign } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  useDashboard,
  formatRupees,
  formatLakhsOrCrores,
  CountUpRupees,
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
      {/* Top KPI Row */}
      <section className="kpi-grid">
        <Card className="kpi-card">
          <div className="kpi-label">Revenue at risk</div>
          <div className="kpi-value text-danger">
            {formatRupees(waterfall.grossAtRiskPaise)}
          </div>
          <div className="kpi-footer">
            <span>Total failed checkout volume evaluated</span>
          </div>
        </Card>

        <Card className="kpi-card">
          <div className="kpi-label">Recovered revenue</div>
          <div className="kpi-value text-success">
            {formatRupees(waterfall.grossRecoveredPaise)}
          </div>
          <div className="kpi-footer">
            <span className="text-success font-medium">57.8% recovery conversion</span>
          </div>
        </Card>

        <Card className="kpi-card">
          <div className="kpi-label">Net recovered revenue</div>
          <div className="kpi-value text-primary">
            {formatRupees(waterfall.netRecoveredPaise)}
          </div>
          <div className="kpi-footer">
            <span>Net of {formatRupees(waterfall.messagingSpendPaise)} carrier costs</span>
          </div>
        </Card>

        <Card className="kpi-card">
          <div className="kpi-label">Estimated GMV lift</div>
          <div className="kpi-value text-success">
            +11.56%
          </div>
          <div className="kpi-footer">
            <span className="text-success font-medium">Annualized margin improvement</span>
          </div>
        </Card>
      </section>

      {/* Recovery Impact Calculator (formerly ROI Modeler) */}
      <section className="analytics-section">
        <Card>
          <CardHeader>
            <h2 className="section-title">Recovery impact calculator</h2>
            <p className="section-subtitle">
              Estimate how RecoverAI could affect failed-payment recovery and retained revenue for a merchant.
            </p>
          </CardHeader>
          <CardContent>
            <div className="roi-calculator-layout">
              {/* Sliders Form Column */}
              <div className="roi-controls-col">
                <div className="roi-slider-row">
                  <div className="roi-slider-label">
                    <span>Monthly GMV</span>
                    <strong className="text-primary font-semibold">
                      {formatLakhsOrCrores(roiGmv)}
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="saas-range-slider"
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
                    <span>Payment failure rate</span>
                    <strong className="text-danger font-semibold">
                      {roiFailureRate}%
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="saas-range-slider"
                    min={5}
                    max={40}
                    step={1}
                    value={roiFailureRate}
                    onChange={(e) => setRoiFailureRate(Number(e.target.value))}
                  />
                  <div className="slider-limits">
                    <span>5% (Low friction)</span>
                    <span>40% (High friction)</span>
                  </div>
                </div>

                <div className="roi-slider-row">
                  <div className="roi-slider-label">
                    <span>Average order value (AOV)</span>
                    <strong className="text-success font-semibold">
                      ₹{roiAov.toLocaleString('en-IN')}
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="saas-range-slider"
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
                    <span>Communication channel mix</span>
                    <strong className="text-secondary font-medium">
                      {roiWaShare}% WhatsApp / {100 - roiWaShare}% SMS
                    </strong>
                  </div>
                  <input
                    type="range"
                    className="saas-range-slider"
                    min={0}
                    max={100}
                    step={5}
                    value={roiWaShare}
                    onChange={(e) => setRoiWaShare(Number(e.target.value))}
                  />
                  <div className="slider-limits">
                    <span>100% SMS (₹0.12)</span>
                    <span>100% WhatsApp (₹0.48)</span>
                  </div>
                </div>
              </div>

              {/* Real-time Outputs KPI Column */}
              <div className="roi-results-col">
                <div className="roi-results-grid">
                  <div className="roi-result-card">
                    <span className="result-label">Monthly at-risk</span>
                    <span className="result-value text-danger font-semibold">
                      {formatLakhsOrCrores(roiProjection.monthlyAtRiskRupees)}
                    </span>
                    <span className="result-sub">Failed dropoffs</span>
                  </div>

                  <div className="roi-result-card highlight">
                    <span className="result-label text-primary font-medium">Monthly net recovered</span>
                    <span className="result-value text-success font-bold">
                      {formatLakhsOrCrores(roiProjection.netRecoveredRupees)}
                    </span>
                    <span className="result-sub">Direct cashflow retained</span>
                  </div>

                  <div className="roi-result-card">
                    <span className="result-label">Net margin lift</span>
                    <span className="result-value text-primary font-semibold">
                      +{roiProjection.netMarginUpliftPercent}%
                    </span>
                    <span className="result-sub">Incremental revenue</span>
                  </div>

                  <div className="roi-result-card">
                    <span className="result-label">Orders recovered</span>
                    <span className="result-value font-semibold">
                      {roiProjection.recoveredTransactionsCount.toLocaleString('en-IN')}
                    </span>
                    <span className="result-sub">Orders restored / month</span>
                  </div>

                  <div className="roi-result-card">
                    <span className="result-label">Carrier messaging cost</span>
                    <span className="result-value text-muted font-medium">
                      ₹{roiProjection.totalMessagingCostRupees.toLocaleString('en-IN')}
                    </span>
                    <span className="result-sub">SMS & WhatsApp spend</span>
                  </div>

                  <div className="roi-result-card">
                    <span className="result-label">Net ROI multiplier</span>
                    <span className="result-value text-warning font-bold">
                      {roiProjection.roiMultiple}x
                    </span>
                    <span className="result-sub">Return on dunning spend</span>
                  </div>
                </div>

                <div className="roi-annual-banner">
                  <div className="annual-banner-text">
                    <span className="annual-label">Projected annual net recovery</span>
                    <span className="annual-amount text-success">
                      {formatLakhsOrCrores(roiProjection.annualizedNetRecoveredRupees)} / year
                    </span>
                  </div>
                  <div className="annual-badge">
                    <TrendingUp size={14} className="text-primary" />
                    <span className="font-semibold text-primary">+11.5% GMV expansion</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Recovery Economics Waterfall & Channel Breakdown */}
      <section className="analytics-two-col">
        {/* Waterfall Flow */}
        <Card>
          <CardHeader>
            <h2 className="section-title">Recovery economics</h2>
            <p className="section-subtitle">
              Progression from gross at-risk volume to net retained cashflow.
            </p>
          </CardHeader>
          <CardContent>
            <div className="waterfall-list">
              <div className="waterfall-item">
                <div className="waterfall-item-header">
                  <span className="waterfall-item-name">1. Revenue at risk</span>
                  <span className="waterfall-item-amount text-danger">{formatRupees(waterfall.grossAtRiskPaise)}</span>
                </div>
                <div className="waterfall-bar-track">
                  <div className="waterfall-bar-fill bg-danger" style={{ width: '100%' }} />
                </div>
                <div className="waterfall-item-sub">Total failed checkout & gateway drops evaluated</div>
              </div>

              <div className="waterfall-item">
                <div className="waterfall-item-header">
                  <span className="waterfall-item-name">2. Excluded / stopped</span>
                  <span className="waterfall-item-amount text-warning">-{formatRupees(waterfall.exceptionsPaise)}</span>
                </div>
                <div className="waterfall-bar-track">
                  <div className="waterfall-bar-fill bg-warning" style={{ width: '9.4%' }} />
                </div>
                <div className="waterfall-item-sub">Filtered due to fraud risk or carts older than 72 hours</div>
              </div>

              <div className="waterfall-item">
                <div className="waterfall-item-header">
                  <span className="waterfall-item-name">3. Eligible recovery pool</span>
                  <span className="waterfall-item-amount text-info">{formatRupees(waterfall.targetPoolPaise)}</span>
                </div>
                <div className="waterfall-bar-track">
                  <div className="waterfall-bar-fill bg-info" style={{ width: '90.6%' }} />
                </div>
                <div className="waterfall-item-sub">Addressable volume routed to automated recovery rails</div>
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
          </CardContent>
        </Card>

        {/* Channel Economics */}
        <Card>
          <CardHeader>
            <h2 className="section-title">Channel unit economics</h2>
            <p className="section-subtitle">
              Cost-efficiency and conversion performance across each recovery rail.
            </p>
          </CardHeader>
          <CardContent>
            <div className="channel-list">
              <div className="channel-card">
                <div className="channel-card-top">
                  <div>
                    <span className="channel-title">Gateway retry</span>
                    <span className="channel-cost-tag free">₹0.00 spend</span>
                  </div>
                  <span className="channel-rate text-success font-semibold">83.9%</span>
                </div>
                <div className="channel-card-bottom">
                  <span>API switch retry • Zero friction • 26 of 31 recovered</span>
                  <strong className="text-primary font-medium">₹1,16,974 recovered</strong>
                </div>
              </div>

              <div className="channel-card">
                <div className="channel-card-top">
                  <div>
                    <span className="channel-title">WhatsApp payment link</span>
                    <span className="channel-cost-tag wa">₹0.48 / msg</span>
                  </div>
                  <span className="channel-rate text-success font-semibold">60.9%</span>
                </div>
                <div className="channel-card-bottom">
                  <span>Dynamic UPI intent • Interactive checkout • 14 of 23 recovered</span>
                  <strong className="text-primary font-medium">₹45,986 recovered</strong>
                </div>
              </div>

              <div className="channel-card">
                <div className="channel-card-top">
                  <div>
                    <span className="channel-title">DLT SMS</span>
                    <span className="channel-cost-tag sms">₹0.12 / msg</span>
                  </div>
                  <span className="channel-rate text-warning font-semibold">54.2%</span>
                </div>
                <div className="channel-card-bottom">
                  <span>Standard single GSM-7 segment • 11 of 20 recovered</span>
                  <strong className="text-primary font-medium">₹32,150 recovered</strong>
                </div>
              </div>

              <div className="channel-card">
                <div className="channel-card-top">
                  <div>
                    <span className="channel-title">Customer mandate authorization</span>
                    <span className="channel-cost-tag free">₹0.00 spend</span>
                  </div>
                  <span className="channel-rate text-success font-semibold">75.0%</span>
                </div>
                <div className="channel-card-bottom">
                  <span>RBI compliant renewal sign-off (&gt; ₹15,000) • 3 of 4 recovered</span>
                  <strong className="text-primary font-medium">₹82,999 recovered</strong>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

