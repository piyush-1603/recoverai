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
              className="live-notification-banner"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
            >
              <div className="notification-content">
                <span className="notification-dot" />
                <span>{triggerNotification}</span>
              </div>
              <button
                type="button"
                className="notification-dismiss"
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
              className="recovery-banner"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
            >
              <span className="pulse-indicator" />
              <span>
                <strong>LIVE RECOVERY EVENT VERIFIED:</strong>{' '}
                {formatRupees(liveRecovery.amountPaise)} captured via real Razorpay Webhook on #{liveRecovery.id.slice(-8)}
              </span>
            </motion.div>
          )}

          {/* TRAI Compliance Interception Alert Banner */}
          {complianceHold && (
            <motion.div
              className="compliance-alert-banner"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.25 }}
            >
              <div className="compliance-banner-header">
                <div className="compliance-banner-badge">
                  <span className="compliance-hold-dot" />
                  <strong>TRAI NOCTURNAL SHIELD ACTIVE (10:00–21:00 IST)</strong>
                </div>
                <div className="compliance-banner-meta">
                  <span>Simulated Off-Window: 02:00 IST</span>
                  <span>Target: #{complianceHold.transactionId.slice(-8)}</span>
                </div>
                <button
                  type="button"
                  className="drawer-close"
                  onClick={dismissComplianceHold}
                  aria-label="Dismiss compliance alert"
                  style={{ color: '#f59e0b', fontSize: 16 }}
                >
                  ×
                </button>
              </div>
              <div className="compliance-banner-body">
                <strong>REGULATORY INTERCEPTION:</strong> AI (Google Gemini) recommended{' '}
                <code>"send_nudge"</code>, but RecoverAI's deterministic policy authority intercepted and suppressed
                the action. Under <strong>TRAI TCCCPR Regulations</strong>, automated commercial communications
                (SMS/WhatsApp) are prohibited outside the 10:00–21:00 IST window. Action deferred to next compliant window.
              </div>
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
