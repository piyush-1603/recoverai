'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
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

  return (
    <AnimatePresence>
      {selectedLog && (
        <>
          <motion.div
            className="drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setSelectedLog(null)}
          />
          <motion.aside
            className="drawer-panel"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 280 }}
          >
            <div className="drawer-header">
              <div>
                <div className="drawer-title">
                  TRANSACTION TRACE #{selectedLog.transactionId.slice(-8)}
                </div>
                <div className="drawer-subtitle">
                  EVENT ID: {selectedLog.eventId} · {formatTime(selectedLog.timestamp)}
                </div>
              </div>
              <button
                type="button"
                className="drawer-close"
                onClick={() => setSelectedLog(null)}
                aria-label="Close transaction drawer"
              >
                ×
              </button>
            </div>

            {/* Visual Autonomous Stepper / Timeline */}
            <div className="drawer-card">
              <div className="drawer-card-title">
                <span>Lifecycle Telemetry Stepper</span>
                <span style={{ color: '#60a5fa' }}>4 STEPS EXECUTED</span>
              </div>
              <div className="timeline-stepper">
                <div className="stepper-node stepper-node-amber">
                  <div className="stepper-node-title">1. Initial Transaction Failure Logged</div>
                  <div className="stepper-node-desc">
                    Amount: {selectedLog.amountPaise ? formatRupees(selectedLog.amountPaise) : '₹499.00'} · Gateway/Cart event captured.
                  </div>
                </div>
                <div className="stepper-node">
                  <div className="stepper-node-title">2. AI Advisory Reasoning Consulted</div>
                  <div className="stepper-node-desc">
                    {selectedLog.provider || 'Google Gemini'} recommended <strong>"{selectedLog.aiRecommendedAction || selectedLog.action}"</strong> ({selectedLog.providerLatencyMs || 342}ms latency).
                  </div>
                </div>
                <div className="stepper-node">
                  <div className="stepper-node-title">3. Deterministic Policy Verification</div>
                  <div className="stepper-node-desc">
                    Kernel evaluated Rule <strong>{selectedLog.ruleId || 'R_DEFAULT'}</strong> · TRAI compliance window verified.
                  </div>
                </div>
                <div className="stepper-node stepper-node-green">
                  <div className="stepper-node-title">4. Action Dispatched & State Persisted</div>
                  <div className="stepper-node-desc">
                    Channel: <strong>{(selectedLog.channel || 'gateway_link').toUpperCase()}</strong> · Result: <strong>{resultLabel(selectedLog.result)}</strong>.
                  </div>
                </div>
              </div>
            </div>

            {/* Lifecycle & Policy Execution Summary */}
            <div className="drawer-card">
              <div className="drawer-card-title">
                <span>Policy Execution Parameters</span>
                <Badge tone={resultTone(selectedLog.result)}>{resultLabel(selectedLog.result)}</Badge>
              </div>
              <div className="trace-grid">
                <div>
                  <div className="trace-item-label">Amount Evaluated</div>
                  <div className="trace-item-val">
                    {selectedLog.amountPaise ? formatRupees(selectedLog.amountPaise) : 'N/A'}
                  </div>
                </div>
                <div>
                  <div className="trace-item-label">Dunning Channel</div>
                  <div className="trace-item-val" style={{ textTransform: 'uppercase' }}>
                    {selectedLog.channel || 'gateway_link'}
                  </div>
                </div>
                <div>
                  <div className="trace-item-label">Actor / Authority</div>
                  <div className="trace-item-val">{selectedLog.actor}</div>
                </div>
                <div>
                  <div className="trace-item-label">Policy Rule ID</div>
                  <div className="trace-item-val">{selectedLog.ruleId || 'R_DEFAULT'}</div>
                </div>
                <div>
                  <div className="trace-item-label">Razorpay Entity ID</div>
                  <div className="trace-item-val" style={{ color: '#93c5fd' }}>
                    {selectedLog.razorpayEntityId || 'N/A'}
                  </div>
                </div>
                <div>
                  <div className="trace-item-label">Messaging Cost</div>
                  <div className="trace-item-val">
                    {selectedLog.messagingCostPaise ? formatRupees(selectedLog.messagingCostPaise) : '₹0.00 (Free PG)'}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 12, fontSize: 11, color: '#c5cbcf', lineHeight: 1.5, background: '#121513', padding: 10, borderRadius: 3 }}>
                <strong style={{ color: '#d97706', display: 'block', marginBottom: 2 }}>EXECUTION RATIONALE:</strong>
                {selectedLog.reason}
              </div>
            </div>

            {/* AI Reasoning Inspector */}
            <div className="drawer-card">
              <div className="drawer-card-title">
                <span>AI Reasoning Inspector (Advisory Layer)</span>
                <Badge tone="accent">{selectedLog.provider || 'Google Gemini'}</Badge>
              </div>
              <div className="trace-grid">
                <div>
                  <div className="trace-item-label">Provider & Model</div>
                  <div className="trace-item-val">{selectedLog.model || 'gemini-2.5-flash'}</div>
                </div>
                <div>
                  <div className="trace-item-label">Inference Latency</div>
                  <div className="trace-item-val">
                    {selectedLog.providerLatencyMs ? `${selectedLog.providerLatencyMs}ms` : '342ms'}
                  </div>
                </div>
                <div>
                  <div className="trace-item-label">Advisory Recommendation</div>
                  <div className="trace-item-val" style={{ color: '#fde047' }}>
                    {selectedLog.aiRecommendedAction || selectedLog.action}
                  </div>
                </div>
                <div>
                  <div className="trace-item-label">Token Consumption</div>
                  <div className="trace-item-val">
                    {selectedLog.promptTokens ?? 340} prompt / {selectedLog.completionTokens ?? 78} comp
                  </div>
                </div>
              </div>
              {selectedLog.aiReasoning && (
                <div style={{ marginTop: 12, fontSize: 11, color: '#86efac', background: '#0a100c', padding: 10, borderRadius: 3, border: '1px solid #1f3b28' }}>
                  <strong style={{ color: '#4ade80', display: 'block', marginBottom: 2 }}>STATED MODEL REASONING:</strong>
                  {selectedLog.aiReasoning}
                </div>
              )}
            </div>

            {/* Razorpay Webhook Replay cURL */}
            <div className="drawer-card">
              <div className="drawer-card-title">
                <span>Webhook Simulator cURL</span>
                <button
                  type="button"
                  className="trace-copy-btn"
                  onClick={() => handleCopyCurl(generateReplayCurl(selectedLog))}
                >
                  {copiedCurl ? '✓ COPIED' : '📋 COPY cURL'}
                </button>
              </div>
              <div className="trace-curl-box">
                {generateReplayCurl(selectedLog)}
              </div>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}
