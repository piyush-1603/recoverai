'use client';

import React from 'react';
import { motion } from 'framer-motion';

interface Shortcut {
  key: string;
  label: string;
  category: 'NAVIGATION' | 'ACTIONS' | 'DIAGNOSTICS';
}

const SHORTCUTS: Shortcut[] = [
  { key: 'W', label: 'Simulate Signed Razorpay Payment Webhook', category: 'ACTIONS' },
  { key: 'M', label: 'Open Merchant ROI & Salvage Modeler', category: 'ACTIONS' },
  { key: 'C', label: 'Run Off-Window TRAI Compliance Test', category: 'ACTIONS' },
  { key: 'L', label: 'Trigger Live Demo Event', category: 'ACTIONS' },
  { key: 'R', label: 'Refresh Ledger & Recompute Metrics', category: 'ACTIONS' },
  { key: 'T', label: 'Open System Terminal / Diagnostic Logs', category: 'DIAGNOSTICS' },
  { key: '?', label: 'Show / Hide Keyboard Shortcuts', category: 'NAVIGATION' },
  { key: 'ESC', label: 'Dismiss Open Drawer, Modal, or Terminal', category: 'NAVIGATION' },
];

export function KeyboardShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="shortcuts-backdrop" onClick={onClose}>
      <motion.div
        className="shortcuts-modal"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="shortcuts-header">
          <div>
            <div className="shortcuts-title">KEYBOARD SHORTCUTS</div>
            <div className="shortcuts-desc">Pro operator hotkeys for high-velocity hackathon demonstrations</div>
          </div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close shortcuts modal">
            ×
          </button>
        </div>

        <div className="shortcuts-grid">
          {SHORTCUTS.map((s, idx) => (
            <div key={idx} className="shortcut-row">
              <span className="shortcut-label">{s.label}</span>
              <kbd className="shortcut-kbd">{s.key}</kbd>
            </div>
          ))}
        </div>

        <div className="shortcuts-footer">
          <span>RecoverAI Fintech Operations · Powered by Razorpay & Google Gemini</span>
        </div>
      </motion.div>
    </div>
  );
}

export default KeyboardShortcutsModal;
