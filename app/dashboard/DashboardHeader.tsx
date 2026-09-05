'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useDashboard, formatTime } from './DashboardContext';

const HeaderNetwork3D = dynamic(() => import('./HeaderNetwork3D'), {
  ssr: false,
  loading: () => <div className="header-3d-fallback" aria-hidden="true" />,
});

export function DashboardHeader() {
  const pathname = usePathname();
  const {
    istTime,
    isTraiOpen,
    isRefreshing,
    refreshCompleted,
    handleManualRefresh,
    lastRefreshed,
    triggerNotification,
    setTriggerNotification,
    setShowShortcuts,
  } = useDashboard();

  const getBreadcrumb = () => {
    switch (pathname) {
      case '/dashboard/ledger':
        return {
          category: 'Immutable Audit Trail',
          title: 'Audit Ledger & Execution Traces',
          desc: 'Cryptographically verifiable, append-only record of every payment recovery decision.',
        };
      case '/dashboard/compliance':
        return {
          category: 'Regulatory Governance',
          title: 'Policy Kernel & TRAI Compliance Shield',
          desc: 'Deterministic enforcement of TRAI 10:00–21:00 IST communication windows and stopping rules.',
        };
      case '/dashboard/analytics':
        return {
          category: 'Financial Economics',
          title: 'Merchant ROI & Unit Economics',
          desc: 'Real-time revenue salvage modeling, dunning cost attribution, and cashflow waterfall.',
        };
      case '/dashboard':
      default:
        return {
          category: 'Autonomous Operations',
          title: 'Cockpit Overview',
          desc: 'Deterministic policy execution · Razorpay test environment · Real-time recovery telemetry',
        };
    }
  };

  const breadcrumb = getBreadcrumb();

  return (
    <header className="app-header">
      <div className="header-meta-group">
        <div className="header-eyebrow">RecoverAI / {breadcrumb.category}</div>
        <h1 className="header-title">{breadcrumb.title}</h1>
        <p className="header-desc">{breadcrumb.desc}</p>
      </div>

      <HeaderNetwork3D />

      <div className="header-right-controls">
        {/* Live IST Clock with dynamic TRAI Compliance Status */}
        <div className={`ist-clock-badge ${isTraiOpen ? 'trai-status-open' : 'trai-status-night'}`}>
          <span className="ist-clock-dot" />
          <span>
            {new Intl.DateTimeFormat('en-IN', {
              timeZone: 'Asia/Kolkata',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            }).format(istTime)}{' '}
            IST
          </span>
          <span className="trai-tag">{isTraiOpen ? 'WINDOW OPEN' : 'NOCTURNAL HOLD'}</span>
        </div>

        {/* Sync / Refresh Button */}
        <button
          type="button"
          className={`header-sync-btn ${isRefreshing ? 'sync-refreshing' : ''} ${refreshCompleted ? 'sync-completed' : ''}`}
          onClick={handleManualRefresh}
          disabled={isRefreshing}
          title="Force telemetry refresh [R]"
        >
          <span className={`sync-icon ${isRefreshing ? 'spin' : ''}`}>↻</span>
          <span>{isRefreshing ? 'SYNCING…' : refreshCompleted ? 'UPDATED' : 'SYNC'}</span>
        </button>

        {/* Keyboard Shortcuts Trigger */}
        <button
          type="button"
          className="header-shortcut-btn"
          onClick={() => setShowShortcuts(true)}
          title="View Keyboard Shortcuts [?]"
        >
          ?
        </button>
      </div>
    </header>
  );
}
