'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ReceiptText,
  ShieldCheck,
  ChartNoAxesCombined,
  Play,
  Zap,
  Clock,
  HelpCircle,
  Terminal,
} from 'lucide-react';
import { useDashboard } from './DashboardContext';

export function DashboardSidebar() {
  const pathname = usePathname();
  const {
    stats,
    policyVersion,
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
      label: 'Overview',
      icon: LayoutDashboard,
      badge: null,
    },
    {
      href: '/dashboard/ledger',
      label: 'Transactions',
      icon: ReceiptText,
      badge: stats ? `${stats.totalTransactions}` : '65',
    },
    {
      href: '/dashboard/compliance',
      label: 'Compliance',
      icon: ShieldCheck,
      badge: null,
    },
    {
      href: '/dashboard/analytics',
      label: 'Analytics',
      icon: ChartNoAxesCombined,
      badge: null,
    },
  ];

  return (
    <aside className="app-sidebar">
      {/* Brand & Wordmark */}
      <div className="sidebar-brand">
        <div className="brand-logo-row">
          <div className="brand-logo-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
              <path d="M3 21v-5h5" />
            </svg>
          </div>
          <div className="brand-text-col">
            <span className="brand-name">RecoverAI</span>
            <span className="brand-tagline">Revenue recovery</span>
          </div>
        </div>
      </div>

      {/* Main Navigation */}
      <nav className="sidebar-nav">
        <div className="sidebar-section-title">Navigation</div>
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon className="nav-item-icon" size={17} />
              <span className="nav-item-label">{item.label}</span>
              {item.badge && <span className="nav-item-badge">{item.badge}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Lower Area: Demo Tools & Environment */}
      <div className="sidebar-bottom-area">
        {/* Discreet Demo Tools Container */}
        <div className="demo-tools-box">
          <div className="demo-tools-header">
            <span className="demo-tools-title">Demo tools</span>
          </div>

          <div className="demo-tools-actions">
            <button
              type="button"
              className="demo-btn-primary"
              onClick={() => handleTrigger('live')}
              disabled={triggering !== null}
              title="Trigger live payment recovery workflow (Hotkey: L)"
            >
              <Play size={13} fill="currentColor" />
              <span>{triggering === 'live' ? 'Running…' : 'Run demo'}</span>
            </button>

            <button
              type="button"
              className="demo-btn-secondary"
              onClick={() => handleSimulateWebhook()}
              disabled={isSimulatingWebhook}
              title="Simulate Razorpay payment webhook (Hotkey: W)"
            >
              <Zap size={13} />
              <span>{isSimulatingWebhook ? 'Simulating…' : 'Simulate webhook'}</span>
            </button>

            <button
              type="button"
              className="demo-btn-secondary"
              onClick={() => handleTrigger('compliance')}
              disabled={triggering !== null}
              title="Test nocturnal TRAI compliance window interception (Hotkey: O)"
            >
              <Clock size={13} />
              <span>{triggering === 'compliance' ? 'Testing…' : 'Test compliance hold'}</span>
            </button>
          </div>

          {/* Minimal secondary links for shortcuts & terminal */}
          <div className="demo-tools-footer-links">
            <button
              type="button"
              className="demo-link-btn"
              onClick={() => setShowShortcuts(true)}
              title="Keyboard shortcuts (?)"
            >
              <HelpCircle size={12} />
              <span>Shortcuts</span>
            </button>
            <button
              type="button"
              className="demo-link-btn"
              onClick={() => setShowTerminal(true)}
              title="Diagnostic console (`)"
            >
              <Terminal size={12} />
              <span>Diagnostics</span>
            </button>
          </div>
        </div>

        {/* Professional Environment Status */}
        <div className="sidebar-footer">
          <div className="system-health">
            <span className="health-dot" />
            <span>Test environment</span>
          </div>
          <span className="footer-meta-pill">Policy {policyVersion || 'v1'}</span>
        </div>
      </div>
    </aside>
  );
}
