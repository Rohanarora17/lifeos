'use client';

// Must be first — polyfills crypto.randomUUID for HTTP (non-secure) contexts
import '@/lib/polyfill-crypto-uuid';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { useGuardianSession } from '@/hooks/useGuardianSession';
import { scoreBadgeBg, scoreBadgeBorder, scoreBadgeText } from '@/lib/score-classify';

// Lazy-load livekit-client only after polyfill is in place and component mounts
const GuardianVoiceRoom = dynamic(() => import('@/components/GuardianVoiceRoom'), {
    ssr: false,
    loading: () => null,
});

interface Task {
    id: number;
    title: string;
    goal_id?: number | null;
    priority: string;
    time_progress?: {
        targetMinutes: number | null;
        creditedMinutes: number;
        remainingMinutes: number | null;
        percent: number | null;
        linkedSessions: number;
    };
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

interface InsightsData {
    session: null | {
        topic: string;
        elapsed: number;
        remaining: number;
        focusScore: number;
        state: string;
    };
    profile: {
        coachingInsights: string[];
        nextBestFocusWindow: string | null;
        focusTrend: string;
        preferredCoachingStyle: string | null;
    };
    habits: { completionRate: number | null };
    personalization?: {
        mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
        guidance: string;
        recommendedSessionMinutes: number;
        energy: 'high' | 'medium' | 'low';
        mood: 'high' | 'medium' | 'low' | null;
        standupGoal: string | null;
        alertFatigueLevel: 'low' | 'medium' | 'high';
        recentAlerts: number;
        nextBestFocusWindow: string;
        plannedFocus?: {
            plannedToday: number;
            completedToday: number;
            skippedToday: number;
            nextTitle: string | null;
            nextMinutes: number | null;
            recentFollowThroughRate: number | null;
        };
    };
    recommendedTasks?: Array<{
        id: number;
        title: string;
        priority: string;
        score: number;
        reason: string;
        momentFit: 'high' | 'medium' | 'low';
        estimatedMinutes: number | null;
        energyRequired: 'low' | 'medium' | 'high' | null;
    }>;
}

const modeLabel: Record<NonNullable<InsightsData['personalization']>['mode'], string> = {
    protect_focus: 'Protect focus',
    deadline_pressure: 'Deadline pressure',
    recovery: 'Recovery',
    planning: 'Planning',
    normal: 'Balanced',
};

function formatDuration(mins: number) {
    const rounded = Math.max(0, Math.round(mins));
    if (rounded < 60) return `${rounded}m`;
    const hours = Math.floor(rounded / 60);
    const minutes = rounded % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

interface DurationOption {
    minutes: number;
    label: string;
}

type RecommendedTask = NonNullable<InsightsData['recommendedTasks']>[number];

function addDurationOption(options: DurationOption[], minutes: number | null | undefined, label: string) {
    if (!minutes || minutes <= 0) return;
    const rounded = Math.max(5, Math.round(minutes / 5) * 5);
    if (options.some(option => option.minutes === rounded)) return;
    options.push({ minutes: rounded, label });
}

function formatPlannedFocusLabel(plannedFocus: NonNullable<InsightsData['personalization']>['plannedFocus']) {
    if (!plannedFocus?.nextTitle) return null;
    return `${plannedFocus.nextTitle}${plannedFocus.nextMinutes ? ` · ${formatDuration(plannedFocus.nextMinutes)}` : ''}`;
}

function buildDurationOptions(input: {
    adaptiveDuration: number;
    personalization?: InsightsData['personalization'];
    selectedTask?: RecommendedTask | null;
    topTask?: RecommendedTask | null;
}): DurationOption[] {
    const options: DurationOption[] = [];
    const mode = input.personalization?.mode ?? 'normal';
    const base = Math.round(input.adaptiveDuration);
    const selectedEstimate = input.selectedTask?.estimatedMinutes ?? null;
    const topEstimate = input.topTask?.estimatedMinutes ?? null;
    const plannedMinutes = input.personalization?.plannedFocus?.nextMinutes ?? null;

    addDurationOption(options, selectedEstimate, 'This task');
    addDurationOption(options, plannedMinutes, 'Next planned');
    addDurationOption(options, base, mode === 'recovery' ? 'Recovery default' : mode === 'deadline_pressure' ? 'Pressure default' : 'Today default');

    if (mode === 'recovery' || input.personalization?.energy === 'low' || input.personalization?.mood === 'low') {
        addDurationOption(options, Math.min(base, 20), 'Small start');
        addDurationOption(options, Math.min(Math.max(base, 25), 35), 'Manageable');
    } else if (mode === 'deadline_pressure') {
        addDurationOption(options, Math.max(base, 45), 'Serious sprint');
        addDurationOption(options, Math.max(base, 75), 'Deep push');
    } else if (mode === 'planning') {
        addDurationOption(options, Math.min(base, 30), 'Planning pass');
        addDurationOption(options, Math.max(base, 45), 'Setup block');
    } else {
        addDurationOption(options, Math.max(25, base - 15), 'Shorter');
        addDurationOption(options, Math.min(120, base + 15), 'Deeper');
    }

    addDurationOption(options, topEstimate, 'Top recommendation');
    return options.slice(0, 5);
}

function buildFocusTargetPrompt(insights: InsightsData | null): string {
    const personalization = insights?.personalization;
    if (personalization?.plannedFocus?.nextTitle) return `Next planned: ${personalization.plannedFocus.nextTitle}`;
    if (personalization?.mode === 'recovery' || personalization?.energy === 'low' || personalization?.mood === 'low') {
        return 'Choose a small, finishable target...';
    }
    if (personalization?.mode === 'deadline_pressure') return 'Choose the deadline-relief target...';
    if (personalization?.mode === 'planning') return 'Choose a planning or setup target...';
    if (insights?.recommendedTasks?.[0]) return `Recommended: ${insights.recommendedTasks[0].title}`;
    return 'Select a goal or task...';
}

function buildNoSidebarTasksMessage(insights: InsightsData | null): string {
    const personalization = insights?.personalization;
    if (personalization?.plannedFocus?.plannedToday) {
        return `No active tasks here. You still have ${personalization.plannedFocus.plannedToday - personalization.plannedFocus.completedToday} planned focus block(s) to protect.`;
    }
    if (personalization?.mode === 'planning') return 'No active tasks here. Add tomorrow targets from the planner.';
    if (personalization?.mode === 'recovery' || personalization?.energy === 'low' || personalization?.mood === 'low') {
        return 'No active tasks here. Keep today light or add one small recovery-safe task.';
    }
    return 'No active tasks here. Add the next concrete time target from the dashboard.';
}

function buildTaskTimeTargetHint(task: Task, insights: InsightsData | null): string {
    const personalization = insights?.personalization;
    if (personalization?.plannedFocus?.nextTitle && task.title.toLowerCase().includes(personalization.plannedFocus.nextTitle.toLowerCase())) {
        return 'Matches the next planned focus block.';
    }
    if (personalization?.mode === 'recovery' || personalization?.energy === 'low' || personalization?.mood === 'low') {
        return 'Start a smaller session to create today’s time target.';
    }
    if (personalization?.mode === 'deadline_pressure') {
        return 'Start now to turn pressure into credited minutes.';
    }
    return 'Start a session to set the time target.';
}

export default function ExtensionSidebar() {
    const { session, adaptiveDefaults, start: startGuardianSession, end: endGuardianSession } = useGuardianSession();
    const [tasks, setTasks] = useState<Task[]>([]);
    const [goals, setGoals] = useState<Goal[]>([]);
    const [stats, setStats] = useState<DashStats | null>(null);
    const [insights, setInsights] = useState<InsightsData | null>(null);
    const [focusTarget, setFocusTarget] = useState('');
    const topRecommendedTask = insights?.recommendedTasks?.[0] ?? null;
    const selectedRecommendedTask = focusTarget.startsWith('task-')
        ? insights?.recommendedTasks?.find(task => task.id === Number(focusTarget.replace('task-', ''))) ?? null
        : null;
    const [focusDuration, setFocusDuration] = useState<number | null>(null);
    const plannedFocus = insights?.personalization?.plannedFocus;
    const plannedFocusLabel = formatPlannedFocusLabel(plannedFocus);
    const adaptiveDuration = plannedFocus?.nextMinutes
        ?? insights?.personalization?.recommendedSessionMinutes
        ?? topRecommendedTask?.estimatedMinutes
        ?? adaptiveDefaults.recommendedSessionMinutes;
    const effectiveFocusDuration = focusDuration ?? (adaptiveDuration ? Math.round(adaptiveDuration) : null);
    const durationOptions = buildDurationOptions({
        adaptiveDuration,
        personalization: insights?.personalization,
        selectedTask: selectedRecommendedTask,
        topTask: topRecommendedTask,
    });

    // Notify extension background when session state changes
    useEffect(() => {
        const rt = getChromeRuntime();
        if (!rt) return;
        if (session.active) {
            rt.sendMessage({ type: 'START_GUARDIAN', context: { sessionId: session.sessionId, targetTitle: session.targetTitle, durationMinutes: session.durationMinutes, startedAt: session.startedAt } });
        } else {
            rt.sendMessage({ type: 'STOP_GUARDIAN' });
        }
    }, [session.active, session.sessionId, session.targetTitle, session.durationMinutes, session.startedAt]);

    // Poll tasks/goals/stats (separate from session — handled by hook)
    const fetchContext = useCallback(async () => {
        try {
            const [contextRes, dashRes, insightsRes] = await Promise.all([
                fetch('/api/guardian/state'),
                fetch('/api/dashboard'),
                fetch('/api/guardian/insights'),
            ]);
            const contextData = await contextRes.json();
            const dashData = await dashRes.json();
            const insightsData = await insightsRes.json();
            if (contextData.activeTasks) setTasks(contextData.activeTasks);
            if (contextData.activeGoals) setGoals(contextData.activeGoals);
            if (dashData.today) {
                setStats({
                    score: dashData.today.score,
                    productive_minutes: dashData.today.productive_minutes || 0,
                    distraction_minutes: dashData.today.distraction_minutes || 0,
                    streak: dashData.today.streak || 0,
                });
            }
            if (!insightsData.error) {
                const nextInsights = insightsData as InsightsData;
                setInsights(nextInsights);
                if (!session.active) {
                    const recommended = nextInsights.personalization?.plannedFocus?.nextMinutes
                        ?? nextInsights.personalization?.recommendedSessionMinutes
                        ?? adaptiveDefaults.recommendedSessionMinutes;
                    setFocusDuration(prev => prev ?? Math.round(recommended));
                }
            }
        } catch { }
    }, [session.active, adaptiveDefaults.recommendedSessionMinutes]);

    useEffect(() => {
        const initial = setTimeout(fetchContext, 0);
        const interval = setInterval(fetchContext, 30_000); // tasks/stats refresh slower
        return () => {
            clearTimeout(initial);
            clearInterval(interval);
        };
    }, [fetchContext]);

    // Auto-end when timer hits zero
    useEffect(() => {
        if (session.active && session.timeLeftSeconds === 0) {
            endGuardianSession();
        }
    }, [session.active, session.timeLeftSeconds, endGuardianSession]);

    const endFocusSession = useCallback(async () => {
        await endGuardianSession();
        // Parent window fallback (iframe context)
        if (window.parent !== window) {
            window.parent.postMessage({ type: 'STOP_GUARDIAN' }, '*');
        }
    }, [endGuardianSession]);

    const startFocus = async () => {
        if (!focusTarget || !effectiveFocusDuration) return;
        const selectedOption = document.querySelector<HTMLOptionElement>(`#sidebar-focus-target option[value="${focusTarget}"]`);
        const label = selectedOption?.textContent || '';
        let goalId = null, goalTitle = null, taskTitle = null, taskId: number | null = null;
        if (focusTarget.startsWith('goal-')) {
            goalId = parseInt(focusTarget.replace('goal-', ''));
            goalTitle = label;
        } else if (focusTarget.startsWith('task-')) {
            taskId = parseInt(focusTarget.replace('task-', ''));
            taskTitle = label;
        }
        const sessionId = await startGuardianSession({
            goalId: goalId ? String(goalId) : null,
            goalTitle,
            conceptNodeName: taskTitle || goalTitle || label,
            durationMinutes: effectiveFocusDuration,
            source: 'extension',
        });
        if (sessionId && window.parent !== window) {
            window.parent.postMessage({ type: 'START_GUARDIAN', context: { sessionId, targetTitle: label, durationMinutes: effectiveFocusDuration } }, '*');
        }
        if (sessionId && taskId) {
            sendRecommendationFeedback(taskId, 'started', 'started from extension sidebar');
        }
    };

    const formatTimer = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };

    const formatTime = (mins: number) => {
        return formatDuration(mins);
    };

    const startTaskTimeSession = async (task: Task) => {
        const remaining = task.time_progress?.remainingMinutes;
        const duration = Math.max(5, Math.round(
            remaining && remaining > 0
                ? Math.min(remaining, effectiveFocusDuration ?? remaining)
                : effectiveFocusDuration ?? adaptiveDefaults.recommendedSessionMinutes
        ));
        const sessionId = await startGuardianSession({
            goalId: task.goal_id ? String(task.goal_id) : null,
            goalTitle: null,
            conceptNodeName: task.title,
            durationMinutes: duration,
            source: 'extension',
        });
        if (sessionId && window.parent !== window) {
            window.parent.postMessage({ type: 'START_GUARDIAN', context: { sessionId, targetTitle: task.title, durationMinutes: duration } }, '*');
        }
        if (sessionId) {
            sendRecommendationFeedback(task.id, 'started', 'started task time session from extension sidebar');
            fetchContext();
        }
    };

    const sendRecommendationFeedback = async (
        taskId: number,
        feedback: 'helpful' | 'not_now' | 'wrong' | 'started' | 'completed' | 'dismissed',
        reason?: string,
    ) => {
        await fetch('/api/dashboard/recommendation-feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, feedback, reason, surface: 'extension_sidebar' }),
        }).catch(() => { });
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

            {insights?.personalization && (
                <div style={{ padding: '0 10px 8px' }}>
                    <div style={{
                        background: 'linear-gradient(135deg, rgba(102,126,234,0.1), rgba(34,197,94,0.04))',
                        border: '1px solid rgba(102,126,234,0.25)',
                        borderRadius: '10px',
                        padding: '10px',
                    }}>
                        <div style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            gap: '8px', marginBottom: '6px',
                        }}>
                            <div style={{ fontSize: '10px', color: '#a5b4fc', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>
                                {modeLabel[insights.personalization.mode]}
                            </div>
                            <div style={{ fontSize: '10px', color: '#8888a0' }}>
                                {insights.personalization.energy} energy · {adaptiveDuration ? formatDuration(adaptiveDuration) : 'learning length'}
                            </div>
                        </div>
                        <div style={{ fontSize: '11px', color: '#c8c8df', lineHeight: 1.4 }}>
                            {insights.personalization.guidance}
                        </div>
                        {topRecommendedTask && (
                            <div style={{
                                marginTop: '8px',
                                paddingTop: '8px',
                                borderTop: '1px solid rgba(255,255,255,0.06)',
                            }}>
                                <div style={{ fontSize: '10px', color: '#8888a0', marginBottom: '3px' }}>Best next task</div>
                                <div style={{ fontSize: '12px', color: '#f0f0f5', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {topRecommendedTask.title}
                                </div>
                                <div style={{ fontSize: '10px', color: '#8888a0', marginTop: '3px', lineHeight: 1.35 }}>
                                    {topRecommendedTask.reason}
                                </div>
                                <div style={{ display: 'flex', gap: '6px', marginTop: '7px' }}>
                                    <button
                                        onClick={() => {
                                            setFocusTarget(`task-${topRecommendedTask.id}`);
                                            setFocusDuration(adaptiveDuration);
                                            sendRecommendationFeedback(topRecommendedTask.id, 'helpful', 'accepted top extension recommendation');
                                        }}
                                        style={{
                                            flex: 1, padding: '5px 7px', borderRadius: '6px',
                                            border: '1px solid rgba(34,197,94,0.2)', background: 'rgba(34,197,94,0.1)',
                                            color: '#22c55e', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                                        }}
                                    >
                                        Use this
                                    </button>
                                    <button
                                        onClick={() => {
                                            sendRecommendationFeedback(topRecommendedTask.id, 'not_now', 'rejected top extension recommendation');
                                            setInsights(prev => prev ? {
                                                ...prev,
                                                recommendedTasks: prev.recommendedTasks?.filter(t => t.id !== topRecommendedTask.id),
                                            } : prev);
                                        }}
                                        style={{
                                            flex: 1, padding: '5px 7px', borderRadius: '6px',
                                            border: '1px solid rgba(245,158,11,0.2)', background: 'rgba(245,158,11,0.08)',
                                            color: '#f59e0b', fontSize: '10px', fontWeight: 700, cursor: 'pointer',
                                        }}
                                    >
                                        Not now
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Focus Session */}
            <div style={{ padding: '0 10px 8px' }}>
                <div style={{
                    background: session.active
                        ? 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(139,92,246,0.08))'
                        : '#1a1a2e',
                    border: `1px solid ${session.active ? 'rgba(59,130,246,0.5)' : '#2a2a40'}`,
                    borderRadius: '10px', padding: '10px',
                }}>
                    <div style={{
                        fontSize: '10px', color: '#8888a0', textTransform: 'uppercase' as const,
                        letterSpacing: '0.5px', marginBottom: '6px', fontWeight: 600,
                    }}>
                        🎯 {session.active ? 'Guardian Active' : 'Start Session'}
                    </div>

                    {session.active ? (
                        <>
                            <div style={{ textAlign: 'center', fontSize: '11px', color: '#8888a0' }}>
                                {session.targetTitle}
                            </div>
                            <div style={{
                                fontSize: '32px', fontWeight: 900, textAlign: 'center',
                                color: '#3b82f6', fontVariantNumeric: 'tabular-nums',
                                margin: '4px 0', letterSpacing: '2px',
                            }}>
                                {formatTimer(session.timeLeftSeconds)}
                            </div>
                            {session.focusScore !== null && (
                                <div style={{ textAlign: 'center', fontSize: '11px', color: '#8888a0', marginBottom: '8px' }}>
                                    Focus Score: <strong style={{ color: '#3b82f6' }}>{Math.round(session.focusScore)}</strong>
                                </div>
                            )}
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
                            {session.sessionId ? (
                                <GuardianVoiceRoom
                                    sessionId={session.sessionId}
                                    targetTitle={session.targetTitle ?? 'Focus Session'}
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
                                <option value="">{buildFocusTargetPrompt(insights)}</option>
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
                                    value={effectiveFocusDuration ?? ''}
                                    onChange={(e) => setFocusDuration(parseInt(e.target.value, 10))}
                                    style={{
                                        flex: 1, padding: '7px', background: '#0a0a12', color: '#f0f0f5',
                                        border: '1px solid #2a2a40', borderRadius: '6px', fontSize: '12px',
                                        cursor: 'pointer',
                                    }}
                                >
                                    {!effectiveFocusDuration && (
                                        <option value="" disabled>Loading adaptive length</option>
                                    )}
                                    {durationOptions.map(m => (
                                        <option key={`${m.minutes}-${m.label}`} value={m.minutes}>
                                            {m.label} ({formatDuration(m.minutes)})
                                        </option>
                                    ))}
                                </select>
                                <button
                                    onClick={startFocus}
                                    disabled={!focusTarget || !effectiveFocusDuration}
                                    style={{
                                        flex: 1, padding: '7px', border: 'none', borderRadius: '8px',
                                        background: focusTarget && effectiveFocusDuration
                                            ? 'linear-gradient(135deg, #3b82f6, #8b5cf6)'
                                            : '#2a2a40',
                                        color: focusTarget && effectiveFocusDuration ? 'white' : '#555570',
                                        fontSize: '12px', fontWeight: 600, cursor: focusTarget && effectiveFocusDuration ? 'pointer' : 'default',
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

            {/* UIL Coaching Card */}
            {insights && (insights.profile.coachingInsights.length > 0 || insights.profile.nextBestFocusWindow || plannedFocusLabel || insights.habits.completionRate !== null) && (
                <div style={{ padding: '8px 10px' }}>
                    <div style={{
                        background: 'linear-gradient(135deg, rgba(245,158,11,0.06), rgba(234,179,8,0.04))',
                        border: '1px solid rgba(245,158,11,0.2)',
                        borderRadius: '10px', padding: '10px',
                    }}>
                        <div style={{
                            fontSize: '10px', color: '#a07830', textTransform: 'uppercase' as const,
                            letterSpacing: '0.5px', marginBottom: '6px', fontWeight: 600,
                        }}>
                            Intelligence
                        </div>

                        {/* Top coaching insight */}
                        {insights.profile.coachingInsights[0] && (
                            <div style={{
                                fontSize: '11px', color: '#e0c070', lineHeight: '1.4',
                                marginBottom: insights.profile.nextBestFocusWindow || insights.habits.completionRate !== null ? '6px' : '0',
                            }}>
                                {insights.profile.coachingInsights[0]}
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' as const }}>
                            {plannedFocusLabel && (
                                <div style={{
                                    background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)',
                                    borderRadius: '6px', padding: '3px 7px', fontSize: '10px', color: '#93c5fd',
                                }}>
                                    Planned: {plannedFocusLabel}
                                </div>
                            )}
                            {/* Next best focus window — only when no session */}
                            {!session.active && insights.profile.nextBestFocusWindow && (
                                <div style={{
                                    background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.2)',
                                    borderRadius: '6px', padding: '3px 7px', fontSize: '10px', color: '#f59e0b',
                                }}>
                                    Best window: {insights.profile.nextBestFocusWindow}
                                </div>
                            )}
                            {/* Habit completion badge */}
                            {insights.habits.completionRate !== null && (
                                <div style={{
                                    background: scoreBadgeBg(insights.habits.completionRate),
                                    border: `1px solid ${scoreBadgeBorder(insights.habits.completionRate)}`,
                                    borderRadius: '6px', padding: '3px 7px', fontSize: '10px',
                                    color: scoreBadgeText(insights.habits.completionRate),
                                }}>
                                    Habits {insights.habits.completionRate}%
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

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
                            {buildNoSidebarTasksMessage(insights)}
                        </p>
                    ) : (
                        tasks.map(t => (
                            <div key={t.id} style={{
                                display: 'flex', alignItems: 'center', gap: '8px',
                                padding: '7px 8px', borderRadius: '8px',
                                background: '#1a1a2e', border: '1px solid #2a2a40',
                                transition: 'border-color 0.15s',
                            }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '6px',
                                    }}>
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
                                    {t.time_progress?.targetMinutes ? (
                                        <div style={{ marginTop: '5px' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#8888a0' }}>
                                                <span>{t.time_progress.creditedMinutes}/{t.time_progress.targetMinutes}m</span>
                                                <span>{t.time_progress.remainingMinutes ?? 0}m left</span>
                                            </div>
                                            <div style={{ height: '3px', borderRadius: '999px', overflow: 'hidden', background: '#2a2a40', marginTop: '3px' }}>
                                                <div style={{
                                                    width: `${t.time_progress.percent ?? 0}%`,
                                                    height: '100%',
                                                    background: '#667eea',
                                                }} />
                                            </div>
                                        </div>
                                    ) : (
                                        <div style={{ marginTop: '4px', fontSize: '10px', color: '#8888a0' }}>
                                            {buildTaskTimeTargetHint(t, insights)}
                                        </div>
                                    )}
                                </div>
                                <button
                                    onClick={() => startTaskTimeSession(t)}
                                    disabled={session.active}
                                    style={{
                                        border: '1px solid rgba(102,126,234,0.35)',
                                        background: session.active ? '#1f1f31' : 'rgba(102,126,234,0.16)',
                                        color: session.active ? '#555570' : '#a5b4fc',
                                        borderRadius: '6px',
                                        padding: '5px 7px',
                                        fontSize: '10px',
                                        fontWeight: 700,
                                        cursor: session.active ? 'default' : 'pointer',
                                        flexShrink: 0,
                                    }}
                                >
                                    Focus
                                </button>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
