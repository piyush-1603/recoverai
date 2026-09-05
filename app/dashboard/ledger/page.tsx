'use client';

import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  useDashboard,
  formatTime,
  resultLabel,
  resultTone,
  policySignal,
  tierFromReason,
} from '../DashboardContext';

export default function AuditLedgerPage() {
  const {
    auditLogs,
    loading,
    selectedLog,
    setSelectedLog,
    newLogIds,
    stats,
  } = useDashboard();

  const [filterText, setFilterText] = useState('');
  const [activeFilterPill, setActiveFilterPill] = useState<
    'ALL' | 'OVERRIDDEN' | 'RECOVERED' | 'TRAI_HOLD' | 'UNRECOVERABLE'
  >('ALL');

  const filterCounts = useMemo(() => {
    return {
      ALL: auditLogs.length,
      OVERRIDDEN: auditLogs.filter((log) => log.actor === 'policy_engine_override').length,
      RECOVERED: auditLogs.filter((log) => log.result.includes('recovered') || log.result.includes('captured'))
        .length,
      TRAI_HOLD: auditLogs.filter(
        (log) =>
          log.result === 'compliance_deferred' ||
          log.reason.toLowerCase().includes('trai') ||
          log.reason.toLowerCase().includes('nudge window')
      ).length,
      UNRECOVERABLE: auditLogs.filter((log) => log.result.includes('unrecoverable')).length,
    };
  }, [auditLogs]);

  const filteredLogs = useMemo(() => {
    return auditLogs.filter((log) => {
      if (activeFilterPill === 'OVERRIDDEN' && log.actor !== 'policy_engine_override') {
        return false;
      }
      if (
        activeFilterPill === 'RECOVERED' &&
        !log.result.includes('recovered') &&
        !log.result.includes('captured')
      ) {
        return false;
      }
      if (activeFilterPill === 'TRAI_HOLD') {
        const isHold =
          log.result === 'compliance_deferred' ||
          log.reason.toLowerCase().includes('trai') ||
          log.reason.toLowerCase().includes('nudge window');
        if (!isHold) return false;
      }
      if (activeFilterPill === 'UNRECOVERABLE' && !log.result.includes('unrecoverable')) {
        return false;
      }

      if (!filterText) return true;
      return [log.transactionId, log.actor, log.action, log.reason, log.result].some((value) =>
        value.toLowerCase().includes(filterText.toLowerCase())
      );
    });
  }, [auditLogs, activeFilterPill, filterText]);

  return (
    <div className="ledger-page-container">
      <Card>
        <CardHeader>
          <div className="ledger-header-row">
            <div>
              <div className="eyebrow">Cryptographically verifiable trail</div>
              <h2 className="section-title">
                Immutable Audit Ledger{' '}
                <span className="mono" style={{ color: '#94a3b8' }}>
                  / {filteredLogs.length} of {auditLogs.length} events
                </span>
              </h2>
              <p className="section-subtitle">
                Append-only event log recording every AI advisory proposal, deterministic policy override, and Razorpay webhook settlement.
              </p>
            </div>

            {/* Search filter input */}
            <div className="ledger-search-box">
              <span className="search-icon">🔍</span>
              <input
                type="search"
                className="ledger-search-input"
                placeholder="FILTER ID / ACTOR / ACTION / REASON…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
              {filterText && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setFilterText('')}
                >
                  ×
                </button>
              )}
            </div>
          </div>

          {/* Quick Filter Pills */}
          <div className="filter-pill-bar">
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'ALL' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('ALL')}
            >
              ALL <span className="filter-pill-count">{filterCounts.ALL}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'OVERRIDDEN' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('OVERRIDDEN')}
            >
              POLICY OVERRIDES <span className="filter-pill-count">{filterCounts.OVERRIDDEN}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'RECOVERED' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('RECOVERED')}
            >
              RECOVERED <span className="filter-pill-count">{filterCounts.RECOVERED}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'TRAI_HOLD' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('TRAI_HOLD')}
            >
              TRAI HOLDS <span className="filter-pill-count">{filterCounts.TRAI_HOLD}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'UNRECOVERABLE' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('UNRECOVERABLE')}
            >
              UNRECOVERABLE <span className="filter-pill-count">{filterCounts.UNRECOVERABLE}</span>
            </button>
          </div>
        </CardHeader>

        <CardContent>
          <div className="table-scroll" style={{ maxHeight: 'calc(100vh - 290px)' }}>
            <table className="audit-table">
              <thead>
                <tr>
                  <th style={{ width: '90px' }}>Time</th>
                  <th style={{ width: '110px' }}>Transaction</th>
                  <th style={{ width: '160px' }}>Actor</th>
                  <th style={{ width: '140px' }}>Action</th>
                  <th>Decision Record & Execution Context</th>
                  <th style={{ width: '180px' }}>Result</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length ? (
                  filteredLogs.map((log) => {
                    const signal = policySignal(log);
                    const tier = tierFromReason(log.reason);
                    const isSelected = selectedLog?.id === log.id;
                    return (
                      <motion.tr
                        layout
                        key={log.id}
                        className={`clickable-row ${newLogIds.has(log.id) ? 'audit-row' : ''} ${
                          signal ? 'audit-row-override' : ''
                        } ${isSelected ? 'row-active' : ''}`}
                        initial={newLogIds.has(log.id) ? { opacity: 0, y: -8 } : false}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.28 }}
                        onClick={() => setSelectedLog(log)}
                        title="Click to view complete transaction trace drawer"
                      >
                        <td>{formatTime(log.timestamp)}</td>
                        <td className="id">#{log.transactionId.slice(-8)}</td>
                        <td>
                          <Badge tone={signal ? 'warning' : 'neutral'}>{log.actor.replace(/_/g, ' ')}</Badge>
                          {tier && (
                            <Badge className={`tier-${tier.toLowerCase()}`} tone="accent">
                              {tier}
                            </Badge>
                          )}
                        </td>
                        <td className="action">{log.action.replace(/_/g, ' ')}</td>
                        <td className="reason">
                          {log.reason}
                          {signal && (
                            <Badge className="override-signal" tone="warning">
                              AI wanted: {signal.ai} → Policy enforced: {signal.enforced}
                            </Badge>
                          )}
                        </td>
                        <td>
                          <Badge tone={resultTone(log.result)}>{resultLabel(log.result)}</Badge>
                        </td>
                      </motion.tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6} className="empty">
                      {loading ? 'LOADING AUDIT TRAIL…' : 'NO AUDIT ENTRIES FOUND MATCHING CRITERIA'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
