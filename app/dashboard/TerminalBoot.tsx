'use client';

import React, { useEffect, useState, useRef } from 'react';
import { motion } from 'framer-motion';

export interface TerminalBootProps {
  transactionCount: number | null;
  policyVersion: string;
  onDone: () => void;
  isStandaloneModal?: boolean;
}

interface DiagnosticStep {
  tag: string;
  tagColor: string;
  text: string;
  status: 'PENDING' | 'RUNNING' | 'OK';
  timeMs?: number;
}

export function TerminalBoot({
  transactionCount,
  policyVersion,
  onDone,
  isStandaloneModal = false,
}: TerminalBootProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isSkipped, setIsSkipped] = useState(false);
  const terminalBodyRef = useRef<HTMLDivElement>(null);

  const steps: DiagnosticStep[] = [
    { tag: 'INIT', tagColor: '#60a5fa', text: 'Initializing RecoverAI execution environment (Darwin arm64)...', status: 'OK', timeMs: 42 },
    { tag: 'RZP ', tagColor: '#3395ff', text: 'Connecting to Razorpay gateway testnet API (rzp_test_)...', status: 'OK', timeMs: 120 },
    { tag: 'AUTH', tagColor: '#34d399', text: 'Verifying webhook cryptographic handler (HMAC-SHA256)...', status: 'OK', timeMs: 65 },
    { tag: 'PLCY', tagColor: '#fbbf24', text: `Compiling deterministic Policy Kernel ${policyVersion} (10 active rules)...`, status: 'OK', timeMs: 88 },
    { tag: 'TRAI', tagColor: '#f59e0b', text: 'Engaging TRAI TCCCPR 2018 nocturnal compliance shield (10:00–21:00 IST)...', status: 'OK', timeMs: 54 },
    { tag: 'AI  ', tagColor: '#c084fc', text: 'Establishing AI advisory reasoning connection (Google Gemini 2.5 Flash)...', status: 'OK', timeMs: 210 },
    { tag: 'DATA', tagColor: '#38bdf8', text: `Mounting append-only audit ledger (${transactionCount ?? 65} benchmark records)...`, status: 'OK', timeMs: 95 },
    { tag: 'SYS ', tagColor: '#4ade80', text: 'All policy & recovery subsystems green. Terminal ready.', status: 'OK', timeMs: 30 },
  ];

  // Auto-scroll terminal body as new lines appear
  useEffect(() => {
    if (terminalBodyRef.current) {
      terminalBodyRef.current.scrollTop = terminalBodyRef.current.scrollHeight;
    }
  }, [currentStepIndex]);

  // Stepped typing/progress sequence
  useEffect(() => {
    if (isSkipped) return;

    if (currentStepIndex < steps.length) {
      const stepDuration = steps[currentStepIndex].timeMs || 100;
      const timer = setTimeout(() => {
        setCurrentStepIndex((prev) => prev + 1);
        setProgress(Math.min(100, Math.round(((currentStepIndex + 1) / steps.length) * 100)));
      }, stepDuration + 60);

      return () => clearTimeout(timer);
    } else {
      // Completed all steps
      const exitTimer = setTimeout(() => {
        onDone();
      }, 450);
      return () => clearTimeout(exitTimer);
    }
  }, [currentStepIndex, isSkipped, onDone, steps]);

  // Keyboard shortcut: Space or Escape to skip immediately
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        setIsSkipped(true);
        onDone();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDone]);

  const handleSkip = () => {
    setIsSkipped(true);
    onDone();
  };

  return (
    <div className={`terminal-boot-overlay ${isStandaloneModal ? 'terminal-modal-overlay' : ''}`}>
      <motion.div
        className="terminal-window"
        initial={{ scale: 0.94, opacity: 0, y: 15 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 20 }}
        transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Window Chrome Header */}
        <div className="terminal-header">
          <div className="terminal-traffic-lights">
            <span className="light light-red" onClick={handleSkip} title="Close / Skip [Esc]" />
            <span className="light light-yellow" onClick={handleSkip} title="Minimize" />
            <span className="light light-green" onClick={handleSkip} title="Expand" />
          </div>

          <div className="terminal-title">
            <span className="terminal-icon">⚡</span>
            recoverai-ops@mumbai-core-01: ~ (zsh) — 80×24
          </div>

          <div className="terminal-header-badges">
            <span className="t-badge t-badge-pulse">LIVE TTY</span>
            <span className="t-badge t-badge-blue">RZP-TESTNET</span>
            <span className="t-badge t-badge-amber">TRAI-IN</span>
          </div>
        </div>

        {/* Terminal Body */}
        <div className="terminal-body" ref={terminalBodyRef} onClick={handleSkip}>
          {/* ASCII Art Logo */}
          <div className="terminal-ascii-art" aria-hidden="true">
{`  ██████╗ ███████╗ ██████╗ ██████╗ ██╗   ██╗███████╗██████╗  █████╗ ██╗
  ██╔══██╗██╔════╝██╔════╝██╔═══██╗██║   ██║██╔════╝██╔══██╗██╔══██╗██║
  ██████╔╝█████╗  ██║     ██║   ██║██║   ██║█████╗  ██████╔╝███████║██║
  ██╔══██╗██╔══╝  ██║     ██║   ██║╚██╗ ██╔╝██╔══╝  ██╔══██╗██╔══██║██║
  ██║  ██║███████╗╚██████╗╚██████╔╝ ╚████╔╝ ███████╗██║  ██║██║  ██║██║`}
          </div>

          <div className="terminal-specs-banner">
            <div><span className="spec-label">SYSTEM :</span> RecoverAI Autonomous Revenue Recovery Kernel v1.2.0</div>
            <div><span className="spec-label">TARGET :</span> Razorpay Payment Gateway (Track 03 - AI Revenue Salvage)</div>
            <div><span className="spec-label">MEMORY :</span> 148.2 MB / 512.0 MB | SQLite WAL (dev.db) | BusyTimeout: 5000ms</div>
            <div><span className="spec-label">POLICY :</span> Deterministic Policy Kernel · RBI Mandates · TRAI TCCCPR 2018</div>
          </div>

          <div className="terminal-divider" />

          {/* Diagnostic Execution Steps */}
          <div className="terminal-logs">
            {steps.slice(0, currentStepIndex + 1).map((step, idx) => {
              const isCurrent = idx === currentStepIndex && currentStepIndex < steps.length;
              return (
                <div key={idx} className="terminal-log-line">
                  <span className="log-timestamp">
                    {new Date(Date.now() - (steps.length - idx) * 90).toLocaleTimeString('en-IN', {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                  <span className="log-tag" style={{ color: step.tagColor, borderColor: step.tagColor }}>
                    [{step.tag}]
                  </span>
                  <span className="log-text">{step.text}</span>
                  <span className={`log-status ${isCurrent ? 'status-running' : 'status-ok'}`}>
                    {isCurrent ? '⋯ PENDING' : '✔ OK'}
                  </span>
                </div>
              );
            })}
            {currentStepIndex < steps.length && (
              <div className="terminal-cursor-line">
                <span className="terminal-prompt">›</span>
                <span className="terminal-cursor">█</span>
              </div>
            )}
          </div>

          {/* Dynamic Progress Bar */}
          <div className="terminal-progress-container">
            <div className="terminal-progress-labels">
              <span>SUBSYSTEM INITIALIZATION</span>
              <span>{progress}% COMPLETE</span>
            </div>
            <div className="terminal-progress-track">
              <div
                className="terminal-progress-fill"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        </div>

        {/* Window Footer & Action Bar */}
        <div className="terminal-footer">
          <div className="terminal-footer-hint">
            Press <kbd>SPACE</kbd> or <kbd>ESC</kbd> to bypass diagnostic boot
          </div>
          <button type="button" className="terminal-skip-btn" onClick={handleSkip}>
            SKIP TO CONSOLE [SPACE] ››
          </button>
        </div>
      </motion.div>
    </div>
  );
}
export default TerminalBoot;
