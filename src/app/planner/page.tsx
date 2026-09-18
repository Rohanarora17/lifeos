'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatPlannerSessionStart, getPlannerLabels, plannerApiErrorMessage } from '@/lib/planner-presentation';
import { interpretPlanningContext } from '@/lib/planner-context';

interface CandidateTask {
    id: number;
    title: string;
    priority: string;
    status: string;
    task_type: string;
    course: string | null;
    goal_title: string | null;
    energy_required: string;
    estimated_minutes: number;
    credited_minutes: number;
    linked_sessions: number;
    avg_focus_score: number | null;
    last_credited_at: string | null;
    remaining_minutes: number;
    score: number;
    reason: string;
}

interface PlannedFocusSession {
    id: string;
    task_id: number | null;
    title: string;
    planned_start: string;
    planned_end: string;
    duration_minutes: number;
    session_type: string;
    rule_json: string;
    reward_xp: number;
    reward_coins: number;
    calendar_status: 'not_configured' | 'created' | 'synced' | 'failed' | 'deleted';
    status: 'planned' | 'started' | 'completed' | 'skipped' | 'cancelled';
}

interface CalendarEvent {
    id?: string;
    title: string;
    start_time: string;
    end_time: string;
    ignoredForPlan?: boolean;
    ignoreReason?: string | null;
}

interface PlanConstraint {
    id: string;
    title: string;
    start_time: string;
    end_time: string;
    source_text: string;
    status: 'active' | 'superseded' | 'cancelled';
}

interface DailyPlan {
    id: number;
    plan_date: string;
    sleep_time: string | null;
    wake_estimate: string | null;
    mood: string | null;
    energy: string | null;
    evening_notes: string | null;
    tomorrow_intention: string | null;
    generated_summary: string | null;
}

interface PlannerPayload {
    success: boolean;
    plan: DailyPlan | null;
    sessions: PlannedFocusSession[];
    constraints: PlanConstraint[];
    calendarEvents: CalendarEvent[];
    candidateTasks: CandidateTask[];
    personalization: {
        mode: string;
        energy: 'high' | 'medium' | 'low';
        mood: 'high' | 'medium' | 'low' | null;
        learnedSprintMinutes: number;
        bestFocusWindow: string;
    };
    suggestedInputs: {
        sleepTime: string;
        wakeEstimate: string;
        mood: 'high' | 'medium' | 'low';
        energy: 'high' | 'medium' | 'low';
        source: 'existing_plan' | 'exact_date_checkin' | 'sleep_history' | 'adaptive_baseline';
        reason: string;
    };
    calendarConfigured: boolean;
    dayContext: {
        relation: 'today' | 'tomorrow' | 'future' | 'past';
        windowStart: string;
        windowEnd: string;
        spansMidnight: boolean;
        signals: string[];
        ignoredCalendarEventIds: string[];
        focusLoad: {
            currentPlanningDay: { sessionCount: number; focusedMinutes: number; averageFocusScore: number | null; sessionTitles: string[] };
            last24Hours: { sessionCount: number; focusedMinutes: number; averageFocusScore: number | null; sessionTitles: string[] };
        };
    };
}

const moodOptions = ['low', 'medium', 'high'];
const statusOptions: PlannedFocusSession['status'][] = ['planned', 'started', 'completed', 'skipped', 'cancelled'];

function tomorrowIso() {
    const d = new Date(Date.now() + 19800000);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

function timeValue(iso: string) {
    const d = new Date(iso);
    return d.toTimeString().slice(0, 5);
}

function dateTimeLocalValue(iso: string) {
    const d = new Date(iso);
    const offsetMs = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatClock(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(minutes: number) {
    if (minutes < 60) return `${minutes}m`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}

function minutesFromClock(value: string) {
    const [h, m] = value.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
}

function sleepWindowMinutes(sleepTime: string, wakeEstimate: string) {
    const sleep = minutesFromClock(sleepTime);
    const wake = minutesFromClock(wakeEstimate);
    if (sleep === null || wake === null) return null;
    return wake >= sleep ? wake - sleep : wake + 1440 - sleep;
}

function buildEveningPlanningHint(input: {
    sleepTime: string;
    wakeEstimate: string;
    mood: string;
    energy: string;
    selectedMinutes: number;
    calendarEvents: number;
    learnedSprintMinutes: number;
    bestFocusWindow: string;
}) {
    const sleepMinutes = sleepWindowMinutes(input.sleepTime, input.wakeEstimate);
    const sleepClock = minutesFromClock(input.sleepTime);
    const pieces: string[] = [];

    if (sleepMinutes !== null && sleepMinutes < 390) {
        pieces.push(`Sleep window is only ${formatDuration(sleepMinutes)}, so make the first block lighter or later.`);
    } else if (sleepClock !== null && sleepClock >= 60 && sleepClock <= 180) {
        pieces.push('Late sleep is likely; tomorrow should avoid an aggressive first block.');
    }

    if (input.mood === 'low' || input.energy === 'low') {
        pieces.push('Low mood or energy should shrink the ask and protect recovery.');
    }

    if (input.calendarEvents >= 3) {
        pieces.push(`${input.calendarEvents} calendar items means use shorter blocks around fixed commitments.`);
    }

    if (input.selectedMinutes > input.learnedSprintMinutes * 4) {
        pieces.push(`${formatDuration(input.selectedMinutes)} selected is a heavy plan; split it across focused sessions.`);
    }

    if (pieces.length === 0) {
        pieces.push(input.bestFocusWindow ? `Anchor the hardest block near ${input.bestFocusWindow}.` : 'Use the selected tasks to create a realistic first block.');
    }

    return pieces.slice(0, 2).join(' ');
}

function buildNoGeneratedSessionsMessage(input: {
    data: PlannerPayload;
    sleepTime: string;
    wakeEstimate: string;
    mood: string;
    energy: string;
    selectedMinutes: number;
}) {
    const sleepMinutes = sleepWindowMinutes(input.sleepTime, input.wakeEstimate);
    const mode = input.data.personalization.mode;

    if (input.data.candidateTasks.length === 0) {
        return 'No generated sessions yet. Add time-based tasks first so the planner has measurable work to schedule.';
    }

    if (input.selectedMinutes <= 0) {
        return 'No generated sessions yet. Select at least one candidate task so tomorrow has a concrete focus target.';
    }

    if (sleepMinutes !== null && sleepMinutes < 390) {
        return `No generated sessions yet. Sleep window is ${formatDuration(sleepMinutes)}; regenerate with a lighter first block or later wake estimate.`;
    }

    if (mode === 'recovery' || input.energy === 'low' || input.mood === 'low') {
        return 'No generated sessions yet. Keep selected work small and regenerate a recovery-safe plan.';
    }

    if (mode === 'deadline_pressure') {
        return 'No generated sessions yet. Select the deadline-relief task and regenerate before adding optional work.';
    }

    if (mode === 'planning') {
        return 'No generated sessions yet. Add tomorrow intention, fixed constraints, and regenerate the first block.';
    }

    return `No generated sessions yet. Regenerate around ${input.data.personalization.bestFocusWindow || 'your learned focus window'}.`;
}

function buildLoadingPlannerEmptyMessage(input: {
    sleepTime: string;
    wakeEstimate: string;
    mood: string;
    energy: string;
}) {
    const sleepMinutes = sleepWindowMinutes(input.sleepTime, input.wakeEstimate);
    if (sleepMinutes !== null && sleepMinutes < 390) {
        return `No generated sessions yet. Sleep estimate is ${formatDuration(sleepMinutes)}, so the first plan should load lighter.`;
    }
    if (input.energy === 'low' || input.mood === 'low') {
        return 'No generated sessions yet. Current mood or energy points toward a recovery-safe first block.';
    }
    return 'No generated sessions yet. Planner is loading tomorrow context before choosing blocks.';
}

function buildTaskPoolEmptyMessage(data: PlannerPayload, energy: string, mood: string): string {
    const mode = data.personalization.mode;
    if (mode === 'recovery' || energy === 'low' || mood === 'low') {
        return 'No open time-target tasks found. Add one small recovery-safe target before generating tomorrow.';
    }
    if (mode === 'deadline_pressure') {
        return 'No open time-target tasks found. Add the deadline-relief task that tomorrow must protect.';
    }
    if (mode === 'planning') {
        return 'No open time-target tasks found. Turn tomorrow’s intention into one measurable time target.';
    }
    if (data.personalization.bestFocusWindow) {
        return `No open time-target tasks found. Add one task sized for ${data.personalization.bestFocusWindow}.`;
    }
    return 'No open time-target tasks found. Add a measurable task so sessions can complete it by time.';
}

function parseRule(ruleJson: string) {
    try {
        return JSON.parse(ruleJson) as { mode?: string; guidance?: string; tools?: string[]; breakMinutes?: number; taskReason?: string; rewardReason?: string };
    } catch {
        return {};
    }
}

function formatRuleMode(mode?: string) {
    if (!mode) return 'adaptive block';
    return mode.replaceAll('_', ' ');
}

function calendarStatusLabel(status: PlannedFocusSession['calendar_status']) {
    if (status === 'not_configured') return 'calendar local only';
    if (status === 'created') return 'calendar created';
    if (status === 'synced') return 'calendar synced';
    if (status === 'failed') return 'calendar sync failed';
    return 'calendar deleted';
}

function pillStyle(color: string, bg: string) {
    return {
        fontSize: '11px',
        fontWeight: 700,
        padding: '3px 7px',
        borderRadius: '6px',
        color,
        background: bg,
        whiteSpace: 'nowrap' as const,
    };
}

export default function PlannerPage() {
    const [date, setDate] = useState(tomorrowIso());
    const [data, setData] = useState<PlannerPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [savingId, setSavingId] = useState<string | null>(null);
    const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
    const [sleepTime, setSleepTime] = useState('');
    const [wakeEstimate, setWakeEstimate] = useState('');
    const [mood, setMood] = useState('medium');
    const [energy, setEnergy] = useState('medium');
    const [tomorrowIntention, setTomorrowIntention] = useState('');
    const [eveningNotes, setEveningNotes] = useState('');
    const [syncCalendar, setSyncCalendar] = useState(false);
    const [generationError, setGenerationError] = useState<string | null>(null);

    const applyPayload = useCallback((payload: PlannerPayload) => {
        setData(payload);
        setSleepTime(payload.plan?.sleep_time || payload.suggestedInputs.sleepTime);
        setWakeEstimate(payload.plan?.wake_estimate || payload.suggestedInputs.wakeEstimate);
        if (payload.calendarConfigured) setSyncCalendar(true);
        if (payload.plan) {
            setMood(payload.plan.mood || payload.suggestedInputs.mood || payload.personalization.mood || 'medium');
            setEnergy(payload.plan.energy || payload.suggestedInputs.energy || payload.personalization.energy || 'medium');
            setTomorrowIntention(payload.plan.tomorrow_intention || '');
            setEveningNotes(payload.plan.evening_notes || '');
        } else {
            setMood(payload.suggestedInputs.mood || payload.personalization.mood || 'medium');
            setEnergy(payload.suggestedInputs.energy || payload.personalization.energy || 'medium');
        }
        setSelectedIds(new Set(payload.candidateTasks.slice(0, 4).map(task => task.id)));
    }, []);

    const fetchPlanPayload = useCallback(async (targetDate: string) => {
        const res = await fetch(`/api/next-day-plan?date=${targetDate}`);
        return await res.json() as PlannerPayload;
    }, []);

    const loadPlan = useCallback(async (targetDate = date) => {
        setLoading(true);
        const payload = await fetchPlanPayload(targetDate);
        applyPayload(payload);
        setLoading(false);
    }, [applyPayload, date, fetchPlanPayload]);

    useEffect(() => {
        let cancelled = false;
        fetchPlanPayload(date)
            .then(payload => {
                if (cancelled) return;
                applyPayload(payload);
            })
            .catch(error => console.error('Failed to load planner', error))
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [applyPayload, date, fetchPlanPayload]);

    const selectedMinutes = useMemo(() => {
        if (!data) return 0;
        return data.candidateTasks
            .filter(task => selectedIds.has(task.id))
            .reduce((sum, task) => sum + task.remaining_minutes, 0);
    }, [data, selectedIds]);

    const totalPlannedMinutes = useMemo(() => {
        return data?.sessions
            .filter(session => session.status === 'planned' || session.status === 'started')
            .reduce((sum, session) => sum + session.duration_minutes, 0) ?? 0;
    }, [data]);
    const plannerLabels = getPlannerLabels(data?.dayContext.relation ?? 'tomorrow');
    const liveContextPreview = useMemo(() => interpretPlanningContext({
        intention: tomorrowIntention,
        eveningNotes,
        calendarEvents: data?.calendarEvents ?? [],
    }), [data?.calendarEvents, eveningNotes, tomorrowIntention]);
    const effectiveCalendarCount = liveContextPreview.effectiveCalendarEvents.length;
    const displayedContextSignals = useMemo(() => {
        const measured = data?.dayContext.signals.filter(signal => /focus sessions?/i.test(signal)) ?? [];
        const currentSleepMinutes = sleepWindowMinutes(sleepTime, wakeEstimate);
        const sleepSignal = currentSleepMinutes !== null && currentSleepMinutes <= 360
            ? `${formatDuration(currentSleepMinutes)} sleep window needs recovery protection`
            : null;
        return [...new Set([...liveContextPreview.signals, ...measured, ...(sleepSignal ? [sleepSignal] : [])])];
    }, [data?.dayContext.signals, liveContextPreview.signals, sleepTime, wakeEstimate]);
    const planningHint = data ? buildEveningPlanningHint({
        sleepTime,
        wakeEstimate,
        mood,
        energy,
        selectedMinutes,
        calendarEvents: effectiveCalendarCount,
        learnedSprintMinutes: data.personalization.learnedSprintMinutes,
        bestFocusWindow: data.personalization.bestFocusWindow,
    }) : null;
    const noGeneratedSessionsMessage = data ? buildNoGeneratedSessionsMessage({
        data,
        sleepTime,
        wakeEstimate,
        mood,
        energy,
        selectedMinutes,
    }) : buildLoadingPlannerEmptyMessage({ sleepTime, wakeEstimate, mood, energy });

    const generatePlan = async () => {
        setGenerating(true);
        setGenerationError(null);
        try {
            const res = await fetch('/api/next-day-plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    planDate: date,
                    sleepTime,
                    wakeEstimate,
                    mood,
                    energy,
                    tomorrowIntention,
                    eveningNotes,
                    selectedTaskIds: Array.from(selectedIds),
                    syncCalendar,
                    regenerate: true,
                }),
            });
            const payload = await res.json() as PlannerPayload & { error?: string };
            const error = plannerApiErrorMessage(payload);
            if (!res.ok || error) {
                setGenerationError(error || `Replan failed (${res.status}). Your current plan was kept.`);
                return;
            }
            applyPayload(payload);
        } catch (error) {
            setGenerationError(`Replan failed: ${String(error)}. Your current plan was kept.`);
        } finally {
            setGenerating(false);
        }
    };

    const updateSession = async (session: PlannedFocusSession, patch: Partial<{
        title: string;
        plannedStart: string;
        plannedEnd: string;
        status: PlannedFocusSession['status'];
    }>) => {
        setSavingId(session.id);
        const res = await fetch('/api/next-day-plan', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: session.id, syncCalendar, ...patch }),
        });
        const payload = await res.json() as { success: boolean; session?: PlannedFocusSession };
        if (payload.success && payload.session) {
            setData(prev => prev ? {
                ...prev,
                sessions: prev.sessions.map(item => item.id === payload.session!.id ? payload.session! : item),
            } : prev);
        }
        setSavingId(null);
    };

    const cancelSession = async (session: PlannedFocusSession) => {
        setSavingId(session.id);
        await fetch(`/api/next-day-plan?id=${session.id}&syncCalendar=${syncCalendar ? 'true' : 'false'}`, { method: 'DELETE' });
        await loadPlan(date);
        setSavingId(null);
    };

    const toggleTask = (id: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const [syncingCalendar, setSyncingCalendar] = useState(false);
    const [syncNotice, setSyncNotice] = useState<string | null>(null);

    const triggerCalendarSync = async () => {
        setSyncingCalendar(true);
        setSyncNotice(null);
        try {
            const res = await fetch(`/api/next-day-plan?date=${date}`, { method: 'PUT' });
            const result = await res.json() as { success: boolean; configured: boolean; syncedCount?: number; authUrl?: string; message: string };
            if (result.authUrl) {
                window.location.href = result.authUrl;
                return;
            }
            setSyncNotice(result.message);
            await loadPlan(date);
        } catch {
            setSyncNotice('Failed to sync calendar.');
        } finally {
            setSyncingCalendar(false);
        }
    };

    return (
        <div className="max-w-[1180px] mx-auto animate-fade-in">
            <div className="flex items-start justify-between gap-4 mb-6">
                <div>
                    <h1 className="text-2xl font-bold">{plannerLabels.title}</h1>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                        A living wake-to-sleep plan shaped by completed focus, calendar reality, and the context you provide.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <input
                        className="input"
                        type="date"
                        value={date}
                        onChange={event => setDate(event.target.value)}
                        style={{ width: 152 }}
                    />
                    <button
                        className="btn btn-primary btn-sm flex items-center gap-1"
                        onClick={() => void triggerCalendarSync()}
                        disabled={loading || syncingCalendar}
                        title="Push planned focus sessions to Google Calendar"
                    >
                        📅 {syncingCalendar ? 'Syncing...' : 'Sync to Calendar'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void loadPlan(date)} disabled={loading}>
                        Refresh
                    </button>
                </div>
            </div>

            {syncNotice && (
                <div
                    className="mb-4 p-3 rounded-lg flex items-center justify-between text-xs font-medium"
                    style={{
                        background: 'rgba(59,130,246,0.12)',
                        border: '1px solid rgba(59,130,246,0.3)',
                        color: 'var(--text-primary)',
                    }}
                >
                    <span>{syncNotice}</span>
                    <button onClick={() => setSyncNotice(null)} className="ml-2 text-xs opacity-70 hover:opacity-100">✕</button>
                </div>
            )}

            {loading || !data ? (
                <div className="card" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 48 }}>
                    Loading planner context...
                </div>
            ) : (
                <div className="grid grid-cols-1 xl:grid-cols-[minmax(320px,390px)_minmax(0,1fr)] gap-5">
                    <section className="space-y-5">
                        <div className="card" style={{ borderRadius: 8 }}>
                            <div className="flex items-center justify-between mb-4">
                                <div>
                                    <div className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Evening Capture</div>
                                    <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                                        {data.personalization.mode} mode · learned {data.personalization.learnedSprintMinutes}m
                                    </div>
                                </div>
                                <span style={pillStyle(data.calendarConfigured ? 'var(--accent-green)' : 'var(--text-muted)', data.calendarConfigured ? 'var(--accent-green-glow)' : 'var(--bg-secondary)')}>
                                    Calendar {data.calendarConfigured ? 'ready' : 'local'}
                                </span>
                            </div>

                            <div className="grid grid-cols-2 gap-3 mb-3">
                                <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    Sleep
                                    <input className="input mt-1" type="time" value={sleepTime} onChange={event => setSleepTime(event.target.value)} />
                                </label>
                                <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    Wake
                                    <input className="input mt-1" type="time" value={wakeEstimate} onChange={event => setWakeEstimate(event.target.value)} />
                                </label>
                            </div>
                            <div className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                                {data.suggestedInputs.reason} · {data.suggestedInputs.source.replaceAll('_', ' ')}
                            </div>
                            {planningHint && (
                                <div className="text-xs mb-3" style={{
                                    color: 'var(--text-secondary)',
                                    background: 'rgba(59,130,246,0.08)',
                                    border: '1px solid rgba(59,130,246,0.18)',
                                    borderRadius: 8,
                                    padding: '8px 10px',
                                    lineHeight: 1.45,
                                }}>
                                    {planningHint}
                                </div>
                            )}

                            {displayedContextSignals.length > 0 && (
                                <div className="mb-3">
                                    <div className="text-[10px] font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>LifeOS will act on when you replan</div>
                                    <div className="flex flex-wrap gap-2">
                                        {displayedContextSignals.map(signal => (
                                            <span key={signal} style={pillStyle('var(--accent-blue)', 'var(--accent-blue-glow)')}>{signal}</span>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-3 mb-3">
                                <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    Mood
                                    <select className="input mt-1" value={mood} onChange={event => setMood(event.target.value)}>
                                        {moodOptions.map(option => <option key={option} value={option}>{option}</option>)}
                                    </select>
                                </label>
                                <label className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                    Energy
                                    <select className="input mt-1" value={energy} onChange={event => setEnergy(event.target.value)}>
                                        {moodOptions.map(option => <option key={option} value={option}>{option}</option>)}
                                    </select>
                                </label>
                            </div>

                            <label className="text-xs block mb-3" style={{ color: 'var(--text-secondary)' }}>
                                {plannerLabels.intentionLabel}
                                <input
                                    className="input mt-1"
                                    value={tomorrowIntention}
                                    onChange={event => setTomorrowIntention(event.target.value)}
                                    placeholder={energy === 'low' || mood === 'low'
                                        ? 'one must-do task and the smallest useful time target...'
                                        : data.personalization.bestFocusWindow
                                            ? `hardest task near ${data.personalization.bestFocusWindow}, plus any lighter work...`
                                            : 'study ZKs for 2 hours, revise maths, read one paper...'}
                                />
                            </label>

                            <label className="text-xs block" style={{ color: 'var(--text-secondary)' }}>
                                {data.dayContext.relation === 'today' ? 'What changed today?' : 'Notes from today'}
                                <textarea
                                    className="input mt-1"
                                    value={eveningNotes}
                                    onChange={event => setEveningNotes(event.target.value)}
                                    placeholder={sleepWindowMinutes(sleepTime, wakeEstimate) !== null
                                        ? 'what happened today that should change tomorrow: focus, body, stress, interruptions'
                                        : 'include sleep pressure, late-night risk, mood, physical state, and disruptions'}
                                    rows={4}
                                    style={{ resize: 'vertical' }}
                                />
                            </label>

                            <label className="flex items-center gap-2 mt-4 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                <input type="checkbox" checked={syncCalendar} onChange={event => setSyncCalendar(event.target.checked)} />
                                Sync creates or edits Google Calendar events when configured
                            </label>

                            <button
                                className="btn btn-primary w-full mt-4 justify-center"
                                onClick={() => void generatePlan()}
                                disabled={generating || (data.candidateTasks.length > 0 && selectedIds.size === 0 && !tomorrowIntention.trim())}
                            >
                                {generating ? 'Replanning...' : data.plan ? plannerLabels.generateLabel : plannerLabels.generateLabel.replace('Regenerate', 'Generate')}
                            </button>
                            {generationError && (
                                <div className="text-xs mt-3" style={{ color: 'var(--accent-red)', lineHeight: 1.45 }}>
                                    {generationError}
                                </div>
                            )}
                        </div>

                        {data.constraints.length > 0 && (
                            <div className="card" style={{ borderRadius: 8 }}>
                                <div className="text-xs font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>Fixed Constraints</div>
                                <div className="space-y-2">
                                    {data.constraints.map(constraint => (
                                        <div key={constraint.id} style={{ padding: '10px 11px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="text-sm font-semibold">{constraint.title}</div>
                                                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                                                    {formatPlannerSessionStart(constraint.start_time)}-{timeValue(constraint.end_time)}
                                                </div>
                                            </div>
                                            <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                                                Source: “{constraint.source_text}” · unavailable time, not focus work
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="card" style={{ borderRadius: 8 }}>
                            <div className="flex items-center justify-between mb-3">
                                <div className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Task Pool</div>
                                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{selectedIds.size} selected · {formatDuration(selectedMinutes)}</span>
                            </div>
                            <div className="space-y-2">
                                {(() => {
                                    const realCandidateTasks = data.candidateTasks.filter(task => task.id > 0);
                                    if (realCandidateTasks.length === 0) {
                                        return (
                                            <div className="text-xs p-3 rounded-lg" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                                                {buildTaskPoolEmptyMessage(data, energy, mood)} The AI engine can also synthesize focus blocks directly from your stated context and effective calendar.
                                            </div>
                                        );
                                    }
                                    return realCandidateTasks.map(task => (
                                        <button
                                            key={task.id}
                                            onClick={() => toggleTask(task.id)}
                                            className="w-full text-left"
                                            style={{
                                                padding: '10px 11px',
                                                borderRadius: 8,
                                                border: `1px solid ${selectedIds.has(task.id) ? 'rgba(59,130,246,0.55)' : 'var(--border)'}`,
                                                background: selectedIds.has(task.id) ? 'rgba(59,130,246,0.10)' : 'var(--bg-secondary)',
                                            }}
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div style={{ minWidth: 0 }}>
                                                    <div className="text-sm font-semibold truncate">{task.title}</div>
                                                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                                                        {task.reason}
                                                    </div>
                                                </div>
                                                <span style={pillStyle('var(--accent-blue)', 'var(--accent-blue-glow)')}>{task.remaining_minutes}m left</span>
                                            </div>
                                            <div className="flex gap-2 mt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                                                <span>{task.priority}</span>
                                                <span>{task.energy_required} energy</span>
                                                <span>{task.task_type}</span>
                                                {task.course && <span>{task.course}</span>}
                                                <span>{task.credited_minutes}/{task.estimated_minutes}m</span>
                                            </div>
                                            <div className="flex flex-wrap gap-2 mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                                <span>score {Math.round(task.score)}</span>
                                                <span>{task.linked_sessions} linked session{task.linked_sessions === 1 ? '' : 's'}</span>
                                                {task.avg_focus_score !== null && (
                                                    <span>{Math.round(task.avg_focus_score)} avg focus</span>
                                                )}
                                                {task.last_credited_at && (
                                                    <span>last touched {new Date(task.last_credited_at).toLocaleDateString()}</span>
                                                )}
                                            </div>
                                        </button>
                                    ));
                                })()}
                            </div>
                        </div>
                    </section>

                    <section className="space-y-5">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div className="stat-card blue" style={{ borderRadius: 8 }}>
                                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Remaining Focus</div>
                                <div className="text-2xl font-bold mt-2">{formatDuration(totalPlannedMinutes)}</div>
                            </div>
                            <div className="stat-card green" style={{ borderRadius: 8 }}>
                                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Focus in Last 24h</div>
                                <div className="text-2xl font-bold mt-2">{formatDuration(data.dayContext.focusLoad.last24Hours.focusedMinutes)}</div>
                                <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                                    {data.dayContext.focusLoad.last24Hours.sessionCount} sessions
                                    {data.dayContext.focusLoad.last24Hours.averageFocusScore !== null
                                        ? ` · ${data.dayContext.focusLoad.last24Hours.averageFocusScore} avg focus`
                                        : ''}
                                </div>
                            </div>
                            <div className="stat-card orange" style={{ borderRadius: 8 }}>
                                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Effective Calendar</div>
                                <div className="text-2xl font-bold mt-2">{effectiveCalendarCount}</div>
                                {liveContextPreview.ignoredCalendarEventIds.length > 0 && (
                                    <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                                        {liveContextPreview.ignoredCalendarEventIds.length} ignored for this plan
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="card" style={{ borderRadius: 8 }}>
                            <div className="flex items-center justify-between mb-4">
                                <div>
                                    <div className="text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{plannerLabels.blocksLabel}</div>
                                    <div className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                                        {data.plan?.generated_summary || data.personalization.bestFocusWindow}
                                    </div>
                                </div>
                                <span style={pillStyle('var(--accent-yellow)', 'var(--accent-yellow-glow)')}>{data.personalization.energy} energy</span>
                            </div>

                            {data.sessions.length === 0 ? (
                                <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
                                    {noGeneratedSessionsMessage}
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {data.sessions.map(session => {
                                        const rule = parseRule(session.rule_json);
                                        const cancelled = session.status === 'cancelled';
                                        return (
                                            <div
                                                key={session.id}
                                                style={{
                                                    display: 'grid',
                                                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                                                    gap: 12,
                                                    padding: 12,
                                                    borderRadius: 8,
                                                    border: '1px solid var(--border)',
                                                    background: cancelled ? 'rgba(85,85,112,0.08)' : 'var(--bg-secondary)',
                                                    opacity: cancelled ? 0.65 : 1,
                                                }}
                                            >
                                                <div>
                                                    <div className="text-base font-bold">{formatPlannerSessionStart(session.planned_start)}</div>
                                                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                                        {formatClock(session.planned_end)} · {session.duration_minutes}m
                                                    </div>
                                                    <div className="text-xs mt-2" style={{ color: 'var(--accent-blue)' }}>{session.session_type}</div>
                                                </div>

                                                <div style={{ minWidth: 0 }}>
                                                    <input
                                                        className="input"
                                                        value={session.title}
                                                        onChange={event => {
                                                            const nextTitle = event.target.value;
                                                            setData(prev => prev ? {
                                                                ...prev,
                                                                sessions: prev.sessions.map(item => item.id === session.id ? { ...item, title: nextTitle } : item),
                                                            } : prev);
                                                        }}
                                                        onBlur={event => void updateSession(session, { title: event.target.value })}
                                                        disabled={cancelled}
                                                        style={{ fontWeight: 700 }}
                                                    />
                                                    <div className="text-xs mt-2" style={{ color: 'var(--text-secondary)' }}>
                                                        {rule.guidance || 'Personalized focus block'}
                                                    </div>
                                                    <div
                                                        className="mt-3"
                                                        style={{
                                                            padding: '9px 10px',
                                                            borderRadius: 8,
                                                            border: '1px solid rgba(255,255,255,0.08)',
                                                            background: 'rgba(255,255,255,0.035)',
                                                        }}
                                                    >
                                                        <div className="text-[10px] font-bold uppercase tracking-wide mb-1" style={{ color: 'var(--text-muted)' }}>
                                                            Why this block
                                                        </div>
                                                        <div className="text-xs" style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                                                            <div>
                                                                <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{formatRuleMode(rule.mode || session.session_type)}</span>
                                                                {' '}because {rule.taskReason || 'it fits the selected time target and tomorrow context'}.
                                                            </div>
                                                            <div>
                                                                {formatDuration(session.duration_minutes)} block
                                                                {typeof rule.breakMinutes === 'number' ? `, then ${rule.breakMinutes}m break` : ''}
                                                                {' '}· {calendarStatusLabel(session.calendar_status)}
                                                            </div>
                                                            <div>
                                                                {rule.rewardReason
                                                                    ? `Reward: ${rule.rewardReason}`
                                                                    : `Reward priced at ${session.reward_xp} XP / ${session.reward_coins} coins for this duration and task fit.`}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2 mt-2">
                                                        <span style={pillStyle('var(--accent-green)', 'var(--accent-green-glow)')}>{session.reward_xp} XP</span>
                                                        <span style={pillStyle('var(--accent-yellow)', 'var(--accent-yellow-glow)')}>{session.reward_coins} coins</span>
                                                        <span style={pillStyle('var(--text-secondary)', 'var(--bg-card)')}>{calendarStatusLabel(session.calendar_status)}</span>
                                                        {Array.isArray(rule.tools) && rule.tools.slice(0, 3).map(tool => (
                                                            <span key={tool} style={pillStyle('var(--text-secondary)', 'var(--bg-card)')}>{tool}</span>
                                                        ))}
                                                    </div>
                                                </div>
                                                <div className="space-y-2.5 min-w-[160px]">
                                                    <div>
                                                        <label className="text-[10px] font-bold uppercase tracking-wide block mb-1" style={{ color: 'var(--text-muted)' }}>Start Time</label>
                                                        <input
                                                            className="input text-xs w-full"
                                                            type="datetime-local"
                                                            value={dateTimeLocalValue(session.planned_start)}
                                                            onChange={event => {
                                                                const start = new Date(event.target.value);
                                                                const end = new Date(start.getTime() + session.duration_minutes * 60000);
                                                                void updateSession(session, { plannedStart: start.toISOString(), plannedEnd: end.toISOString() });
                                                            }}
                                                            disabled={cancelled || savingId === session.id}
                                                        />
                                                    </div>

                                                    <div>
                                                        <label className="text-[10px] font-bold uppercase tracking-wide block mb-1" style={{ color: 'var(--text-muted)' }}>Duration</label>
                                                        <select
                                                            className="input text-xs w-full"
                                                            value={session.duration_minutes}
                                                            onChange={event => {
                                                                const newDuration = parseInt(event.target.value, 10);
                                                                const start = new Date(session.planned_start);
                                                                const end = new Date(start.getTime() + newDuration * 60000);
                                                                void updateSession(session, { plannedStart: start.toISOString(), plannedEnd: end.toISOString() });
                                                            }}
                                                            disabled={cancelled || savingId === session.id}
                                                        >
                                                            <option value={15}>15m block</option>
                                                            <option value={20}>20m block</option>
                                                            <option value={30}>30m block</option>
                                                            <option value={45}>45m block</option>
                                                            <option value={60}>60m (1h) block</option>
                                                            <option value={75}>75m block</option>
                                                            <option value={90}>90m (1.5h) block</option>
                                                            <option value={120}>120m (2h) block</option>
                                                            <option value={150}>150m (2.5h) block</option>
                                                            <option value={180}>180m (3h) block</option>
                                                        </select>
                                                    </div>

                                                    <div>
                                                        <label className="text-[10px] font-bold uppercase tracking-wide block mb-1" style={{ color: 'var(--text-muted)' }}>Status</label>
                                                        <select
                                                            className="input text-xs w-full"
                                                            value={session.status}
                                                            onChange={event => void updateSession(session, { status: event.target.value as PlannedFocusSession['status'] })}
                                                            disabled={savingId === session.id}
                                                        >
                                                            {statusOptions.map(option => <option key={option} value={option}>{option}</option>)}
                                                        </select>
                                                    </div>

                                                    <button
                                                        className="btn btn-ghost btn-sm w-full justify-center text-xs mt-1"
                                                        onClick={() => void cancelSession(session)}
                                                        disabled={savingId === session.id || cancelled}
                                                    >
                                                        {savingId === session.id ? 'Saving...' : 'Cancel Session'}
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="card" style={{ borderRadius: 8 }}>
                            <div className="text-xs font-bold uppercase tracking-wide mb-3" style={{ color: 'var(--text-muted)' }}>Calendar Context</div>
                            {liveContextPreview.calendarEvents.length === 0 ? (
                                <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No calendar events on this date.</div>
                            ) : (
                                <div className="space-y-2">
                                    {liveContextPreview.calendarEvents.map((event, index) => (
                                        <div key={`${event.start_time}-${event.title}-${index}`} className="flex items-center justify-between gap-3" style={{ padding: '9px 10px', borderRadius: 8, background: 'var(--bg-secondary)', opacity: event.ignoredForPlan ? 0.58 : 1 }}>
                                            <div className="text-sm truncate" style={{ textDecoration: event.ignoredForPlan ? 'line-through' : 'none' }}>{event.title}</div>
                                            <div className="text-xs flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
                                                <span>{formatPlannerSessionStart(event.start_time)}-{timeValue(event.end_time)}</span>
                                                {event.ignoredForPlan && <span style={pillStyle('var(--text-muted)', 'var(--bg-card)')}>ignored</span>}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </section>
                </div>
            )}
        </div>
    );
}
