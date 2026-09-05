'use client';

import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  useDashboard,
  formatTime,
  formatRupees,
  resultLabel,
  resultTone,
  policySignal,
} from '../DashboardContext';

export default function TransactionsPage() {
  const {
    auditLogs,
    loading,
    selectedLog,
    setSelectedLog,
    newLogIds,
  } = useDashboard();

  const [filterText, setFilterText] = useState('');
  const [activeFilterPill, setActiveFilterPill] = useState<
    'ALL' | 'OVERRIDDEN' | 'RECOVERED' | 'TRAI_HOLD' | 'UNRECOVERABLE'
  >('ALL');

  const filterCounts = useMemo(() => {
    return {
      ALL: auditLogs.length,
      OVERRIDDEN: auditLogs.filter((log) => log.actor === 'policy_engine_override').length,
      RECOVERED: auditLogs.filter((log) => log.result.includes('recovered') || log.result.includes('captured')).length,
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

  const formatAction = (str: string) => {
    if (!str) return '—';
    return str.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };

  return (
    <div className="ledger-page-container">
      <Card>
        <CardHeader>
          <div className="transactions-header-row">
            <div>
              <h2 className="section-title">Recovery transactions</h2>
              <p className="section-subtitle">
                Review payment recovery attempts, policy adjustments and execution outcomes.
              </p>
            </div>

            {/* Search filter input */}
            <div className="search-input-wrapper">
              <Search className="search-input-icon" size={15} />
              <input
                type="search"
                className="saas-input search-input"
                placeholder="Search transactions, actions or reasons…"
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
              />
              {filterText && (
                <button
                  type="button"
                  className="search-clear-btn"
                  onClick={() => setFilterText('')}
                  aria-label="Clear search"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Quick Filter Tabs */}
          <div className="filter-pill-bar">
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'ALL' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('ALL')}
            >
              All <span className="filter-pill-count">{filterCounts.ALL}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'RECOVERED' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('RECOVERED')}
            >
              Recovered <span className="filter-pill-count">{filterCounts.RECOVERED}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'OVERRIDDEN' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('OVERRIDDEN')}
            >
              Policy adjusted <span className="filter-pill-count">{filterCounts.OVERRIDDEN}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'TRAI_HOLD' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('TRAI_HOLD')}
            >
              Compliance hold <span className="filter-pill-count">{filterCounts.TRAI_HOLD}</span>
            </button>
            <button
              type="button"
              className={`filter-pill ${activeFilterPill === 'UNRECOVERABLE' ? 'active' : ''}`}
              onClick={() => setActiveFilterPill('UNRECOVERABLE')}
            >
              Stopped <span className="filter-pill-count">{filterCounts.UNRECOVERABLE}</span>
            </button>
          </div>
        </CardHeader>

        <CardContent>
          <div className="table-responsive">
            <table className="saas-table">
              <thead>
                <tr>
                  <th style={{ width: '85px' }}>Time</th>
                  <th style={{ width: '130px' }}>Transaction</th>
                  <th style={{ width: '110px' }}>Amount</th>
                  <th style={{ width: '150px' }}>Suggested action</th>
                  <th style={{ width: '150px' }}>Final action</th>
                  <th>Reason / Details</th>
                  <th style={{ width: '170px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length ? (
                  filteredLogs.map((log) => {
                    const signal = policySignal(log);
                    const isSelected = selectedLog?.id === log.id;
                    const isNew = newLogIds.has(log.id);

                    return (
                      <tr
                        key={log.id}
                        className={`table-row-clickable ${isNew ? 'row-highlight-new' : ''} ${
                          isSelected ? 'row-active' : ''
                        }`}
                        onClick={() => setSelectedLog(log)}
                        title="Click to view transaction details"
                      >
                        <td className="text-secondary text-sm">{formatTime(log.timestamp)}</td>
                        <td className="mono text-sm font-medium">••••{log.transactionId.slice(-8)}</td>
                        <td className="text-sm font-medium">
                          {log.amountPaise ? formatRupees(log.amountPaise) : '—'}
                        </td>
                        <td>
                          <span className="text-secondary text-sm">
                            {formatAction(log.aiRecommendedAction || log.action)}
                          </span>
                        </td>
                        <td>
                          <span className="font-medium text-sm text-primary">
                            {formatAction(log.action)}
                          </span>
                        </td>
                        <td className="text-secondary text-sm cell-reason">
                          <span className="reason-text">{log.reason}</span>
                          {signal && (
                            <span className="signal-pill">Policy adjusted</span>
                          )}
                        </td>
                        <td>
                          <Badge tone={resultTone(log.result)}>
                            {resultLabel(log.result)}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={7} className="table-empty-cell">
                      {loading ? 'Loading transactions…' : 'No transactions found matching criteria.'}
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

