'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Copy, Check, ShieldCheck, Sparkles, Terminal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  useDashboard,
  formatRupees,
  formatTime,
  resultLabel,
  resultTone,
  generateReplayCurl,
} from './DashboardContext';

export function TransactionTraceDrawer() {
  const { selectedLog, setSelectedLog } = useDashboard();
  const [copiedCurl, setCopiedCurl] = useState(false);

  const handleCopyCurl = (cmd: string) => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(cmd);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 2000);
    }
  };

  const formatAction = (str: string) => {
    if (!str) return '—';
    return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };

  return (
    <AnimatePresence>
      {selectedLog && (
        <>
          <motion.div
            className="drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setSelectedLog(null)}
          />
          <motion.aside
            className="drawer-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 320 }}
          >
            {/* Header */}
            <div className="drawer-header">
              <div className="drawer-title-group">
                <div className="drawer-title-row">
                  <h3 className="drawer-title">
                    Transaction ••••{selectedLog.transactionId.slice(-8)}
                  </h3>
                  <Badge tone={resultTone(selectedLog.result)}>
                    {resultLabel(selectedLog.result)}
                  </Badge>
                </div>
                <div className="drawer-subtitle">
                  Event ID {selectedLog.eventId} • {formatTime(selectedLog.timestamp)}
                </div>
              </div>
              <button
                type="button"
                className="drawer-close-btn"
                onClick={() => setSelectedLog(null)}
                aria-label="Close drawer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="drawer-body">
              {/* Summary Section */}
              <div className="drawer-section">
                <h4 className="drawer-section-heading">Transaction summary</h4>
                <div className="drawer-data-grid">
                  <div className="data-item">
                    <span className="data-item-label">Amount</span>
                    <span className="data-item-value font-semibold">
                      {selectedLog.amountPaise ? formatRupees(selectedLog.amountPaise) : 'N/A'}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Outcome</span>
                    <span className="data-item-value font-medium">
                      {resultLabel(selectedLog.result)}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Channel</span>
                    <span className="data-item-value">
                      {formatAction(selectedLog.channel || 'Gateway retry')}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Messaging cost</span>
                    <span className="data-item-value">
                      {selectedLog.messagingCostPaise
                        ? formatRupees(selectedLog.messagingCostPaise)
                        : '₹0.00 (Gateway)'}
                    </span>
                  </div>
                </div>

                <div className="drawer-reason-card">
                  <span className="reason-card-label">Execution reason</span>
                  <p className="reason-card-text">{selectedLog.reason}</p>
                </div>
              </div>

              {/* Policy Decision Details */}
              <div className="drawer-section">
                <div className="drawer-section-header">
                  <ShieldCheck size={16} className="text-primary" />
                  <h4 className="drawer-section-heading">Policy execution</h4>
                </div>
                <div className="drawer-data-grid">
                  <div className="data-item">
                    <span className="data-item-label">Final action</span>
                    <span className="data-item-value font-semibold text-primary">
                      {formatAction(selectedLog.action)}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Policy rule</span>
                    <span className="data-item-value mono">
                      {selectedLog.ruleId || 'R_DEFAULT'}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Decision authority</span>
                    <span className="data-item-value">
                      {formatAction(selectedLog.actor)}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Gateway entity</span>
                    <span className="data-item-value mono text-muted">
                      {selectedLog.razorpayEntityId || 'N/A'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Advisory Details */}
              <div className="drawer-section">
                <div className="drawer-section-header">
                  <Sparkles size={16} className="text-secondary" />
                  <h4 className="drawer-section-heading">Advisory details</h4>
                </div>
                <div className="drawer-data-grid">
                  <div className="data-item">
                    <span className="data-item-label">Suggested action</span>
                    <span className="data-item-value font-medium">
                      {formatAction(selectedLog.aiRecommendedAction || selectedLog.action)}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Advisory model</span>
                    <span className="data-item-value">
                      {selectedLog.model || 'Gemini 2.5'}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Inference latency</span>
                    <span className="data-item-value">
                      {selectedLog.providerLatencyMs ? `${selectedLog.providerLatencyMs}ms` : '342ms'}
                    </span>
                  </div>
                  <div className="data-item">
                    <span className="data-item-label">Tokens</span>
                    <span className="data-item-value mono text-muted">
                      {selectedLog.promptTokens ?? 340} prompt / {selectedLog.completionTokens ?? 78} completion
                    </span>
                  </div>
                </div>

                {selectedLog.aiReasoning && (
                  <div className="drawer-advisory-note">
                    <span className="note-title">Recommendation context</span>
                    <p className="note-body">{selectedLog.aiReasoning}</p>
                  </div>
                )}
              </div>

              {/* Webhook Simulation cURL */}
              <div className="drawer-section">
                <div className="drawer-curl-header">
                  <div className="drawer-section-header">
                    <Terminal size={15} className="text-secondary" />
                    <h4 className="drawer-section-heading">Webhook simulator cURL</h4>
                  </div>
                  <button
                    type="button"
                    className="btn-curl-copy"
                    onClick={() => handleCopyCurl(generateReplayCurl(selectedLog))}
                  >
                    {copiedCurl ? (
                      <>
                        <Check size={12} className="text-success" />
                        <span>Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy size={12} />
                        <span>Copy cURL</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="drawer-curl-pre">
                  <code>{generateReplayCurl(selectedLog)}</code>
                </pre>
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

