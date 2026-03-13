'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface FocusSession {
    id: number;
    goal_title: string | null;
    task_title: string | null;
    started_at: string | null;
    ended_at: string | null;
    duration_minutes: number;
    actual_duration_seconds: number;
    productive_seconds: number;
    distraction_seconds: number;
    neutral_seconds: number;
    tabs_opened: number;
    tabs_blocked: number;
    tabs_overridden: number;
    top_domains: string | null;
    ai_report: string | null;
    status: string;
    primary_domain: string | null;
}

function parseUtc(s: string | null): number {
    if (!s) return NaN;
    const normalized = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
    return new Date(normalized).getTime();
}

function formatDuration(secs: number): string {
    if (!secs) return '—';
    const m = Math.floor(secs / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatDate(s: string | null): string {
    if (!s) return '—';
    return new Date(parseUtc(s)).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
    });
}

function formatTime(s: string | null): string {
    if (!s) return '';
    return new Date(parseUtc(s)).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit',
    });
}

export default function FocusSessionsPage() {
    const [sessions, setSessions] = useState<FocusSession[]>([]);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState<number | null>(null);
    const [generating, setGenerating] = useState<number | null>(null);

    const generateReport = async (sessionId: number, e: React.MouseEvent) => {
        e.stopPropagation();
        setGenerating(sessionId);
        try {
            const res = await fetch('/api/focus-session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'generate-report', sessionId }),
            });
            const data = await res.json();
            if (data.success) {
                setSessions(prev => prev.map(s =>
                    s.id === sessionId ? { ...s, ai_report: data.report, status: s.status === 'active' ? 'completed' : s.status } : s
                ));
                setExpanded(sessionId);
            }
        } catch { }
        setGenerating(null);
    };

    useEffect(() => {
        fetch('/api/focus-session?limit=100')
            .then(r => r.json())
            .then(d => { setSessions(d.sessions || []); setLoading(false); })
            .catch(() => setLoading(false));
    }, []);

    const completed = sessions.filter(s => s.status === 'completed');
    const abandoned = sessions.filter(s => s.status === 'abandoned');
    const active = sessions.find(s => s.status === 'active');

    const totalFocusTime = completed.reduce((sum, s) =>
        sum + (s.actual_duration_seconds || s.duration_minutes * 60 || 0), 0);
    const totalProductive = completed.reduce((sum, s) => sum + (s.productive_seconds || 0), 0);

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-[60vh]">
                <p style={{ color: 'var(--text-secondary)' }}>Loading sessions...</p>
            </div>
        );
    }

    return (
        <div className="max-w-[900px] mx-auto space-y-6 animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold">🎯 Focus Sessions</h1>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>
                        {completed.length} completed · {formatDuration(totalFocusTime)} total focus time
                    </p>
                </div>
                <Link href="/" style={{
                    padding: '8px 16px', background: 'rgba(255,255,255,0.06)',
                    borderRadius: '8px', fontSize: '13px', color: 'var(--text-secondary)',
                    textDecoration: 'none', border: '1px solid rgba(255,255,255,0.08)',
                }}>← Dashboard</Link>
            </div>

            {/* Summary Stats */}
            {completed.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
                    {[
                        { label: 'Sessions', value: completed.length, icon: '🎯' },
                        { label: 'Total Focus', value: formatDuration(totalFocusTime), icon: '⏱️' },
                        { label: 'Productive', value: formatDuration(totalProductive), icon: '🟢' },
                        { label: 'Avg Session', value: formatDuration(Math.round(totalFocusTime / completed.length)), icon: '📊' },
                    ].map(stat => (
                        <div key={stat.label} className="card" style={{ padding: '16px', textAlign: 'center' }}>
                            <div style={{ fontSize: '24px', marginBottom: '4px' }}>{stat.icon}</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>{stat.value}</div>
                            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{stat.label}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Active session warning */}
            {active && (
                <div className="card" style={{ borderColor: 'var(--accent-purple)', background: 'rgba(157,78,221,0.05)', padding: '14px' }}>
                    <p style={{ fontSize: '14px', color: 'var(--accent-purple)', fontWeight: 600 }}>
                        🔄 Session in progress: {active.goal_title || active.task_title || 'Focus'} — started {formatTime(active.started_at)}
                    </p>
                </div>
            )}

            {/* Session List */}
            {completed.length === 0 && abandoned.length === 0 ? (
                <div className="card text-center" style={{ padding: '48px' }}>
                    <p style={{ fontSize: '48px', marginBottom: '12px' }}>🎯</p>
                    <p style={{ color: 'var(--text-secondary)' }}>No completed focus sessions yet.</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '4px' }}>
                        Start one from the dashboard to see your reports here.
                    </p>
                </div>
            ) : (
                <div className="space-y-3">
                    {sessions.filter(s => s.status !== 'active').map(session => {
                        const duration = session.actual_duration_seconds || session.duration_minutes * 60 || 0;
                        const totalSecs = (session.productive_seconds || 0) + (session.distraction_seconds || 0) + (session.neutral_seconds || 0);
                        const prodPct = totalSecs > 0 ? Math.round((session.productive_seconds / totalSecs) * 100) : 0;
                        const distPct = totalSecs > 0 ? Math.round((session.distraction_seconds / totalSecs) * 100) : 0;
                        const neutPct = totalSecs > 0 ? Math.round((session.neutral_seconds / totalSecs) * 100) : 0;
                        const topDomains: any[] = session.top_domains ? (() => { try { return JSON.parse(session.top_domains); } catch { return []; } })() : [];
                        const report: any = session.ai_report ? (() => { try { return JSON.parse(session.ai_report); } catch { return null; } })() : null;
                        const score = report?.score ?? null;
                        const isExpanded = expanded === session.id;
                        const title = session.task_title || session.goal_title || session.primary_domain || 'Focus Session';

                        return (
                            <div key={session.id} className="card" style={{ padding: '16px', cursor: 'pointer' }}
                                onClick={() => setExpanded(isExpanded ? null : session.id)}>

                                {/* Row 1: Title + Status + Score */}
                                <div className="flex items-center justify-between mb-3">
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div className="flex items-center gap-2">
                                            <span style={{
                                                width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
                                                background: session.status === 'completed' ? '#22c55e' : '#6b7280',
                                            }} />
                                            <p className="text-sm font-semibold truncate">{title}</p>
                                        </div>
                                        <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)', paddingLeft: '16px' }}>
                                            {formatDate(session.started_at)}
                                            {session.started_at && ` · ${formatTime(session.started_at)}`}
                                            {session.ended_at && ` → ${formatTime(session.ended_at)}`}
                                            {' · '}{formatDuration(duration)}
                                            {session.status === 'abandoned' && ' · ⏹ abandoned'}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3 flex-shrink-0 ml-3">
                                        {score !== null && (
                                            <span className="badge text-xs" style={{
                                                background: score >= 70 ? 'rgba(34,197,94,0.15)' : score >= 40 ? 'rgba(234,179,8,0.15)' : 'rgba(239,68,68,0.15)',
                                                color: score >= 70 ? '#22c55e' : score >= 40 ? '#eab308' : '#ef4444',
                                                padding: '3px 8px', borderRadius: '6px', fontWeight: 700,
                                            }}>{score}/100</span>
                                        )}
                                        {!session.ai_report && session.status !== 'active' && (
                                            <button
                                                onClick={(e) => generateReport(session.id, e)}
                                                disabled={generating === session.id}
                                                style={{
                                                    padding: '4px 10px', fontSize: '11px', fontWeight: 600,
                                                    background: 'rgba(157,78,221,0.15)', color: 'var(--accent-purple)',
                                                    border: '1px solid rgba(157,78,221,0.3)', borderRadius: '6px',
                                                    cursor: generating === session.id ? 'wait' : 'pointer',
                                                    whiteSpace: 'nowrap',
                                                }}
                                            >
                                                {generating === session.id ? '⏳ Generating...' : '✨ Generate Report'}
                                            </button>
                                        )}
                                        {session.ai_report && (
                                            <button
                                                onClick={(e) => generateReport(session.id, e)}
                                                disabled={generating === session.id}
                                                title="Regenerate report"
                                                style={{
                                                    padding: '4px 8px', fontSize: '11px',
                                                    background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)',
                                                    border: '1px solid rgba(255,255,255,0.08)', borderRadius: '6px',
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                {generating === session.id ? '⏳' : '🔄'}
                                            </button>
                                        )}
                                        <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{isExpanded ? '▲' : '▼'}</span>
                                    </div>
                                </div>

                                {/* Row 2: Time breakdown mini bar */}
                                {totalSecs > 0 ? (
                                    <div style={{ marginBottom: '8px' }}>
                                        <div style={{ display: 'flex', height: '6px', borderRadius: '3px', overflow: 'hidden', background: 'rgba(255,255,255,0.05)', marginBottom: '4px' }}>
                                            {prodPct > 0 && <div style={{ width: `${prodPct}%`, background: '#22c55e' }} />}
                                            {neutPct > 0 && <div style={{ width: `${neutPct}%`, background: '#eab308' }} />}
                                            {distPct > 0 && <div style={{ width: `${distPct}%`, background: '#ef4444' }} />}
                                        </div>
                                        <div className="flex gap-3" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                                            <span>🟢 {formatDuration(session.productive_seconds)} productive</span>
                                            <span>🟡 {formatDuration(session.neutral_seconds)} neutral</span>
                                            <span>🔴 {formatDuration(session.distraction_seconds)} distracted</span>
                                            {session.tabs_blocked > 0 && <span>🛑 {session.tabs_blocked} blocked</span>}
                                            {session.tabs_overridden > 0 && <span>⚠️ {session.tabs_overridden} overrides</span>}
                                        </div>
                                    </div>
                                ) : (
                                    <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                                        No detailed breakdown available (auto-detected session)
                                    </p>
                                )}

                                {/* Top domains row */}
                                {topDomains.length > 0 && (
                                    <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                        🌐 {topDomains.slice(0, 5).map((d: any) => {
                                            const name = typeof d === 'string' ? d : d.domain;
                                            const mins = typeof d === 'object' ? Math.round((d.seconds || 0) / 60) : 0;
                                            return mins > 0 ? `${name} (${mins}m)` : name;
                                        }).join(' · ')}
                                    </p>
                                )}

                                {/* Expanded: Full AI Report */}
                                {isExpanded && (
                                    <div style={{ marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '16px' }}>
                                        {report ? (
                                            <div className="space-y-3">
                                                {/* Score + verdict */}
                                                {report.verdict && (
                                                    <div style={{ padding: '12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', borderLeft: '3px solid var(--accent-purple)' }}>
                                                        <p style={{ fontSize: '14px', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
                                                            "{report.verdict}"
                                                        </p>
                                                    </div>
                                                )}

                                                {/* Stats grid */}
                                                {(report.focusQuality || report.distractionLevel || report.recommendation) && (
                                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                                                        {report.focusQuality && (
                                                            <div style={{ padding: '10px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                                                                <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>FOCUS QUALITY</p>
                                                                <p style={{ fontSize: '13px', fontWeight: 600 }}>{report.focusQuality}</p>
                                                            </div>
                                                        )}
                                                        {report.distractionLevel && (
                                                            <div style={{ padding: '10px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px' }}>
                                                                <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>DISTRACTION LEVEL</p>
                                                                <p style={{ fontSize: '13px', fontWeight: 600 }}>{report.distractionLevel}</p>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}

                                                {/* Highlights */}
                                                {report.highlights?.length > 0 && (
                                                    <div>
                                                        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 600 }}>HIGHLIGHTS</p>
                                                        {report.highlights.map((h: string, i: number) => (
                                                            <p key={i} style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '4px' }}>• {h}</p>
                                                        ))}
                                                    </div>
                                                )}

                                                {/* Recommendation */}
                                                {report.recommendation && (
                                                    <div style={{ padding: '12px', background: 'rgba(34,197,94,0.05)', borderRadius: '8px', border: '1px solid rgba(34,197,94,0.15)' }}>
                                                        <p style={{ fontSize: '11px', color: '#22c55e', marginBottom: '4px', fontWeight: 600 }}>💡 RECOMMENDATION</p>
                                                        <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{report.recommendation}</p>
                                                    </div>
                                                )}

                                                {/* Raw JSON fallback if schema differs */}
                                                {!report.verdict && !report.highlights && !report.recommendation && (
                                                    <pre style={{ fontSize: '11px', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', overflowX: 'hidden' }}>
                                                        {JSON.stringify(report, null, 2)}
                                                    </pre>
                                                )}
                                            </div>
                                        ) : session.ai_report ? (
                                            <div className="space-y-3">
                                                <div style={{ padding: '16px', background: 'rgba(255,255,255,0.02)', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                                    <pre style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0, lineHeight: 1.5 }}>
                                                        {session.ai_report}
                                                    </pre>
                                                </div>
                                            </div>
                                        ) : (
                                            <div style={{ textAlign: 'center', padding: '16px' }}>
                                                <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
                                                    No AI report yet for this session.
                                                </p>
                                                <button
                                                    onClick={(e) => generateReport(session.id, e)}
                                                    disabled={generating === session.id}
                                                    style={{
                                                        padding: '8px 20px', fontWeight: 600, fontSize: '13px',
                                                        background: 'linear-gradient(135deg, #9d4edd, #667eea)',
                                                        border: 'none', borderRadius: '8px', color: 'white',
                                                        cursor: generating === session.id ? 'wait' : 'pointer',
                                                    }}
                                                >
                                                    {generating === session.id ? '⏳ Generating report...' : '✨ Generate AI Report'}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
