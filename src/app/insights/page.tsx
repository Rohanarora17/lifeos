'use client';

import { useState, useEffect, useCallback } from 'react';

// ── Types ──
interface FocusScoreData {
    score: number;
    deepMinutes: number;
    flowMinutes: number;
    fragmentedMinutes: number;
    totalSwitches: number;
    contextSwitchCost: number;
    focusRatio: number;
}

interface EntropyData {
    entropy: number;
    normalizedEntropy: number;
    uniqueDomains: number;
    switchesPerHour: number;
    rapidBursts: number;
    classification: string;
    topSwitchPairs: { from: string; to: string; count: number }[];
}

interface ConsistencyData {
    overallScore: number;
    dimensions: {
        work: { score: number; cv: number; trend: string; data: number[] };
        habits: { score: number; rate: number; streakCurrent: number; streakLongest: number };
        tasks: { score: number; completionRate: number; avgPerDay: number };
        focus: { score: number; avgDeepMinutes: number; cv: number };
        timing: { score: number; avgStartHour: number; cv: number };
    };
    streakDays: number;
    trend: string;
    weekOverWeek: number;
}

interface ArchetypeData {
    primary: string;
    description: string;
    chronotype: string;
    workStyle: string;
    consistencyType: string;
    focusProfile: string;
    strengths: string[];
    challenges: string[];
}

interface GoalData {
    id: number;
    title: string;
    type: string;
    metric: string;
    targetValue: number;
    currentValue: number;
    unit: string;
    progress: number;
    onTrack: boolean;
    trend: string;
}

interface InsightData {
    id: number;
    category: string;
    insight: string;
    actionable_tip: string;
    severity: string;
    feedback: string | null;
    created_at: string;
}

interface FocusSession {
    startTime: string;
    endTime: string;
    durationMinutes: number;
    focusType: string;
    primaryDomain: string;
    tabSwitches: number;
    contextSwitches: number;
    flowStateDetected: boolean;
}

interface FullAnalysis {
    profile: Record<string, unknown>;
    focusScore: FocusScoreData;
    entropy: EntropyData;
    consistency: ConsistencyData;
    archetype: ArchetypeData;
    goalAlignment: { goals: GoalData[]; alignmentScore: number };
    hourly: { h: number; productive: number; distraction: number; total: number }[];
    dayOfWeek: { day_name: string; hours: number }[];
    topProductive: { domain: string; mins: number }[];
    topDistraction: { domain: string; mins: number }[];
    insights: InsightData[];
    sessions: FocusSession[];
}

// ── Goal Metrics ──
const GOAL_METRICS = [
    { value: 'productive_minutes', label: 'Productive Minutes' },
    { value: 'deep_work_minutes', label: 'Deep Work Minutes' },
    { value: 'tasks_completed', label: 'Tasks Completed' },
    { value: 'habits_completed', label: 'Habits Completed' },
    { value: 'distraction_minutes', label: 'Distraction Minutes (max)' },
    { value: 'github_commits', label: 'GitHub Commits' },
];

export default function InsightsPage() {
    const [data, setData] = useState<FullAnalysis | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'overview' | 'focus' | 'consistency' | 'goals' | 'insights'>('overview');
    const [showGoalForm, setShowGoalForm] = useState(false);
    const [newGoal, setNewGoal] = useState({ title: '', type: 'daily', metric: 'productive_minutes', target_value: '', unit: 'minutes' });

    const loadData = useCallback(async () => {
        try {
            const res = await fetch('/api/behavior?action=full');
            const d = await res.json();
            setData(d);
        } catch (e) { console.error(e); }
        setIsLoading(false);
    }, []);

    useEffect(() => { loadData(); }, [loadData]);

    const runAnalysis = async () => {
        setIsAnalyzing(true);
        try {
            await fetch('/api/behavior', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            await loadData();
        } catch (e) { console.error(e); }
        setIsAnalyzing(false);
    };

    const addGoal = async () => {
        if (!newGoal.title || !newGoal.target_value) return;
        await fetch('/api/goals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...newGoal, target_value: parseFloat(newGoal.target_value) }),
        });
        setShowGoalForm(false);
        setNewGoal({ title: '', type: 'daily', metric: 'productive_minutes', target_value: '', unit: 'minutes' });
        await loadData();
    };

    const deleteGoal = async (id: number) => {
        await fetch(`/api/goals?id=${id}`, { method: 'DELETE' });
        await loadData();
    };

    const sendFeedback = async (insightId: number, feedback: 'helpful' | 'not_helpful') => {
        await fetch('/api/behavior', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'insight_feedback', insight_id: insightId, feedback }),
        });
        await loadData();
    };

    if (isLoading) return (
        <div style={{ padding: 32, display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
            <div style={{ textAlign: 'center', color: '#8888a0' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🧠</div>
                <div>Loading behavioral data...</div>
            </div>
        </div>
    );

    const { focusScore, entropy, consistency, archetype, goalAlignment, insights, sessions } = data || {} as Partial<FullAnalysis>;
    const profile = data?.profile || {};
    const hourly = data?.hourly || [];
    const maxH = Math.max(...hourly.map(h => h.total || 0), 1);

    // ── Severity Helpers ──
    const sCol = (s: string) => s === 'positive' ? '#22c55e' : s === 'warning' ? '#eab308' : s === 'critical' ? '#ef4444' : '#3b82f6';
    const sIcon = (s: string) => s === 'positive' ? '✅' : s === 'warning' ? '⚠️' : s === 'critical' ? '🚨' : '💡';

    return (
        <div style={{ padding: 32, maxWidth: 1200, margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <div>
                    <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>🧠 Behavioral Intelligence</h1>
                    <p style={{ color: '#8888a0', marginTop: 4 }}>Advanced focus, consistency, and goal tracking with AI learning</p>
                </div>
                <button onClick={runAnalysis} disabled={isAnalyzing}
                    style={{ padding: '10px 20px', background: isAnalyzing ? '#333' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none', borderRadius: 10, color: 'white', fontWeight: 600, cursor: isAnalyzing ? 'wait' : 'pointer', fontSize: 14 }}>
                    {isAnalyzing ? '🔄 Analyzing...' : '⚡ Run Deep Analysis'}
                </button>
            </div>

            {/* Tab Navigation */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 24, background: '#12121a', borderRadius: 12, padding: 4 }}>
                {(['overview', 'focus', 'consistency', 'goals', 'insights'] as const).map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                        style={{
                            flex: 1, padding: '10px 16px', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
                            background: activeTab === tab ? 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' : 'transparent',
                            color: activeTab === tab ? '#fff' : '#8888a0'
                        }}>
                        {tab === 'overview' ? '🔬 Overview' : tab === 'focus' ? '🎯 Focus' : tab === 'consistency' ? '📊 Consistency' : tab === 'goals' ? '🎯 Goals' : '💡 Insights'}
                    </button>
                ))}
            </div>

            {/* ═══════════════════════════════════════════════ */}
            {/* OVERVIEW TAB */}
            {/* ═══════════════════════════════════════════════ */}
            {activeTab === 'overview' && (
                <>
                    {/* Archetype Card */}
                    <div className="card" style={{ padding: 24, marginBottom: 24, borderLeft: '4px solid #667eea' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                            <span style={{ fontSize: 36 }}>{archetype?.chronotype === 'early-bird' ? '🌅' : archetype?.chronotype === 'night-owl' ? '🦉' : '☀️'}</span>
                            <div>
                                <h2 style={{ margin: 0, fontWeight: 800, fontSize: 22 }}>{archetype?.primary || 'Uncategorized'}</h2>
                                <span style={{ fontSize: 12, color: '#667eea', fontWeight: 600 }}>
                                    {archetype?.chronotype} · {archetype?.workStyle} · {archetype?.consistencyType} · {archetype?.focusProfile}
                                </span>
                            </div>
                        </div>
                        <p style={{ color: '#c0c0d0', lineHeight: 1.7, margin: 0 }}>{profile.personality_summary as string || archetype?.description || 'Run Deep Analysis to build your behavioral profile.'}</p>

                        {archetype && (archetype.strengths.length > 0 || archetype.challenges.length > 0) && (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
                                {archetype.strengths.length > 0 && (
                                    <div style={{ padding: 12, background: 'rgba(34,197,94,0.06)', borderRadius: 8, borderLeft: '3px solid #22c55e' }}>
                                        <div style={{ fontSize: 11, color: '#22c55e', fontWeight: 700, marginBottom: 6 }}>💪 STRENGTHS</div>
                                        {archetype.strengths.map((s, i) => <div key={i} style={{ fontSize: 12, color: '#c0c0d0', marginBottom: 4 }}>• {s}</div>)}
                                    </div>
                                )}
                                {archetype.challenges.length > 0 && (
                                    <div style={{ padding: 12, background: 'rgba(239,68,68,0.06)', borderRadius: 8, borderLeft: '3px solid #ef4444' }}>
                                        <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 700, marginBottom: 6 }}>⚡ CHALLENGES</div>
                                        {archetype.challenges.map((c, i) => <div key={i} style={{ fontSize: 12, color: '#c0c0d0', marginBottom: 4 }}>• {c}</div>)}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* 4-Metric Summary */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
                        <ScoreCard label="Focus Depth" value={focusScore?.score ?? 0} max={100} color="#667eea" icon="🎯"
                            sub={`${focusScore?.deepMinutes || 0}m deep · ${focusScore?.flowMinutes || 0}m flow`} />
                        <ScoreCard label="Attention" value={100 - Math.round((entropy?.normalizedEntropy || 0) * 100)} max={100}
                            color={entropy?.classification === 'chaotic' ? '#ef4444' : entropy?.classification === 'scattered' ? '#eab308' : '#22c55e'}
                            icon={entropy?.classification === 'laser-focused' ? '🔬' : entropy?.classification === 'focused' ? '🎯' : '🌊'}
                            sub={`${entropy?.classification || '—'} · ${entropy?.switchesPerHour || 0}/hr switches`} />
                        <ScoreCard label="Consistency" value={consistency?.overallScore ?? 0} max={100} color="#a855f7" icon="📊"
                            sub={`${consistency?.streakDays || 0}-day streak · ${consistency?.trend || 'stable'}`} />
                        <ScoreCard label="Goal Alignment" value={goalAlignment?.alignmentScore ?? 50} max={100}
                            color={goalAlignment?.alignmentScore && goalAlignment.alignmentScore >= 80 ? '#22c55e' : '#eab308'} icon="🎯"
                            sub={`${goalAlignment?.goals?.length || 0} active goals`} />
                    </div>

                    {/* Hourly Productivity Heatmap */}
                    <div className="card" style={{ padding: 20, marginBottom: 24 }}>
                        <h3 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 16 }}>🕐 Hourly Attention Map (30 days)</h3>
                        <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 100 }}>
                            {Array.from({ length: 24 }, (_, h) => {
                                const d = hourly.find(x => x.h === h) || { productive: 0, distraction: 0, total: 0 };
                                const height = maxH > 0 ? (d.total / maxH) * 90 : 0;
                                const ratio = d.total > 0 ? d.productive / d.total : 0;
                                return (
                                    <div key={h} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                                        <div style={{
                                            width: '80%', height: `${height}%`, minHeight: d.total > 0 ? 3 : 1,
                                            background: d.total === 0 ? '#1a1a2e' : ratio > 0.6 ? '#22c55e' : ratio > 0.3 ? '#eab308' : '#ef4444',
                                            borderRadius: '3px 3px 0 0', transition: 'height 0.3s ease', opacity: 0.85
                                        }}
                                            title={`${h}:00 — ${d.productive}m prod · ${d.distraction}m dist`} />
                                        {h % 3 === 0 && <span style={{ fontSize: 9, color: '#8888a0' }}>{h}</span>}
                                    </div>
                                );
                            })}
                        </div>
                        <div style={{ display: 'flex', gap: 16, marginTop: 10, justifyContent: 'center', fontSize: 11, color: '#8888a0' }}>
                            <span>🟢 Productive</span><span>🟡 Mixed</span><span>🔴 Distraction</span>
                        </div>
                    </div>

                    {/* Top domains side-by-side */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                        <DomainList title="🟢 Top Productive" domains={data?.topProductive || []} color="#22c55e" />
                        <DomainList title="🔴 Top Distractions" domains={data?.topDistraction || []} color="#ef4444" />
                    </div>
                </>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* FOCUS TAB */}
            {/* ═══════════════════════════════════════════════ */}
            {activeTab === 'focus' && (
                <>
                    {/* Focus Score Ring */}
                    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 24, marginBottom: 24 }}>
                        <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                            <div style={{ position: 'relative', width: 160, height: 160, marginBottom: 12 }}>
                                <svg viewBox="0 0 100 100" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)' }}>
                                    <circle cx="50" cy="50" r="42" fill="none" stroke="#1a1a2e" strokeWidth="8" />
                                    <circle cx="50" cy="50" r="42" fill="none" stroke="#667eea" strokeWidth="8"
                                        strokeDasharray={`${(focusScore?.score || 0) * 2.64} 264`}
                                        strokeLinecap="round" style={{ transition: 'stroke-dasharray 1s ease' }} />
                                </svg>
                                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                                    <span style={{ fontSize: 36, fontWeight: 800 }}>{focusScore?.score || 0}</span>
                                    <span style={{ fontSize: 11, color: '#8888a0' }}>Focus Score</span>
                                </div>
                            </div>
                            <div style={{ fontSize: 12, color: '#8888a0' }}>Focus ratio: {Math.round((focusScore?.focusRatio || 0) * 100)}%</div>
                        </div>

                        <div className="card" style={{ padding: 20 }}>
                            <h3 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 16 }}>📊 Focus Breakdown</h3>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <MetricBox label="Deep Work" value={`${focusScore?.deepMinutes || 0}m`} color="#667eea" icon="🧠" />
                                <MetricBox label="Flow State" value={`${focusScore?.flowMinutes || 0}m`} color="#22c55e" icon="⚡" />
                                <MetricBox label="Fragmented" value={`${focusScore?.fragmentedMinutes || 0}m`} color="#ef4444" icon="💔" />
                                <MetricBox label="Context Switch Cost" value={`${focusScore?.contextSwitchCost || 0}m lost`} color="#eab308" icon="🔄" />
                            </div>

                            {/* Entropy */}
                            <div style={{ marginTop: 16, padding: 12, background: '#12121a', borderRadius: 8 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: 13, fontWeight: 600 }}>Attention Entropy</span>
                                    <span style={{
                                        fontSize: 12, fontWeight: 700,
                                        color: entropy?.classification === 'laser-focused' ? '#22c55e' : entropy?.classification === 'focused' ? '#3b82f6' : entropy?.classification === 'chaotic' ? '#ef4444' : '#eab308'
                                    }}>
                                        {entropy?.classification?.toUpperCase() || '—'}
                                    </span>
                                </div>
                                <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: '#8888a0' }}>
                                    <span>📐 H={entropy?.entropy || 0}</span>
                                    <span>🌐 {entropy?.uniqueDomains || 0} sites</span>
                                    <span>🔄 {entropy?.switchesPerHour || 0}/hr</span>
                                    <span>⚡ {entropy?.rapidBursts || 0} rapid bursts</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Today's Focus Sessions */}
                    <div className="card" style={{ padding: 20, marginBottom: 24 }}>
                        <h3 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 16 }}>🕐 Today&apos;s Focus Sessions</h3>
                        {sessions && sessions.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {sessions.map((s, i) => (
                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', background: '#12121a', borderRadius: 8 }}>
                                        <span style={{ fontSize: 20 }}>
                                            {s.focusType === 'deep' ? '🧠' : s.focusType === 'moderate' ? '📘' : s.focusType === 'fragmented' ? '💔' : '📄'}
                                        </span>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontWeight: 600, fontSize: 13 }}>{s.primaryDomain || 'Mixed'}</div>
                                            <div style={{ fontSize: 11, color: '#8888a0' }}>
                                                {new Date(s.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — {new Date(s.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                        </div>
                                        <span style={{ fontSize: 14, fontWeight: 700 }}>{s.durationMinutes}m</span>
                                        <span style={{
                                            fontSize: 10, padding: '2px 8px', borderRadius: 6, fontWeight: 600,
                                            background: s.focusType === 'deep' ? '#667eea22' : s.focusType === 'moderate' ? '#3b82f622' : s.focusType === 'fragmented' ? '#ef444422' : '#8888a022',
                                            color: s.focusType === 'deep' ? '#667eea' : s.focusType === 'moderate' ? '#3b82f6' : s.focusType === 'fragmented' ? '#ef4444' : '#8888a0'
                                        }}>
                                            {s.focusType.toUpperCase()}
                                        </span>
                                        {s.flowStateDetected && <span title="Flow state detected!">🌊</span>}
                                        <span style={{ fontSize: 10, color: '#8888a0' }}>{s.tabSwitches} sw</span>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{ textAlign: 'center', padding: 24, color: '#8888a0' }}>No sessions detected yet today</div>
                        )}
                    </div>

                    {/* Top Switch Pairs */}
                    {entropy?.topSwitchPairs && entropy.topSwitchPairs.length > 0 && (
                        <div className="card" style={{ padding: 20 }}>
                            <h3 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 16 }}>🔄 Most Common Tab Switches</h3>
                            {entropy.topSwitchPairs.map((p, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: i < entropy.topSwitchPairs.length - 1 ? '1px solid #1a1a2e' : 'none', fontSize: 13 }}>
                                    <span style={{ color: '#8888a0' }}>{p.from}</span>
                                    <span style={{ color: '#667eea' }}>→</span>
                                    <span>{p.to}</span>
                                    <span style={{ marginLeft: 'auto', fontWeight: 700, color: '#eab308' }}>{p.count}×</span>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* CONSISTENCY TAB */}
            {/* ═══════════════════════════════════════════════ */}
            {activeTab === 'consistency' && consistency && (
                <>
                    {/* Overall + Streak */}
                    <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 24, marginBottom: 24 }}>
                        <div className="card" style={{ padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                            <div style={{ fontSize: 48, fontWeight: 800, color: consistency.overallScore >= 70 ? '#22c55e' : consistency.overallScore >= 40 ? '#eab308' : '#ef4444' }}>
                                {consistency.overallScore}
                            </div>
                            <div style={{ fontSize: 12, color: '#8888a0', marginTop: 2 }}>Consistency Index /100</div>
                            <div style={{ fontSize: 13, marginTop: 8 }}>
                                {consistency.trend === 'improving' ? '📈' : consistency.trend === 'declining' ? '📉' : '➡️'} {consistency.trend}
                            </div>
                            <div style={{ fontSize: 11, color: '#8888a0', marginTop: 4 }}>
                                {consistency.weekOverWeek > 0 ? `+${consistency.weekOverWeek}%` : `${consistency.weekOverWeek}%`} week over week
                            </div>
                        </div>

                        {/* 5-Dimension Spider (as bars) */}
                        <div className="card" style={{ padding: 20 }}>
                            <h3 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 16 }}>📊 5-Dimension Consistency</h3>
                            {Object.entries(consistency.dimensions).map(([key, dim]) => (
                                <div key={key} style={{ marginBottom: 12 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                        <span style={{ fontSize: 12, textTransform: 'capitalize' }}>
                                            {key === 'work' ? '💼 Work' : key === 'habits' ? '🔥 Habits' : key === 'tasks' ? '📋 Tasks' : key === 'focus' ? '🎯 Focus' : '⏰ Timing'}
                                        </span>
                                        <span style={{ fontSize: 12, fontWeight: 700, color: dim.score >= 70 ? '#22c55e' : dim.score >= 40 ? '#eab308' : '#ef4444' }}>
                                            {dim.score}/100
                                        </span>
                                    </div>
                                    <div style={{ height: 6, background: '#12121a', borderRadius: 3, overflow: 'hidden' }}>
                                        <div style={{
                                            width: `${dim.score}%`, height: '100%', borderRadius: 3, transition: 'width 0.5s ease',
                                            background: dim.score >= 70 ? '#22c55e' : dim.score >= 40 ? '#eab308' : '#ef4444'
                                        }} />
                                    </div>
                                    <div style={{ fontSize: 10, color: '#8888a0', marginTop: 2 }}>
                                        {key === 'work' && `CV: ${Math.round((dim as ConsistencyData['dimensions']['work']).cv * 100) / 100} · trend: ${(dim as ConsistencyData['dimensions']['work']).trend}`}
                                        {key === 'habits' && `${Math.round((dim as ConsistencyData['dimensions']['habits']).rate * 100)}% rate · ${(dim as ConsistencyData['dimensions']['habits']).streakCurrent}d streak (best: ${(dim as ConsistencyData['dimensions']['habits']).streakLongest}d)`}
                                        {key === 'tasks' && `${Math.round((dim as ConsistencyData['dimensions']['tasks']).completionRate * 100)}% completion · ${(dim as ConsistencyData['dimensions']['tasks']).avgPerDay}/day avg`}
                                        {key === 'focus' && `${(dim as ConsistencyData['dimensions']['focus']).avgDeepMinutes}m avg deep work · CV: ${Math.round((dim as ConsistencyData['dimensions']['focus']).cv * 100) / 100}`}
                                        {key === 'timing' && `avg start: ${Math.floor((dim as ConsistencyData['dimensions']['timing']).avgStartHour)}:${String(Math.round(((dim as ConsistencyData['dimensions']['timing']).avgStartHour % 1) * 60)).padStart(2, '0')} · CV: ${Math.round((dim as ConsistencyData['dimensions']['timing']).cv * 100) / 100}`}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* 30-day Sparkline */}
                    {consistency.dimensions.work.data.length > 0 && (
                        <div className="card" style={{ padding: 20, marginBottom: 24 }}>
                            <h3 style={{ margin: '0 0 4px', fontWeight: 700, fontSize: 16 }}>📈 Daily Productive Minutes (30 days)</h3>
                            <p style={{ fontSize: 11, color: '#8888a0', margin: '0 0 16px' }}>Lower variance = higher consistency score</p>
                            <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 80 }}>
                                {consistency.dimensions.work.data.map((v, i) => {
                                    const max = Math.max(...consistency.dimensions.work.data, 1);
                                    return (
                                        <div key={i} style={{
                                            flex: 1, height: `${(v / max) * 100}%`, minHeight: v > 0 ? 3 : 1,
                                            background: v > 0 ? '#667eea' : '#1a1a2e', borderRadius: '2px 2px 0 0', opacity: 0.8
                                        }}
                                            title={`${v} min`} />
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Streak + Day of Week */}
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
                            <div style={{ fontSize: 48, marginBottom: 8 }}>{consistency.streakDays > 0 ? '🔥' : '💤'}</div>
                            <div style={{ fontSize: 40, fontWeight: 800 }}>{consistency.streakDays}</div>
                            <div style={{ fontSize: 13, color: '#8888a0' }}>Day Active Streak</div>
                        </div>
                        <div className="card" style={{ padding: 20 }}>
                            <h3 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 16 }}>📅 Productivity by Day</h3>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 80 }}>
                                {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(day => {
                                    const d = data?.dayOfWeek?.find(x => x.day_name === day);
                                    const maxDay = Math.max(...(data?.dayOfWeek?.map(x => x.hours) || [1]), 1);
                                    return (
                                        <div key={day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                                            <div style={{
                                                width: '70%', height: `${((d?.hours || 0) / maxDay) * 70}%`, minHeight: (d?.hours || 0) > 0 ? 3 : 1,
                                                background: '#667eea', borderRadius: '3px 3px 0 0'
                                            }} />
                                            <span style={{ fontSize: 9, color: '#8888a0' }}>{day.slice(0, 2)}</span>
                                            <span style={{ fontSize: 9, color: '#8888a0' }}>{Math.round((d?.hours || 0) * 10) / 10}h</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* GOALS TAB */}
            {/* ═══════════════════════════════════════════════ */}
            {activeTab === 'goals' && (
                <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                        <h2 style={{ margin: 0, fontWeight: 700, fontSize: 20 }}>🎯 Goal Alignment — {goalAlignment?.alignmentScore || 0}%</h2>
                        <button onClick={() => setShowGoalForm(!showGoalForm)}
                            style={{ padding: '8px 16px', background: '#667eea', border: 'none', borderRadius: 8, color: 'white', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                            + Add Goal
                        </button>
                    </div>

                    {/* Goal Form */}
                    {showGoalForm && (
                        <div className="card" style={{ padding: 20, marginBottom: 20 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 1fr 120px 80px', gap: 12, alignItems: 'end' }}>
                                <div>
                                    <label style={{ fontSize: 11, color: '#8888a0', display: 'block', marginBottom: 4 }}>Goal Name</label>
                                    <input value={newGoal.title} onChange={e => setNewGoal({ ...newGoal, title: e.target.value })}
                                        placeholder="e.g., 4 hours deep work" className="input"
                                        style={{ width: '100%', padding: 8, background: '#12121a', border: '1px solid #2a2a40', borderRadius: 6, color: '#f0f0f5', fontSize: 13 }} />
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, color: '#8888a0', display: 'block', marginBottom: 4 }}>Period</label>
                                    <select value={newGoal.type} onChange={e => setNewGoal({ ...newGoal, type: e.target.value })}
                                        style={{ width: '100%', padding: 8, background: '#12121a', border: '1px solid #2a2a40', borderRadius: 6, color: '#f0f0f5', fontSize: 13 }}>
                                        <option value="daily">Daily</option>
                                        <option value="weekly">Weekly</option>
                                        <option value="monthly">Monthly</option>
                                    </select>
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, color: '#8888a0', display: 'block', marginBottom: 4 }}>Metric</label>
                                    <select value={newGoal.metric} onChange={e => setNewGoal({ ...newGoal, metric: e.target.value })}
                                        style={{ width: '100%', padding: 8, background: '#12121a', border: '1px solid #2a2a40', borderRadius: 6, color: '#f0f0f5', fontSize: 13 }}>
                                        {GOAL_METRICS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label style={{ fontSize: 11, color: '#8888a0', display: 'block', marginBottom: 4 }}>Target</label>
                                    <input type="number" value={newGoal.target_value} onChange={e => setNewGoal({ ...newGoal, target_value: e.target.value })}
                                        placeholder="240" style={{ width: '100%', padding: 8, background: '#12121a', border: '1px solid #2a2a40', borderRadius: 6, color: '#f0f0f5', fontSize: 13 }} />
                                </div>
                                <button onClick={addGoal}
                                    style={{ padding: 8, background: '#22c55e', border: 'none', borderRadius: 6, color: 'white', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>
                                    Save
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Goal Cards */}
                    {goalAlignment?.goals && goalAlignment.goals.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {goalAlignment.goals.map(goal => (
                                <div key={goal.id} className="card" style={{ padding: 16 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                                        <span style={{ fontSize: 20 }}>{goal.onTrack ? '✅' : goal.progress >= 0.5 ? '🔶' : '🔴'}</span>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontWeight: 600 }}>{goal.title}</div>
                                            <div style={{ fontSize: 11, color: '#8888a0' }}>{goal.type} · {GOAL_METRICS.find(m => m.value === goal.metric)?.label || goal.metric}</div>
                                        </div>
                                        <span style={{ fontSize: 18, fontWeight: 800, color: goal.onTrack ? '#22c55e' : '#eab308' }}>
                                            {Math.round(goal.progress * 100)}%
                                        </span>
                                        <button onClick={() => deleteGoal(goal.id)}
                                            style={{ background: 'none', border: 'none', color: '#555570', cursor: 'pointer', fontSize: 16 }}>×</button>
                                    </div>
                                    <div style={{ height: 6, background: '#12121a', borderRadius: 3, overflow: 'hidden', marginBottom: 4 }}>
                                        <div style={{
                                            width: `${Math.min(goal.progress * 100, 100)}%`, height: '100%', borderRadius: 3,
                                            background: goal.onTrack ? '#22c55e' : goal.progress >= 0.5 ? '#eab308' : '#ef4444',
                                            transition: 'width 0.5s ease'
                                        }} />
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#8888a0' }}>
                                        <span>{goal.currentValue} / {goal.targetValue} {goal.unit}</span>
                                        <span>{goal.trend === 'improving' ? '📈 Improving' : goal.trend === 'declining' ? '📉 Declining' : '➡️ Stable'}</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#8888a0' }}>
                            <div style={{ fontSize: 48, marginBottom: 12 }}>🎯</div>
                            <h3 style={{ margin: '0 0 8px' }}>No Goals Set</h3>
                            <p>Define your targets — &ldquo;4 hours of deep work daily&rdquo;, &ldquo;3 tasks/day&rdquo;, etc. The AI will track your alignment automatically.</p>
                        </div>
                    )}
                </>
            )}

            {/* ═══════════════════════════════════════════════ */}
            {/* INSIGHTS TAB */}
            {/* ═══════════════════════════════════════════════ */}
            {activeTab === 'insights' && (
                <>
                    <h2 style={{ margin: '0 0 8px', fontWeight: 700, fontSize: 20 }}>💡 AI Behavioral Insights</h2>
                    <p style={{ color: '#8888a0', fontSize: 12, marginTop: 0, marginBottom: 20 }}>Rate insights to help the AI learn what&apos;s useful — it adapts based on your feedback.</p>
                    {insights && insights.length > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {insights.map(ins => (
                                <div key={ins.id} style={{ padding: '14px 16px', background: '#12121a', borderRadius: 10, borderLeft: `3px solid ${sCol(ins.severity)}` }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                                        <span>{sIcon(ins.severity)}</span>
                                        <span style={{
                                            fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5,
                                            color: sCol(ins.severity), background: `${sCol(ins.severity)}15`, padding: '2px 8px', borderRadius: 4
                                        }}>
                                            {ins.category}
                                        </span>
                                        <span style={{ fontSize: 10, color: '#555570', marginLeft: 'auto' }}>
                                            {new Date(ins.created_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                    <p style={{ margin: '0 0 6px', color: '#e0e0f0', fontSize: 14 }}>{ins.insight}</p>
                                    {ins.actionable_tip && <p style={{ margin: '0 0 8px', color: '#8888a0', fontSize: 12 }}>💡 {ins.actionable_tip}</p>}
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                        {ins.feedback ? (
                                            <span style={{ fontSize: 11, color: ins.feedback === 'helpful' ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
                                                {ins.feedback === 'helpful' ? '👍 Helpful' : '👎 Not helpful'}
                                            </span>
                                        ) : (
                                            <>
                                                <button onClick={() => sendFeedback(ins.id, 'helpful')}
                                                    style={{ padding: '3px 10px', fontSize: 11, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 4, color: '#22c55e', cursor: 'pointer' }}>
                                                    👍 Helpful
                                                </button>
                                                <button onClick={() => sendFeedback(ins.id, 'not_helpful')}
                                                    style={{ padding: '3px 10px', fontSize: 11, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: 4, color: '#ef4444', cursor: 'pointer' }}>
                                                    👎 Not useful
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="card" style={{ padding: 32, textAlign: 'center', color: '#8888a0' }}>
                            <div style={{ fontSize: 48, marginBottom: 12 }}>💡</div>
                            <h3 style={{ margin: '0 0 8px' }}>No Insights Yet</h3>
                            <p>Click &ldquo;Run Deep Analysis&rdquo; to generate AI-powered behavioral insights based on your data.</p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

// ── Sub-components ──

function ScoreCard({ label, value, max, color, icon, sub }: { label: string; value: number; max: number; color: string; icon: string; sub: string }) {
    return (
        <div className="card" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: '#8888a0', marginBottom: 4 }}>{icon} {label}</div>
            <div style={{ fontSize: 32, fontWeight: 800, color }}>{value}<span style={{ fontSize: 14, color: '#555570' }}>/{max}</span></div>
            <div style={{ fontSize: 10, color: '#8888a0', marginTop: 2 }}>{sub}</div>
        </div>
    );
}

function MetricBox({ label, value, color, icon }: { label: string; value: string; color: string; icon: string }) {
    return (
        <div style={{ padding: 12, background: '#12121a', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <div>
                <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
                <div style={{ fontSize: 10, color: '#8888a0' }}>{label}</div>
            </div>
        </div>
    );
}

function DomainList({ title, domains, color }: { title: string; domains: { domain: string; mins: number }[]; color: string }) {
    return (
        <div className="card" style={{ padding: 20 }}>
            <h3 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 16, color }}>{title}</h3>
            {domains.length > 0 ? domains.slice(0, 8).map((d, i) => (
                <div key={d.domain} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: i < Math.min(domains.length, 8) - 1 ? '1px solid #1a1a2e' : 'none' }}>
                    <span style={{ fontSize: 12, color: '#8888a0', width: 20 }}>#{i + 1}</span>
                    <span style={{ flex: 1, fontSize: 13 }}>{d.domain}</span>
                    <span style={{ fontSize: 12, color, fontWeight: 600 }}>{d.mins}m</span>
                </div>
            )) : <div style={{ color: '#8888a0', fontSize: 13 }}>No data yet</div>}
        </div>
    );
}
