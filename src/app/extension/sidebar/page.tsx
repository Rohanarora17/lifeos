'use client';

import { useState, useEffect, useCallback } from 'react';
import GuardianVoiceRoom from '@/components/GuardianVoiceRoom';

interface Task {
    id: number;
    title: string;
    priority: string;
}

interface Goal {
    id: number;
    title: string;
}

interface DashStats {
    score: number;
    productive_minutes: number;
    distraction_minutes: number;
    streak: number;
}

type ChromeRuntime = {
    sendMessage: (message: unknown) => void;
};

function getChromeRuntime(): ChromeRuntime | undefined {
    if (typeof window === 'undefined') return undefined;
    return (window as Window & typeof globalThis & { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
}

export default function ExtensionSidebar() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [goals, setGoals] = useState<Goal[]>([]);
    const [stats, setStats] = useState<DashStats | null>(null);

    // Focus session state
    const [focusActive, setFocusActive] = useState(false);
    const [focusTarget, setFocusTarget] = useState('');
    const [focusTargetLabel, setFocusTargetLabel] = useState('');
    const [focusDuration, setFocusDuration] = useState(60);
    const [timeLeft, setTimeLeft] = useState(0);
    const [blockedCount, setBlockedCount] = useState(0);
    const [overrideCount, setOverrideCount] = useState(0);
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

    const fetchContext = useCallback(async () => {
        try {
            const [sessionRes, dashRes] = await Promise.all([
                fetch('/api/extension/session'),
                fetch('/api/dashboard'),
            ]);
            const sessionData = await sessionRes.json();
            const dashData = await dashRes.json();

            if (sessionData.activeTasks) setTasks(sessionData.activeTasks);
            if (sessionData.activeGoals) setGoals(sessionData.activeGoals);
            if (sessionData.activeSession?.state === 'ACTIVE') {
                setActiveSessionId(sessionData.activeSession.sessionId);
                setFocusActive(true);
                setFocusTargetLabel(sessionData.activeSession.targetTitle || 'Focus Session');
                setFocusDuration(sessionData.activeSession.durationMinutes || 60);
            }
            if (dashData.today) {
                setStats({
                    score: dashData.today.score,
                    productive_minutes: dashData.today.productive_minutes || 0,
                    distraction_minutes: dashData.today.distraction_minutes || 0,
                    streak: dashData.today.streak || 0,
                });
            }
        } catch { }
    }, []);

    useEffect(() => {
        const bootstrapTimer = setTimeout(() => {
            void fetchContext();
        }, 0);
        const interval = setInterval(fetchContext, 30000);
        return () => {
            clearTimeout(bootstrapTimer);
            clearInterval(interval);
        };
    }, [fetchContext]);

    const endFocusSession = useCallback(async () => {
        setFocusActive(false);
        setTimeLeft(0);
        const sessionId = activeSessionId;
        setActiveSessionId(null);

        if (sessionId) {
            try {
                await fetch('/api/guardian/session/end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId }),
                });
            } catch { }
        }

        try {
            const chromeRuntime = getChromeRuntime();
            if (chromeRuntime) {
                chromeRuntime.sendMessage({ type: 'STOP_GUARDIAN' });
            } else if (window.parent !== window) {
                window.parent.postMessage({ type: 'STOP_GUARDIAN' }, '*');
            }
        } catch { }

        fetchContext();
    }, [activeSessionId, fetchContext]);

    // Focus timer countdown
    useEffect(() => {
        let tickTimer: ReturnType<typeof setInterval> | null = null;
        let completionTimer: ReturnType<typeof setTimeout> | null = null;
        if (focusActive && timeLeft > 0) {
            tickTimer = setInterval(() => setTimeLeft(prev => prev - 1), 1000);
        } else if (focusActive && timeLeft === 0) {
            completionTimer = setTimeout(() => {
                void endFocusSession();
            }, 0);
        }
        return () => {
            if (tickTimer) clearInterval(tickTimer);
            if (completionTimer) clearTimeout(completionTimer);
        };
    }, [endFocusSession, focusActive, timeLeft]);

    const startFocus = async () => {
        if (!focusTarget) return;

        let goalId = null, goalTitle = null, taskTitle = null;
        const selectedOption = document.querySelector<HTMLOptionElement>(`#sidebar-focus-target option[value="${focusTarget}"]`);
        const label = selectedOption?.textContent || '';

        if (focusTarget.startsWith('goal-')) {
            goalId = parseInt(focusTarget.replace('goal-', ''));
            goalTitle = label;
        } else if (focusTarget.startsWith('task-')) {
            taskTitle = label;
        }

        try {
            const res = await fetch('/api/guardian/session/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    goalId: goalId ? String(goalId) : null,
                    goalTitle,
                    conceptNodeName: taskTitle || goalTitle || label,
                    durationMinutes: focusDuration,
                    source: 'extension',
                }),
            });
            const data = await res.json();
            if (!data.session) return;

            setActiveSessionId(data.session.sessionId);
            setFocusTargetLabel(label);
            setTimeLeft(focusDuration * 60);
            setBlockedCount(0);
            setOverrideCount(0);
            setFocusActive(true);

            const chromeRuntime = getChromeRuntime();
            if (chromeRuntime) {
                chromeRuntime.sendMessage({
                    type: 'START_GUARDIAN',
                    context: data.session,
                });
            } else if (window.parent !== window) {
                window.parent.postMessage({ type: 'START_GUARDIAN', context: data.session }, '*');
            }
        } catch { }
    };

    const formatTimer = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    const formatTime = (mins: number) => {
        if (mins < 60) return `${Math.round(mins)}m`;
        return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
    };

    const markTaskDone = async (id: number) => {
        try {
            await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, action: 'done' })
            });
            fetchContext();
        } catch { }
    };

    return (
        <div style={{
            display: 'flex', flexDirection: 'column', height: '100vh',
            background: '#0a0a0f', color: '#f0f0f5', fontFamily: "'Inter', 'Segoe UI', sans-serif",
            fontSize: '13px', overflow: 'auto',
        }}>
            {/* Header */}
            <div style={{
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '18px' }}>⚡</span>
                    <div>
                        <div style={{ fontSize: '14px', fontWeight: 700 }}>LifeOS</div>
                        <div style={{ fontSize: '9px', opacity: 0.8 }}>Context Engine</div>
                    </div>
                </div>
                {stats && (
                    <div style={{
                        background: 'rgba(255,255,255,0.15)', backdropFilter: 'blur(10px)',
                        borderRadius: '16px', padding: '3px 10px',
                        fontSize: '12px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px',
                    }}>
                        {stats.streak > 0 ? '🔥' : '💤'} {stats.streak}
                    </div>
                )}
            </div>

            {/* Stats Strip */}
            {stats && (
                <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px',
                    padding: '8px 10px',
                }}>
                    {[
                        { val: stats.score, label: 'Score', color: '#a855f7' },
                        { val: formatTime(stats.productive_minutes), label: 'Productive', color: '#22c55e' },
                        { val: formatTime(stats.distraction_minutes), label: 'Distraction', color: '#ef4444' },
                    ].map((s, i) => (
                        <div key={i} style={{
                            background: '#1a1a2e', border: '1px solid #2a2a40', borderRadius: '8px',
                            padding: '6px', textAlign: 'center',
                        }}>
                            <div style={{ fontSize: '14px', fontWeight: 800, color: s.color }}>{s.val}</div>
                            <div style={{ fontSize: '9px', color: '#8888a0', marginTop: '1px' }}>{s.label}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Focus Session */}
            <div style={{ padding: '0 10px 8px' }}>
                <div style={{
                    background: focusActive
                        ? 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.08))'
                        : '#1a1a2e',
                    border: `1px solid ${focusActive ? 'rgba(59,130,246,0.5)' : '#2a2a40'}`,
                    borderRadius: '10px', padding: '10px',
                }}>
                    <div style={{
                        fontSize: '10px', color: '#8888a0', textTransform: 'uppercase' as const,
                        letterSpacing: '0.5px', marginBottom: '6px', fontWeight: 600,
                    }}>
                        🎯 {focusActive ? 'Focus Active' : 'Focus Session'}
                    </div>

                    {focusActive ? (
                        <>
                            <div style={{ textAlign: 'center', fontSize: '11px', color: '#8888a0' }}>
                                {focusTargetLabel}
                            </div>
                            <div style={{
                                fontSize: '32px', fontWeight: 900, textAlign: 'center',
                                color: '#3b82f6', fontVariantNumeric: 'tabular-nums',
                                margin: '4px 0', letterSpacing: '2px',
                            }}>
                                {formatTimer(timeLeft)}
                            </div>
                            <div style={{
                                display: 'flex', justifyContent: 'center', gap: '16px',
                                fontSize: '11px', marginBottom: '8px',
                            }}>
                                <div style={{ textAlign: 'center' }}>
                                    <div style={{ fontWeight: 700, fontSize: '14px', color: '#ef4444' }}>{blockedCount}</div>
                                    <div style={{ color: '#8888a0' }}>Blocked</div>
                                </div>
                                <div style={{ textAlign: 'center' }}>
                                    <div style={{ fontWeight: 700, fontSize: '14px', color: '#eab308' }}>{overrideCount}</div>
                                    <div style={{ color: '#8888a0' }}>Overrides</div>
                                </div>
                            </div>
                            <button
                                onClick={endFocusSession}
                                style={{
                                    width: '100%', padding: '7px', border: '1px solid rgba(239,68,68,0.3)',
                                    borderRadius: '8px', background: 'rgba(239,68,68,0.15)',
                                    color: '#ef4444', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                                }}
                            >
                                End Session
                            </button>
                            {activeSessionId ? (
                                <GuardianVoiceRoom
                                    sessionId={activeSessionId}
                                    targetTitle={focusTargetLabel || 'Focus Session'}
                                />
                            ) : null}
                        </>
                    ) : (
                        <>
                            <select
                                id="sidebar-focus-target"
                                value={focusTarget}
                                onChange={(e) => setFocusTarget(e.target.value)}
                                style={{
                                    width: '100%', padding: '7px', background: '#0a0a12', color: '#f0f0f5',
                                    border: '1px solid #2a2a40', borderRadius: '6px', fontSize: '12px',
                                    marginBottom: '6px', cursor: 'pointer',
                                }}
                            >
                                <option value="">Select a goal or task...</option>
                                {goals.length > 0 && (
                                    <optgroup label="Goals">
                                        {goals.map(g => (
                                            <option key={`g-${g.id}`} value={`goal-${g.id}`}>{g.title}</option>
                                        ))}
                                    </optgroup>
                                )}
                                {tasks.length > 0 && (
                                    <optgroup label="Active Tasks">
                                        {tasks.map(t => (
                                            <option key={`t-${t.id}`} value={`task-${t.id}`}>{t.title}</option>
                                        ))}
                                    </optgroup>
                                )}
                            </select>
                            <div style={{ display: 'flex', gap: '6px' }}>
                                <select
                                    value={focusDuration}
                                    onChange={(e) => setFocusDuration(parseInt(e.target.value))}
                                    style={{
                                        flex: 1, padding: '7px', background: '#0a0a12', color: '#f0f0f5',
                                        border: '1px solid #2a2a40', borderRadius: '6px', fontSize: '12px',
                                        cursor: 'pointer',
                                    }}
                                >
                                    <option value="25">25m</option>
                                    <option value="45">45m</option>
                                    <option value="60">60m</option>
                                    <option value="90">90m</option>
                                    <option value="120">2h</option>
                                </select>
                                <button
                                    onClick={startFocus}
                                    disabled={!focusTarget}
                                    style={{
                                        flex: 1, padding: '7px', border: 'none', borderRadius: '8px',
                                        background: focusTarget
                                            ? 'linear-gradient(135deg, #3b82f6, #8b5cf6)'
                                            : '#2a2a40',
                                        color: focusTarget ? 'white' : '#555570',
                                        fontSize: '12px', fontWeight: 600, cursor: focusTarget ? 'pointer' : 'default',
                                    }}
                                >
                                    Start Focus
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>

            {/* Divider */}
            <div style={{ borderTop: '1px solid #2a2a40', margin: '0 10px' }} />

            {/* Task Checklist */}
            <div style={{ padding: '8px 10px', flex: 1, overflowY: 'auto' }}>
                <div style={{
                    fontSize: '10px', color: '#8888a0', textTransform: 'uppercase' as const,
                    letterSpacing: '0.5px', marginBottom: '6px', fontWeight: 600,
                }}>
                    Today&apos;s Tasks
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {tasks.length === 0 ? (
                        <p style={{ fontSize: '11px', color: '#555570', textAlign: 'center', padding: '16px 0' }}>
                            No active tasks. Add some from the dashboard!
                        </p>
                    ) : (
                        tasks.map(t => (
                            <div key={t.id} style={{
                                display: 'flex', alignItems: 'center', gap: '8px',
                                padding: '7px 8px', borderRadius: '8px',
                                background: '#1a1a2e', border: '1px solid #2a2a40',
                                transition: 'border-color 0.15s',
                            }}>
                                <input
                                    type="checkbox"
                                    onChange={() => markTaskDone(t.id)}
                                    style={{
                                        width: '14px', height: '14px', borderRadius: '4px',
                                        cursor: 'pointer', accentColor: '#667eea', flexShrink: 0,
                                    }}
                                />
                                <span style={{
                                    fontSize: '12px', flex: 1, overflow: 'hidden',
                                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                                }}>
                                    {t.title}
                                </span>
                                {t.priority === 'critical' && (
                                    <span style={{ color: '#ef4444', fontSize: '8px' }}>●</span>
                                )}
                                {t.priority === 'high' && (
                                    <span style={{ color: '#f97316', fontSize: '8px' }}>●</span>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
