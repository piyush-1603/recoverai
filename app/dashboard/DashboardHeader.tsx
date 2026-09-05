'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { RotateCw } from 'lucide-react';
import { useDashboard } from './DashboardContext';

export function DashboardHeader() {
  const pathname = usePathname();
  const {
    istTime,
    isRefreshing,
    refreshCompleted,
    handleManualRefresh,
    lastRefreshed,
  } = useDashboard();

  const getPageInfo = () => {
    switch (pathname) {
      case '/dashboard/ledger':
        return {
          title: 'Transactions',
          desc: 'Review recovery attempts, outcomes and execution details.',
        };
      case '/dashboard/compliance':
        return {
          title: 'Compliance',
          desc: 'Monitor recovery policies, communication windows and safeguards.',
        };
      case '/dashboard/analytics':
        return {
          title: 'Analytics',
          desc: 'Measure recovery performance and estimated financial impact.',
        };
      case '/dashboard':
      default:
        return {
          title: 'Overview',
          desc: 'Monitor payment failures, recovered revenue and recent recovery activity.',
        };
    }
  };

  const pageInfo = getPageInfo();

  // Format updated time
  const updatedTimeStr = new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(lastRefreshed);

  const istClockStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(istTime);

  return (
    <header className="app-header">
      <div className="header-left-group">
        <h1 className="header-title">{pageInfo.title}</h1>
        <p className="header-desc">{pageInfo.desc}</p>
      </div>

      <div className="header-right-controls">
        <span className="header-badge-test">Test mode</span>

        <span className="header-meta-time" title={`Current IST: ${istClockStr} IST`}>
          Updated {updatedTimeStr}
        </span>

        <button
          type="button"
          className={`header-refresh-btn ${isRefreshing ? 'refreshing' : ''}`}
          onClick={handleManualRefresh}
          disabled={isRefreshing}
          title="Refresh data (Hotkey: R)"
        >
          <RotateCw size={14} className={isRefreshing ? 'spin-icon' : ''} />
          <span>{isRefreshing ? 'Refreshing…' : refreshCompleted ? 'Updated' : 'Refresh'}</span>
        </button>
      </div>
    </header>
  );
}
