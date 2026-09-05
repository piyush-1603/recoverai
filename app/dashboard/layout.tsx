'use client';

import React, { useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  DashboardProvider,
  useDashboard,
  formatRupees,
} from './DashboardContext';
import { DashboardSidebar } from './DashboardSidebar';
import { DashboardHeader } from './DashboardHeader';
import { TransactionTraceDrawer } from './TransactionTraceDrawer';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { TerminalBoot } from './TerminalBoot';
import './dashboard.css';

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const {
    stats,
    policyVersion,
    triggerNotification,
    setTriggerNotification,
    liveRecovery,
    complianceHold,
    dismissComplianceHold,
    showShortcuts,
    setShowShortcuts,
    showTerminal,
    setShowTerminal,
    selectedLog,
    setSelectedLog,
    handleManualRefresh,
    handleTrigger,
    handleSimulateWebhook,
    isRefreshing,
  } = useDashboard();

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger hotkeys if typing in input or textarea
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if (e.key === 'Escape') {
        if (selectedLog) setSelectedLog(null);
        if (showShortcuts) setShowShortcuts(false);
        if (showTerminal) setShowTerminal(false);
        return;
      }

      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setShowShortcuts(!showShortcuts);
        return;
      }

      if (e.key === '`' || e.key.toLowerCase() === 't') {
        e.preventDefault();
        setShowTerminal(!showTerminal);
        return;
      }

      if (e.key.toLowerCase() === 'r') {
        e.preventDefault();
        handleManualRefresh();
        return;
      }

      if (e.key.toLowerCase() === 'w') {
        e.preventDefault();
        handleSimulateWebhook();
        return;
      }

      if (e.key.toLowerCase() === 'l') {
        e.preventDefault();
        handleTrigger('live');
        return;
      }

      if (e.key.toLowerCase() === 'o' || e.key.toLowerCase() === 'c') {
        e.preventDefault();
        handleTrigger('compliance');
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedLog,
    showShortcuts,
    showTerminal,
    handleManualRefresh,
    handleSimulateWebhook,
    handleTrigger,
    setSelectedLog,
    setShowShortcuts,
    setShowTerminal,
  ]);

  return (
    <div className="dashboard-shell">
      {/* Persistent Left Sidebar */}
      <DashboardSidebar />

      {/* Main Content Area */}
      <div className="dashboard-main-viewport">
        <DashboardHeader />

        <div className="dashboard-page-container">
          {/* Real-time System Notification Banner */}
          {triggerNotification && (
            <motion.div
              className="saas-banner saas-banner-info"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="saas-banner-content">
                <span className="saas-banner-dot bg-blue" />
                <span className="saas-banner-text">{triggerNotification}</span>
              </div>
              <button
                type="button"
                className="saas-banner-close"
                onClick={() => setTriggerNotification(null)}
                aria-label="Dismiss banner"
              >
                ×
              </button>
            </motion.div>
          )}

          {/* Webhook Recovery Banner */}
          {liveRecovery && (
            <motion.div
              className="saas-banner saas-banner-success"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="saas-banner-content">
                <span className="saas-banner-dot bg-green" />
                <span className="saas-banner-text">
                  <strong>Payment recovered</strong> — {formatRupees(liveRecovery.amountPaise)} was captured successfully for transaction ••••{liveRecovery.id.slice(-8)}.
                </span>
              </div>
            </motion.div>
          )}

          {/* TRAI Compliance Interception Alert Banner */}
          {complianceHold && (
            <motion.div
              className="saas-banner saas-banner-warning"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="saas-banner-content">
                <span className="saas-banner-dot bg-amber" />
                <span className="saas-banner-text">
                  <strong>Recovery action delayed</strong> — Customer communication was postponed because it falls outside the configured TRAI communication window (10:00–21:00 IST). Target transaction ••••{complianceHold.transactionId.slice(-8)}.
                </span>
              </div>
              <button
                type="button"
                className="saas-banner-close"
                onClick={dismissComplianceHold}
                aria-label="Dismiss alert"
              >
                ×
              </button>
            </motion.div>
          )}

          {/* Active View Content */}
          <main className="dashboard-content-body">
            {children}
          </main>
        </div>
      </div>

      {/* Global Overlays & Modals */}
      <TransactionTraceDrawer />

      <AnimatePresence>
        {showShortcuts && (
          <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showTerminal && (
          <TerminalBoot
            transactionCount={stats?.totalTransactions ?? null}
            policyVersion={policyVersion}
            onDone={() => setShowTerminal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <DashboardProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </DashboardProvider>
  );
}
