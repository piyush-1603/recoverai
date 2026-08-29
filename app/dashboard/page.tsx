'use client';

import React, { useState, useEffect } from 'react';

type Stats = {
  totalTransactions: number;
  totalAtRiskPaise: number;
  totalRecoveredPaise: number;
  recoveryRate: number;
  recoveredCount: number;
  unrecoverableCount: number;
  pendingCount: number;
};

type AuditLog = {
  id: string;
  transactionId: string;
  eventId: string;
  actor: string;
  action: string;
  reason: string;
  result: string;
  timestamp: string;
};

type ExceptionItem = {
  id: string;
  externalPaymentId: string | null;
  amountPaise: number;
  source: string;
  type: string;
  reasonCode: string;
  createdAt: string;
};

function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [filterText, setFilterText] = useState('');

  const [triggering, setTriggering] = useState(false);
  const [triggerNotification, setTriggerNotification] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      const res = await fetch('/api/audit');
      if (res.ok) {
        const data = await res.json();
        setStats(data.stats);
        setAuditLogs(data.auditLogs || []);
        setExceptions(data.exceptions || []);
        setLastRefreshed(new Date());
      }
    } catch (err) {
      console.error('Failed to poll /api/audit:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleTriggerDemo = async () => {
    setTriggering(true);
    setTriggerNotification(null);
    try {
      const res = await fetch('/api/demo-trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const actionLabel = data.decision?.action?.toUpperCase() || 'EVENT';
        const linkUrl = data.result?.razorpayDetails?.shortUrl;
        setTriggerNotification(
          `⚡ Live Event Triggered: ${actionLabel} on #${data.transactionId?.slice(-8)} — "${data.decision?.reason}"` +
            (linkUrl ? ` • Razorpay Link Created: ${linkUrl}` : ''),
        );
        await fetchData();
      }
    } catch (err) {
      console.error('Trigger error:', err);
    } finally {
      setTriggering(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, []);

  const filteredLogs = auditLogs.filter((log) => {
    if (!filterText) return true;
    const q = filterText.toLowerCase();
    return (
      log.transactionId.toLowerCase().includes(q) ||
      log.actor.toLowerCase().includes(q) ||
      log.action.toLowerCase().includes(q) ||
      log.reason.toLowerCase().includes(q) ||
      log.result.toLowerCase().includes(q)
    );
  });

  const getActorBadgeStyle = (actor: string) => {
    switch (actor) {
      case 'webhook':
        return { bg: '#e0f2fe', text: '#0369a1', border: '#bae6fd' };
      case 'action_executor':
        return { bg: '#fef3c7', text: '#b45309', border: '#fde68a' };
      case 'policy_engine':
        return { bg: '#f3e8ff', text: '#7e22ce', border: '#e9d5ff' };
      case 'claude_agent':
        return { bg: '#ede9fe', text: '#6d28d9', border: '#ddd6fe' };
      default:
        return { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' };
    }
  };

  const getResultBadgeStyle = (result: string) => {
    if (result === 'recovered' || result === 'retry_succeeded' || result === 'nudge_led_to_recovery') {
      return { bg: '#dcfce7', text: '#15803d', border: '#bbf7d0' };
    }
    if (result === 'marked_unrecoverable' || result === 'payment_failed') {
      return { bg: '#fee2e2', text: '#b91c1c', border: '#fecaca' };
    }
    if (result === 'state_conflict_ignored') {
      return { bg: '#ffedd5', text: '#c2410c', border: '#fed7aa' };
    }
    return { bg: '#f8fafc', text: '#64748b', border: '#e2e8f0' };
  };

  return (
    <div style={{ minHeight: '100vh', background: '#090d16', color: '#f8fafc', fontFamily: 'system-ui, -apple-system, sans-serif', padding: '24px 32px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid #1e293b', paddingBottom: '20px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '24px' }}>⚡</span>
            <h1 style={{ fontSize: '24px', fontWeight: '700', letterSpacing: '-0.02em', margin: 0, color: '#ffffff' }}>
              RecoverAI Engine
            </h1>
            <span style={{ background: 'rgba(56, 189, 248, 0.12)', color: '#38bdf8', fontSize: '12px', fontWeight: '600', padding: '3px 10px', borderRadius: '999px', border: '1px solid rgba(56, 189, 248, 0.3)' }}>
              Live Audit Dashboard
            </span>
          </div>
          <p style={{ margin: '6px 0 0 36px', fontSize: '13px', color: '#94a3b8' }}>
            Deterministic Policy Rules • Live Razorpay Test Integration • Append-Only Audit Ledger
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: '#94a3b8', marginRight: '8px' }}>
            <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px #22c55e' }}></span>
            <span>Live Polling (3s)</span>
          </div>

          <button
            onClick={fetchData}
            style={{
              background: '#1e293b',
              color: '#f8fafc',
              border: '1px solid #334155',
              padding: '8px 14px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: '500',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            ↻ Refresh
          </button>

          {/* Trigger Live Demo Event Button */}
          <button
            id="trigger-live-demo-btn"
            onClick={handleTriggerDemo}
            disabled={triggering}
            style={{
              background: triggering
                ? '#4338ca'
                : 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
              color: '#ffffff',
              border: '1px solid #6366f1',
              padding: '8px 16px',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: '600',
              cursor: triggering ? 'not-allowed' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 2px 10px rgba(99, 102, 241, 0.35)',
              transition: 'all 0.15s ease',
            }}
          >
            <span>⚡</span>
            <span>{triggering ? 'Triggering Event...' : 'Trigger Live Demo Event'}</span>
          </button>
        </div>
      </div>

      {/* Live Notification Banner */}
      {triggerNotification && (
        <div
          style={{
            background: 'rgba(79, 70, 229, 0.15)',
            border: '1px solid rgba(99, 102, 241, 0.4)',
            borderRadius: '8px',
            padding: '12px 16px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '13px',
            color: '#c7d2fe',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '16px' }}>🚀</span>
            <span>{triggerNotification}</span>
          </div>
          <button
            onClick={() => setTriggerNotification(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#a5b4fc',
              cursor: 'pointer',
              fontSize: '14px',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '32px' }}>
        {/* Total At-Risk */}
        <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', padding: '20px' }}>
          <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94a3b8' }}>
            Total At-Risk Volume
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#f8fafc', marginTop: '8px' }}>
            {stats ? formatRupees(stats.totalAtRiskPaise) : '₹0.00'}
          </div>
          <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>
            {stats?.totalTransactions ?? 0} total transactions evaluated
          </div>
        </div>

        {/* Total Recovered */}
        <div style={{ background: '#0f172a', border: '1px solid #166534', borderRadius: '10px', padding: '20px' }}>
          <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#4ade80' }}>
            Total Recovered Revenue
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#4ade80', marginTop: '8px' }}>
            {stats ? formatRupees(stats.totalRecoveredPaise) : '₹0.00'}
          </div>
          <div style={{ fontSize: '12px', color: '#86efac', marginTop: '4px' }}>
            {stats?.recoveredCount ?? 0} successful recoveries
          </div>
        </div>

        {/* Recovery Rate */}
        <div style={{ background: '#0f172a', border: '1px solid #0369a1', borderRadius: '10px', padding: '20px' }}>
          <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#38bdf8' }}>
            Recovery Rate
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#38bdf8', marginTop: '8px' }}>
            {stats ? `${stats.recoveryRate}%` : '0.0%'}
          </div>
          <div style={{ fontSize: '12px', color: '#7dd3fc', marginTop: '4px' }}>
            Across all retry, nudge & approval rules
          </div>
        </div>

        {/* Unrecoverable Exceptions */}
        <div style={{ background: '#0f172a', border: '1px solid #991b1b', borderRadius: '10px', padding: '20px' }}>
          <div style={{ fontSize: '12px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em', color: '#f87171' }}>
            Honest Exceptions
          </div>
          <div style={{ fontSize: '28px', fontWeight: '700', color: '#f87171', marginTop: '8px' }}>
            {stats?.unrecoverableCount ?? 0}
          </div>
          <div style={{ fontSize: '12px', color: '#fca5a5', marginTop: '4px' }}>
            Marked stop_unrecoverable by policy
          </div>
        </div>
      </div>

      {/* Main Content Layout */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px' }}>
        {/* Left Column: Live Audit Log */}
        <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', padding: '20px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <div>
              <h2 style={{ fontSize: '16px', fontWeight: '600', color: '#ffffff', margin: 0 }}>
                Live Audit Log ({filteredLogs.length})
              </h2>
              <span style={{ fontSize: '12px', color: '#64748b' }}>Immutable append-only ledger entries</span>
            </div>
            <input
              type="text"
              placeholder="Search by ID, action, actor..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
              style={{
                background: '#1e293b',
                border: '1px solid #334155',
                color: '#f8fafc',
                padding: '6px 12px',
                borderRadius: '6px',
                fontSize: '12px',
                width: '220px',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ overflowX: 'auto', maxHeight: '560px', overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase' }}>
                  <th style={{ padding: '10px 12px' }}>Time</th>
                  <th style={{ padding: '10px 12px' }}>Tx ID</th>
                  <th style={{ padding: '10px 12px' }}>Actor</th>
                  <th style={{ padding: '10px 12px' }}>Action</th>
                  <th style={{ padding: '10px 12px' }}>Reason</th>
                  <th style={{ padding: '10px 12px' }}>Result</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#64748b' }}>
                      {loading ? 'Loading audit trail...' : 'No audit log entries found. Run npm run demo to generate traffic.'}
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((log) => {
                    const actorBadge = getActorBadgeStyle(log.actor);
                    const resultBadge = getResultBadgeStyle(log.result);
                    return (
                      <tr key={log.id} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '10px 12px', color: '#64748b', whiteSpace: 'nowrap', fontSize: '12px' }}>
                          {formatTime(log.timestamp)}
                        </td>
                        <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: '12px', color: '#38bdf8' }}>
                          {log.transactionId.slice(-8)}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <span
                            style={{
                              background: actorBadge.bg,
                              color: actorBadge.text,
                              border: `1px solid ${actorBadge.border}`,
                              fontSize: '11px',
                              fontWeight: '600',
                              padding: '2px 8px',
                              borderRadius: '4px',
                              textTransform: 'uppercase',
                            }}
                          >
                            {log.actor.replace(/_/g, ' ')}
                          </span>
                        </td>
                        <td style={{ padding: '10px 12px', fontWeight: '500', color: '#e2e8f0', whiteSpace: 'nowrap' }}>
                          {log.action}
                        </td>
                        <td style={{ padding: '10px 12px', color: '#94a3b8', fontSize: '12px', maxWidth: '240px' }}>
                          {log.reason}
                        </td>
                        <td style={{ padding: '10px 12px' }}>
                          <span
                            style={{
                              background: resultBadge.bg,
                              color: resultBadge.text,
                              border: `1px solid ${resultBadge.border}`,
                              fontSize: '11px',
                              fontWeight: '600',
                              padding: '2px 8px',
                              borderRadius: '4px',
                            }}
                          >
                            {log.result}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Exceptions Section */}
        <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '10px', padding: '20px', display: 'flex', flexDirection: 'column' }}>
          <div style={{ marginBottom: '16px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: '600', color: '#f87171', margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>🛑</span> Honest Exceptions List ({exceptions.length})
            </h2>
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              Transactions routed to stop_unrecoverable
            </span>
          </div>

          <div style={{ overflowY: 'auto', maxHeight: '560px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {exceptions.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
                No unrecoverable exceptions recorded.
              </div>
            ) : (
              exceptions.map((ex) => (
                <div
                  key={ex.id}
                  style={{
                    background: '#1e1b2e',
                    border: '1px solid #3b2d54',
                    borderRadius: '8px',
                    padding: '12px 14px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '12px', color: '#c084fc', fontWeight: '600' }}>
                      {ex.externalPaymentId || ex.id}
                    </span>
                    <span style={{ fontSize: '13px', fontWeight: '700', color: '#f87171' }}>
                      {formatRupees(ex.amountPaise)}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', marginTop: '6px', fontSize: '11px' }}>
                    <span style={{ background: '#374151', color: '#e5e7eb', padding: '1px 6px', borderRadius: '3px' }}>
                      {ex.type}
                    </span>
                    <span style={{ background: '#374151', color: '#e5e7eb', padding: '1px 6px', borderRadius: '3px' }}>
                      {ex.source}
                    </span>
                  </div>

                  <div style={{ fontSize: '12px', color: '#e2e8f0', marginTop: '6px' }}>
                    <strong>Reason Code:</strong> {ex.reasonCode || 'checkout_abandonment'}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
