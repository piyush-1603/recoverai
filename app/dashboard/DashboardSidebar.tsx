'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useDashboard } from './DashboardContext';

export function DashboardSidebar() {
  const pathname = usePathname();
  const {
    isTraiOpen,
    istTime,
    istHour,
    stats,
    handleTrigger,
    triggering,
    handleSimulateWebhook,
    isSimulatingWebhook,
    setShowTerminal,
    setShowShortcuts,
  } = useDashboard();

  const navItems = [
    {
      href: '/dashboard',
      label: 'Cockpit Overview',
      shortLabel: 'Overview',
      icon: '⚡',
      badge: 'LIVE',
      description: 'KPI telemetry & recovery rails',
    },
    {
      href: '/dashboard/ledger',
      label: 'Audit Ledger',
      shortLabel: 'Ledger',
      icon: '📋',
      badge: stats ? `${stats.totalTransactions}` : '65',
      description: 'Immutable append-only trail',
    },
    {
      href: '/dashboard/compliance',
      label: 'Policy & Guard',
      shortLabel: 'Compliance',
      icon: '🛡️',
      badge: `${stats?.complianceHoldCount ?? 0} HOLDS`,
      description: 'TRAI window & stopping rules',
    },
    {
      href: '/dashboard/analytics',
      label: 'ROI & Economics',
      shortLabel: 'Analytics',
      icon: '📈',
      badge: '+11.5% LIFT',
      description: 'Merchant ROI & unit economics',
    },
  ];

  return (
    <aside className="app-sidebar">
      {/* Brand & System Status */}
      <div className="sidebar-brand">
        <div className="brand-logo-row">
          <span className="brand-slash">/</span>
          <span className="brand-name">RecoverAI</span>
          <span className="brand-pill">RAZORPAY</span>
        </div>
        <div className="brand-tagline">Autonomous Revenue Recovery Engine</div>
      </div>

      {/* Navigation Sections */}
      <nav className="sidebar-nav">
        <div className="sidebar-section-title">CONTROL CENTER</div>
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
            >
              <div className="nav-item-icon">{item.icon}</div>
              <div className="nav-item-content">
                <div className="nav-item-title-row">
                  <span className="nav-item-title">{item.label}</span>
                  {item.badge && <span className="nav-item-badge">{item.badge}</span>}
                </div>
                <div className="nav-item-desc">{item.description}</div>
              </div>
            </Link>
          );
        })}
      </nav>

      {/* TRAI Compliance Status Box */}
      <div className="sidebar-compliance-widget">
        <div className="compliance-widget-header">
          <span className={`compliance-live-dot ${isTraiOpen ? 'dot-open' : 'dot-night'}`} />
          <span className="compliance-widget-title">
            {isTraiOpen ? 'TRAI WINDOW OPEN' : 'NOCTURNAL SHIELD'}
          </span>
        </div>
        <div className="compliance-widget-details">
          <span>{isTraiOpen ? 'Commercial nudges permitted' : 'Nudges suppressed until 10:00 IST'}</span>
          <div className="compliance-hours-meta">
            10:00–21:00 IST · Active Holds: {stats?.complianceHoldCount ?? 0}
          </div>
        </div>
      </div>

      {/* Quick Action Triggers */}
      <div className="sidebar-actions-section">
        <div className="sidebar-section-title">OPERATIONAL CONTROLS</div>

        <button
          type="button"
          className="sidebar-action-btn sim-webhook"
          onClick={() => handleSimulateWebhook()}
          disabled={isSimulatingWebhook}
          title="Simulate authentic HMAC-SHA256 Razorpay payment webhook [W]"
        >
          <span>⚡ {isSimulatingWebhook ? 'SIMULATING…' : 'SIMULATE WEBHOOK'}</span>
          <span className="key-hint">W</span>
        </button>

        <button
          type="button"
          className="sidebar-action-btn live-trigger"
          onClick={() => handleTrigger('live')}
          disabled={triggering !== null}
          title="Trigger authentic live payment recovery workflow [L]"
        >
          <span>{triggering === 'live' ? 'RECORDING…' : '🎬 LIVE DEMO EVENT'}</span>
          <span className="key-hint">L</span>
        </button>

        <button
          type="button"
          className="sidebar-action-btn compliance-trigger"
          onClick={() => handleTrigger('compliance')}
          disabled={triggering !== null}
          title="Test nocturnal TRAI compliance window interception [O]"
        >
          <span>{triggering === 'compliance' ? 'EVALUATING…' : '🧪 OFF-WINDOW TEST'}</span>
          <span className="key-hint">O</span>
        </button>

        <div className="sidebar-util-btns">
          <button
            type="button"
            className="sidebar-util-btn"
            onClick={() => setShowTerminal(true)}
            title="Launch Terminal Diagnostics [`]"
          >
            <span>💻 TERMINAL</span>
            <span className="key-hint">`</span>
          </button>
          <button
            type="button"
            className="sidebar-util-btn"
            onClick={() => setShowShortcuts(true)}
            title="Keyboard Shortcuts [?]"
          >
            <span>⌨️ SHORTCUTS</span>
            <span className="key-hint">?</span>
          </button>
        </div>
      </div>

      {/* Footer Meta */}
      <div className="sidebar-footer">
        <div className="system-health">
          <span className="health-dot" />
          <span>POLICY KERNEL v1 · DETERMINISTIC</span>
        </div>
        <div className="sidebar-version">GEMINI 2.5 ADVISORY + RAZORPAY PG</div>
      </div>
    </aside>
  );
}
