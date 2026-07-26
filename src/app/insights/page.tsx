'use client';

import { useState, useEffect, useCallback } from 'react';
import { scoreColor, productivityRatioColor } from '@/lib/score-classify';

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

interface AdaptiveInsightsContext {
    mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
    guidance: string;
    energy: 'high' | 'medium' | 'low';
    mood: 'high' | 'medium' | 'low' | null;
    focusTrend: 'improving' | 'declining' | 'stable';
    alertFatigueLevel: 'low' | 'medium' | 'high';
    nextBestFocusWindow: string;
    lensTitle: string;
    lensSummary: string;
    recommendedAnalysis: string;
    insightTone: 'gentle' | 'direct' | 'urgent' | 'reflective';
    interpretationRules: string[];
    currentSignals: {
        openTasks: number;
        overdueTasks: number;
        recentDistractionMinutes: number;
        uncheckedHabits: number;
        activeSession: boolean;
    };
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
    adaptiveContext?: AdaptiveInsightsContext;
}

interface CognitiveTraitEvidence {
    label: string;
    detail: string;
    at?: string | null;
}

interface CognitiveTraitView {
    id: string;
    label: string;
    valueLabel: string;
    value: number | null;
    unit: string | null;
    confidence: number;
    trend?: 'improving' | 'worsening' | 'stable' | 'unknown';
    userStance: 'observed' | 'confirmed' | 'disputed' | 'aspirational';
    sampleSize: number;
    evidence: CognitiveTraitEvidence[];
}

interface CognitiveHypothesisView {
    id: string;
    traitId: string;
    claim: string;
    why: string;
    confidence: number;
    evidence: string[];
    stance: string;
    actionHint: string;
}

interface CognitiveExperimentView {
    id: string;
    kind: 'early_synthetic_deadline' | 'activation_block';
    status: string;
    title: string;
    rationale: string;
    traitSignals: string[];
    suggestedTaskTitle: string | null;
    durationMinutes: number;
    syntheticDueDate: string | null;
    expiresAt: string;
}

interface ExperimentStateView {
    active: CognitiveExperimentView | null;
    offered: CognitiveExperimentView | null;
    canOffer: boolean;
    offerBlockReason: string | null;
}

interface ActiveCoachView {
    mode: 'auto' | 'off';
    enabled: boolean;
    suppressRewiring: boolean;
    activationBlocks: boolean;
    earlyCommitmentBoost: boolean;
    voluntaryRewardBias: number;
    coachGuidance: string;
    reasons: string[];
    mapTrust: {
        trusted: boolean;
        reason: string;
        confirmed: string[];
        aspirational: string[];
        disputed: string[];
    };
}

interface TraitHistoryPoint {
    date: string;
    pressureDependency: number | null;
    voluntaryStartRate: number | null;
    activationEnergyDays: number | null;
    crisisBonus: number | null;
    confidence: number;
}

interface TrajectoryWeekView {
    weekStart: string;
    weekEnd: string;
    sampleDays: number;
    avgPressureDependency: number | null;
    avgVoluntaryStartRate: number | null;
    pressureTrend: string;
    voluntaryTrend: string;
}

interface TrajectoryView {
    headline: string;
    enoughData: boolean;
    historyDays: number;
    weeks: TrajectoryWeekView[];
}

interface BrainMapPayload {
    summary: string;
    traits: CognitiveTraitView[];
    hypotheses: CognitiveHypothesisView[];
    pressureProfile: {
        pressureDependency: number | null;
        voluntaryStartRate: number | null;
        crisisBonus: number | null;
        activationEnergyDays: number | null;
        avoidanceAgeDays: number | null;
        confidence: number;
    };
    windowDays: number;
    experiments: ExperimentStateView | null;
    history: TraitHistoryPoint[];
    activeCoach: ActiveCoachView | null;
    trajectory: TrajectoryView | null;
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

function buildNoSessionsCopy(context?: AdaptiveInsightsContext): string {
    if (!context) return 'No sessions detected yet today. Complete a timed block so insights can compare focus, energy, and follow-through.';
    if (context.currentSignals.activeSession) return 'Active session is still being tracked; completed blocks will land here.';
    if (context.mode === 'recovery' || context.energy === 'low' || context.mood === 'low') {
        return `No completed sessions yet. Start with a lighter block around ${context.nextBestFocusWindow}.`;
    }
    if (context.mode === 'deadline_pressure') {
        return `No completed sessions yet. Protect the next deadline-relief window: ${context.nextBestFocusWindow}.`;
    }
    if (context.mode === 'planning') {
        return 'No completed sessions yet. Use this as a planning day signal, not a failure signal.';
    }
    return `No completed sessions yet. Best next window: ${context.nextBestFocusWindow}.`;
}

function buildGoalNamePlaceholder(context?: AdaptiveInsightsContext): string {
    if (!context) return 'e.g., 4 hours deep work';
    if (context.mode === 'recovery' || context.energy === 'low' || context.mood === 'low') return 'e.g., 90 minutes gentle study';
    if (context.mode === 'deadline_pressure') return 'e.g., 2 deadline relief blocks';
    if (context.mode === 'planning') return 'e.g., plan tomorrow before bed';
    if (context.focusTrend === 'improving') return 'e.g., protect morning deep work';
    return 'e.g., focused study before distractions';
}

function buildGoalTargetPlaceholder(metric: string, context?: AdaptiveInsightsContext): string {
    if (metric === 'tasks_completed') return context?.mode === 'recovery' ? '1' : '3';
    if (metric === 'habits_completed') return context?.energy === 'low' ? '2' : '4';
    if (metric === 'github_commits') return context?.mode === 'deadline_pressure' ? '2' : '1';
    if (metric === 'distraction_minutes') return context?.alertFatigueLevel === 'high' ? '45' : '30';
    if (metric === 'deep_work_minutes') return context?.energy === 'low' || context?.mood === 'low' ? '90' : '180';
    return context?.mode === 'recovery' || context?.energy === 'low' ? '120' : '240';
}

function buildDomainEmptyCopy(kind: 'productive' | 'distraction', context?: AdaptiveInsightsContext): string {
    if (!context) return kind === 'productive'
        ? 'No productive domains yet. Start one tracked focus block so LifeOS can learn what counts as useful work.'
        : 'No distraction domains yet. Keep tracking so LifeOS can separate real breaks from avoidance.';
    if (kind === 'productive') {
        if (context.mode === 'recovery' || context.energy === 'low') return 'No productive domains yet. A small restorative block still counts.';
        return `No productive domains yet. ${context.recommendedAnalysis}`;
    }
    if (context.alertFatigueLevel === 'high') return 'No distraction domains yet. Keep alerts quiet while LifeOS learns.';
    return 'No distraction domains yet. Keep tracking so patterns can separate breaks from avoidance.';
}

export default function InsightsPage() {
    const [data, setData] = useState<FullAnalysis | null>(null);
    const [brainMap, setBrainMap] = useState<BrainMapPayload | null>(null);
    const [stanceBusy, setStanceBusy] = useState<string | null>(null);
    const [experimentBusy, setExperimentBusy] = useState(false);
    const [expandedTrait, setExpandedTrait] = useState<string | null>(null);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<'overview' | 'focus' | 'consistency' | 'goals' | 'insights'>('overview');
    const [showGoalForm, setShowGoalForm] = useState(false);
    const [newGoal, setNewGoal] = useState({ title: '', type: 'daily', metric: 'productive_minutes', target_value: '', unit: 'minutes' });

    const loadBrainMap = useCallback(async () => {
        try {
            const res = await fetch('/api/personalization/model', { cache: 'no-store' });
            if (!res.ok) return;
            const payload = await res.json();
            const traits = payload.cognitiveTraits ?? payload.selfModel?.cognitiveTraits;
            if (!traits) return;
            setBrainMap({
                summary: traits.summary || payload.selfModel?.summary || '',
                traits: traits.traits || [],
                hypotheses: traits.hypotheses || payload.hypotheses || [],
                pressureProfile: traits.pressureProfile || payload.pressureProfile,
                windowDays: traits.windowDays || 45,
                experiments: payload.experiments ?? null,
                history: traits.history || [],
                activeCoach: payload.activeCoach ?? null,
                trajectory: payload.trajectory ?? null,
            });
        } catch (e) {
            console.error(e);
        }
    }, []);

    const loadData = useCallback(async () => {
        try {
            const res = await fetch('/api/behavior?action=full');
            const d = await res.json();
            setData(d);
        } catch (e) { console.error(e); }
        setIsLoading(false);
    }, []);

    useEffect(() => {
        const id = window.setTimeout(() => {
            void loadData();
            void loadBrainMap();
        }, 0);
        return () => window.clearTimeout(id);
    }, [loadData, loadBrainMap]);

    const setTraitStance = async (traitId: string, stance: 'confirmed' | 'disputed' | 'aspirational' | 'observed') => {
        setStanceBusy(`${traitId}:${stance}`);
        try {
            const res = await fetch('/api/personalization/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ traitId, stance, action: 'set_stance' }),
            });
            if (res.ok) {
                const payload = await res.json();
                const traits = payload.cognitiveTraits ?? payload.model?.cognitiveTraits;
                if (traits) {
                    setBrainMap({
                        summary: traits.summary || '',
                        traits: traits.traits || [],
                        hypotheses: traits.hypotheses || payload.hypotheses || [],
                        pressureProfile: traits.pressureProfile || payload.pressureProfile,
                        windowDays: traits.windowDays || 45,
                        experiments: payload.experiments ?? payload.model?.experiments ?? null,
                        history: traits.history || [],
                        activeCoach: payload.activeCoach ?? payload.model?.activeCoach ?? null,
                        trajectory: payload.model?.trajectory ?? payload.trajectory ?? null,
                    });
                } else {
                    await loadBrainMap();
                }
            }
        } catch (e) {
            console.error(e);
        }
        setStanceBusy(null);
    };

    const setCoachMode = async (mode: 'auto' | 'off') => {
        setExperimentBusy(true);
        try {
            const res = await fetch('/api/personalization/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'set_active_coach_mode', mode }),
            });
            if (res.ok) {
                const payload = await res.json();
                setBrainMap(prev => prev ? {
                    ...prev,
                    activeCoach: payload.activeCoach ?? payload.model?.activeCoach ?? prev.activeCoach,
                } : prev);
            }
        } catch (e) {
            console.error(e);
        }
        setExperimentBusy(false);
    };

    const respondExperiment = async (experimentId: string, response: 'accepted' | 'declined' | 'completed' | 'cancelled') => {
        setExperimentBusy(true);
        try {
            const res = await fetch('/api/personalization/model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'respond_experiment', experimentId, response }),
            });
            if (res.ok) {
                const payload = await res.json();
                if (payload.model?.cognitiveTraits || payload.experiments) {
                    const traits = payload.model?.cognitiveTraits;
                    setBrainMap(prev => ({
                        summary: traits?.summary || prev?.summary || '',
                        traits: traits?.traits || prev?.traits || [],
                        hypotheses: traits?.hypotheses || prev?.hypotheses || [],
                        pressureProfile: traits?.pressureProfile || prev?.pressureProfile || {
                            pressureDependency: null,
                            voluntaryStartRate: null,
                            crisisBonus: null,
                            activationEnergyDays: null,
                            avoidanceAgeDays: null,
                            confidence: 0,
                        },
                        windowDays: traits?.windowDays || prev?.windowDays || 45,
                        experiments: payload.experiments ?? payload.model?.experiments ?? null,
                        history: traits?.history || prev?.history || [],
                        activeCoach: payload.model?.activeCoach ?? payload.activeCoach ?? prev?.activeCoach ?? null,
                        trajectory: payload.model?.trajectory ?? prev?.trajectory ?? null,
                    }));
                } else {
                    await loadBrainMap();
                }
            }
        } catch (e) {
            console.error(e);
        }
        setExperimentBusy(false);
    };

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

    const { focusScore, entropy, consistency, archetype, goalAlignment, insights, sessions, adaptiveContext } = data || {} as Partial<FullAnalysis>;
    const profile = data?.profile || {};
    const hourly = data?.hourly || [];
    const maxH = Math.max(...hourly.map(h => h.total || 0), 1);

    // ── Severity Helpers ──
    const sCol = (s: string) => s === 'positive' ? '#22c55e' : s === 'warning' ? '#eab308' : s === 'critical' ? '#ef4444' : '#3b82f6';
    const sIcon = (s: string) => s === 'positive' ? '✅' : s === 'warning' ? '⚠️' : s === 'critical' ? '🚨' : '💡';
    const toneColor = (tone?: AdaptiveInsightsContext['insightTone']) =>
        tone === 'urgent' ? '#ef4444' : tone === 'gentle' ? '#22c55e' : tone === 'reflective' ? '#a855f7' : '#3b82f6';
    const modeLabel = adaptiveContext?.mode?.replace(/_/g, ' ') || 'learning';

    return (
        <div style={{ padding: 32, maxWidth: 1200, margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
                <div>
                    <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>🧠 Brain Map</h1>
                    <p style={{ color: '#8888a0', marginTop: 4 }}>
                        {brainMap?.summary
                            || adaptiveContext?.lensSummary
                            || 'How, why, and when your brain works — pressure wiring first, then rewiring'}
                    </p>
                </div>
                <button onClick={runAnalysis} disabled={isAnalyzing}
                    style={{ padding: '10px 20px', background: isAnalyzing ? '#333' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', border: 'none', borderRadius: 10, color: 'white', fontWeight: 600, cursor: isAnalyzing ? 'wait' : 'pointer', fontSize: 14 }}>
                    {isAnalyzing ? '🔄 Analyzing...' : '⚡ Run Personal Analysis'}
                </button>
            </div>

            {brainMap && (
                <div
                    data-testid="brain-map"
                    className="card"
                    style={{
                    padding: 20,
                    marginBottom: 24,
                    borderLeft: '4px solid #f59e0b',
                    background: 'linear-gradient(135deg, rgba(245,158,11,0.06), rgba(102,126,234,0.05))',
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
                        <div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                                Cognitive Self-Map · {brainMap.windowDays}d window
                            </div>
                            <h2 style={{ margin: '6px 0 8px', fontWeight: 800, fontSize: 18 }}>Pressure profile</h2>
                            <p style={{ margin: 0, color: '#c0c0d0', fontSize: 13, lineHeight: 1.65, maxWidth: 720 }}>
                                {brainMap.summary}
                            </p>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(110px, 1fr))', gap: 8, minWidth: 260 }}>
                            <PressureMetric
                                label="PDI"
                                value={brainMap.pressureProfile.pressureDependency == null
                                    ? '—'
                                    : `${Math.round(brainMap.pressureProfile.pressureDependency * 100)}`}
                                hint="Pressure dependency"
                                hot={(brainMap.pressureProfile.pressureDependency ?? 0) >= 0.55}
                            />
                            <PressureMetric
                                label="Voluntary"
                                value={brainMap.pressureProfile.voluntaryStartRate == null
                                    ? '—'
                                    : `${Math.round(brainMap.pressureProfile.voluntaryStartRate * 100)}%`}
                                hint="Non-crisis starts"
                                hot={(brainMap.pressureProfile.voluntaryStartRate ?? 1) < 0.4}
                            />
                            <PressureMetric
                                label="Activation"
                                value={brainMap.pressureProfile.activationEnergyDays == null
                                    ? '—'
                                    : `${brainMap.pressureProfile.activationEnergyDays.toFixed(1)}d`}
                                hint="Create → first focus"
                            />
                            <PressureMetric
                                label="Crisis Δ"
                                value={brainMap.pressureProfile.crisisBonus == null
                                    ? '—'
                                    : `${brainMap.pressureProfile.crisisBonus > 0 ? '+' : ''}${Math.round(brainMap.pressureProfile.crisisBonus)}`}
                                hint="Focus pts near deadline"
                                hot={(brainMap.pressureProfile.crisisBonus ?? 0) >= 8}
                            />
                        </div>
                    </div>

                    {(brainMap.history.length >= 2 || brainMap.trajectory) && (
                        <div
                            data-testid="brain-map-trajectory"
                            style={{
                            marginBottom: 16,
                            padding: 12,
                            borderRadius: 10,
                            background: 'rgba(18,18,26,0.65)',
                            border: '1px solid rgba(255,255,255,0.05)',
                        }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#8888a0', marginBottom: 8, textTransform: 'uppercase' }}>
                                Trajectory · {brainMap.history.length} daily · {brainMap.trajectory?.weeks?.length ?? 0} week bucket(s)
                            </div>
                            {brainMap.trajectory?.headline && (
                                <p style={{ margin: '0 0 10px', fontSize: 12, color: '#c0c0d0', lineHeight: 1.55 }}>
                                    {brainMap.trajectory.headline}
                                </p>
                            )}
                            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                                <MiniSpark
                                    label="PDI"
                                    values={brainMap.history.map(h => h.pressureDependency)}
                                    invertGood
                                />
                                <MiniSpark
                                    label="Voluntary"
                                    values={brainMap.history.map(h => h.voluntaryStartRate)}
                                />
                            </div>
                            {brainMap.trajectory && brainMap.trajectory.weeks.length > 0 && (
                                <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
                                    {brainMap.trajectory.weeks.slice(-4).map(week => (
                                        <div key={week.weekStart} style={{ fontSize: 11, color: '#8888a0' }}>
                                            {week.weekStart}: PDI {week.avgPressureDependency == null ? '—' : Math.round(week.avgPressureDependency * 100)}
                                            {' · '}vol {week.avgVoluntaryStartRate == null ? '—' : `${Math.round(week.avgVoluntaryStartRate * 100)}%`}
                                            {' · '}{week.sampleDays}d
                                            {' · '}PDI {week.pressureTrend} / vol {week.voluntaryTrend}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, marginBottom: brainMap.hypotheses.length ? 16 : 0 }}>
                        {brainMap.traits.map(trait => {
                            const open = expandedTrait === trait.id;
                            return (
                                <div
                                    key={trait.id}
                                    data-testid={`trait-card-${trait.id}`}
                                    style={{
                                    padding: 14,
                                    borderRadius: 10,
                                    background: 'rgba(18,18,26,0.85)',
                                    border: `1px solid ${stanceBorder(trait.userStance)}`,
                                }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
                                        <div style={{ fontSize: 12, fontWeight: 700, color: '#e8e8f0' }}>{trait.label}</div>
                                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                            {trait.trend && trait.trend !== 'unknown' && (
                                                <span style={{
                                                    fontSize: 10,
                                                    fontWeight: 700,
                                                    color: trait.trend === 'improving' ? '#22c55e' : trait.trend === 'worsening' ? '#ef4444' : '#8888a0',
                                                    textTransform: 'uppercase',
                                                }}>
                                                    {trait.trend === 'improving' ? '↑' : trait.trend === 'worsening' ? '↓' : '→'} {trait.trend}
                                                </span>
                                            )}
                                            <span
                                                data-testid={`trait-stance-${trait.id}`}
                                                style={{ fontSize: 10, fontWeight: 700, color: stanceColor(trait.userStance), textTransform: 'uppercase' }}
                                            >
                                                {trait.userStance}
                                            </span>
                                        </div>
                                    </div>
                                    <div style={{ fontSize: 12, color: '#c0c0d0', lineHeight: 1.5, marginBottom: 8 }}>{trait.valueLabel}</div>
                                    <div style={{ fontSize: 11, color: '#8888a0', marginBottom: 10 }}>
                                        conf {Math.round(trait.confidence * 100)}% · n={trait.sampleSize}
                                    </div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                                        {(['confirmed', 'disputed', 'aspirational'] as const).map(stance => (
                                            <button
                                                key={stance}
                                                data-testid={`trait-${stance}-${trait.id}`}
                                                disabled={stanceBusy === `${trait.id}:${stance}`}
                                                onClick={() => void setTraitStance(trait.id, trait.userStance === stance ? 'observed' : stance)}
                                                style={{
                                                    fontSize: 10,
                                                    fontWeight: 700,
                                                    border: 'none',
                                                    borderRadius: 6,
                                                    padding: '4px 8px',
                                                    cursor: 'pointer',
                                                    background: trait.userStance === stance ? stanceColor(stance) : 'rgba(255,255,255,0.06)',
                                                    color: trait.userStance === stance ? '#0b0b12' : '#c0c0d0',
                                                }}
                                            >
                                                {stance === 'confirmed' ? 'Confirm' : stance === 'disputed' ? 'Dispute' : 'Aspire'}
                                            </button>
                                        ))}
                                        <button
                                            data-testid={`trait-evidence-${trait.id}`}
                                            onClick={() => setExpandedTrait(open ? null : trait.id)}
                                            style={{
                                                fontSize: 10,
                                                fontWeight: 700,
                                                border: 'none',
                                                borderRadius: 6,
                                                padding: '4px 8px',
                                                cursor: 'pointer',
                                                background: 'rgba(102,126,234,0.15)',
                                                color: '#a5b4fc',
                                            }}
                                        >
                                            {open ? 'Hide evidence' : 'Evidence'}
                                        </button>
                                    </div>
                                    {open && (
                                        <div style={{ fontSize: 11, color: '#a0a0b8', lineHeight: 1.55 }}>
                                            {trait.evidence.slice(0, 4).map((ev, i) => (
                                                <div key={i} style={{ marginBottom: 4 }}>· {ev.detail}</div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {brainMap.activeCoach && (
                        <div
                            data-testid="active-coach-panel"
                            style={{
                                padding: 14,
                                borderRadius: 10,
                                marginBottom: 16,
                                background: brainMap.activeCoach.enabled
                                    ? 'rgba(34,197,94,0.08)'
                                    : 'rgba(18,18,26,0.75)',
                                border: `1px solid ${brainMap.activeCoach.enabled ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.08)'}`,
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
                                <div style={{ fontSize: 11, fontWeight: 700, color: brainMap.activeCoach.enabled ? '#4ade80' : '#8888a0', textTransform: 'uppercase' }}>
                                    Active coach · {brainMap.activeCoach.mapTrust.trusted ? (brainMap.activeCoach.suppressRewiring ? 'trusted · deadline protect' : brainMap.activeCoach.enabled ? 'auto-rewiring' : 'trusted · idle') : 'awaiting map trust'}
                                </div>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <button
                                        data-testid="active-coach-on"
                                        disabled={experimentBusy || brainMap.activeCoach.mode === 'auto'}
                                        onClick={() => void setCoachMode('auto')}
                                        style={hypButtonStyle(brainMap.activeCoach.mode === 'auto' ? '#22c55e' : '#8888a0')}
                                    >
                                        Auto
                                    </button>
                                    <button
                                        data-testid="active-coach-off"
                                        disabled={experimentBusy || brainMap.activeCoach.mode === 'off'}
                                        onClick={() => void setCoachMode('off')}
                                        style={hypButtonStyle(brainMap.activeCoach.mode === 'off' ? '#ef4444' : '#8888a0')}
                                    >
                                        Off
                                    </button>
                                </div>
                            </div>
                            <div style={{ fontSize: 12, color: '#c0c0d0', lineHeight: 1.55 }}>
                                {brainMap.activeCoach.coachGuidance}
                            </div>
                            {brainMap.activeCoach.mapTrust.trusted && (
                                <div style={{ fontSize: 11, color: '#8888a0', marginTop: 8 }}>
                                    Trust: {brainMap.activeCoach.mapTrust.reason}
                                    {brainMap.activeCoach.activationBlocks ? ' · activation blocks on' : ''}
                                    {brainMap.activeCoach.earlyCommitmentBoost ? ' · early commitment on' : ''}
                                    {brainMap.activeCoach.voluntaryRewardBias > 0 ? ' · voluntary reward bias on' : ''}
                                </div>
                            )}
                        </div>
                    )}

                    {(brainMap.experiments?.offered || brainMap.experiments?.active) && (
                        <div
                            data-testid="brain-map-experiment"
                            style={{
                            padding: 14,
                            borderRadius: 10,
                            marginBottom: 16,
                            background: 'rgba(18,18,26,0.75)',
                            border: '1px solid rgba(245,158,11,0.35)',
                        }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24', marginBottom: 8, textTransform: 'uppercase' }}>
                                Light experiment · map-first rewiring
                            </div>
                            {brainMap.experiments.active && (
                                <div style={{ marginBottom: brainMap.experiments.offered ? 14 : 0 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: '#e8e8f0' }}>
                                        Active: {brainMap.experiments.active.title}
                                    </div>
                                    <div style={{ fontSize: 12, color: '#c0c0d0', lineHeight: 1.55, margin: '6px 0' }}>
                                        {brainMap.experiments.active.rationale}
                                    </div>
                                    {brainMap.experiments.active.suggestedTaskTitle && (
                                        <div style={{ fontSize: 11, color: '#8888a0', marginBottom: 8 }}>
                                            Target: {brainMap.experiments.active.suggestedTaskTitle}
                                            {brainMap.experiments.active.syntheticDueDate
                                                ? ` · synthetic due ${brainMap.experiments.active.syntheticDueDate}`
                                                : ` · ${brainMap.experiments.active.durationMinutes}m`}
                                        </div>
                                    )}
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                        <button
                                            disabled={experimentBusy}
                                            onClick={() => void respondExperiment(brainMap.experiments!.active!.id, 'completed')}
                                            style={hypButtonStyle('#22c55e')}
                                        >
                                            Mark complete
                                        </button>
                                        <button
                                            disabled={experimentBusy}
                                            onClick={() => void respondExperiment(brainMap.experiments!.active!.id, 'cancelled')}
                                            style={hypButtonStyle('#8888a0')}
                                        >
                                            Cancel experiment
                                        </button>
                                    </div>
                                </div>
                            )}
                            {brainMap.experiments.offered && (
                                <div>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: '#e8e8f0' }}>
                                        Offered: {brainMap.experiments.offered.title}
                                    </div>
                                    <div style={{ fontSize: 12, color: '#c0c0d0', lineHeight: 1.55, margin: '6px 0' }}>
                                        {brainMap.experiments.offered.rationale}
                                    </div>
                                    <div style={{ fontSize: 11, color: '#8888a0', marginBottom: 8 }}>
                                        {(brainMap.experiments.offered.traitSignals || []).join(' · ')}
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                        <button
                                            data-testid="experiment-accept"
                                            disabled={experimentBusy}
                                            onClick={() => void respondExperiment(brainMap.experiments!.offered!.id, 'accepted')}
                                            style={hypButtonStyle('#f59e0b')}
                                        >
                                            Accept experiment
                                        </button>
                                        <button
                                            data-testid="experiment-decline"
                                            disabled={experimentBusy}
                                            onClick={() => void respondExperiment(brainMap.experiments!.offered!.id, 'declined')}
                                            style={hypButtonStyle('#8888a0')}
                                        >
                                            Not now
                                        </button>
                                    </div>
                                    <div style={{ fontSize: 11, color: '#6b6b80', marginTop: 8 }}>
                                        Declining leaves planner behavior unchanged. True deadline days still use pressure as fuel.
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {brainMap.hypotheses.length > 0 && (
                        <div style={{
                            padding: 14,
                            borderRadius: 10,
                            background: 'rgba(18,18,26,0.7)',
                            border: '1px solid rgba(168,85,247,0.25)',
                        }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: '#c084fc', marginBottom: 8, textTransform: 'uppercase' }}>
                                Open hypotheses — confirm what feels true
                            </div>
                            {brainMap.hypotheses.map(hyp => (
                                <div key={hyp.id} style={{ marginBottom: 12 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: '#e8e8f0', marginBottom: 4 }}>{hyp.claim}</div>
                                    <div style={{ fontSize: 12, color: '#8888a0', marginBottom: 6 }}>{hyp.why}</div>
                                    <div style={{ fontSize: 11, color: '#a0a0b8', marginBottom: 8 }}>{hyp.actionHint}</div>
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                        <button
                                            disabled={!!stanceBusy}
                                            onClick={() => void setTraitStance(hyp.traitId, 'confirmed')}
                                            style={hypButtonStyle('#22c55e')}
                                        >
                                            That&apos;s me
                                        </button>
                                        <button
                                            disabled={!!stanceBusy}
                                            onClick={() => void setTraitStance(hyp.traitId, 'disputed')}
                                            style={hypButtonStyle('#ef4444')}
                                        >
                                            Not quite
                                        </button>
                                        <button
                                            disabled={!!stanceBusy}
                                            onClick={() => void setTraitStance(hyp.traitId, 'aspirational')}
                                            style={hypButtonStyle('#a855f7')}
                                        >
                                            I want to change this
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {adaptiveContext && (
                <div className="card" style={{
                    padding: 18,
                    marginBottom: 24,
                    borderLeft: `4px solid ${toneColor(adaptiveContext.insightTone)}`,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: 18,
                }}>
                    <div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
                            <span style={{
                                fontSize: 11,
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                color: toneColor(adaptiveContext.insightTone),
                                background: `${toneColor(adaptiveContext.insightTone)}18`,
                                padding: '3px 8px',
                                borderRadius: 4,
                            }}>
                                {modeLabel}
                            </span>
                            <span style={{ fontSize: 11, color: '#8888a0' }}>
                                {adaptiveContext.energy} energy · {adaptiveContext.mood || 'unknown'} mood · {adaptiveContext.focusTrend} focus
                            </span>
                        </div>
                        <h2 style={{ margin: '0 0 6px', fontWeight: 800, fontSize: 18 }}>{adaptiveContext.lensTitle}</h2>
                        <p style={{ margin: '0 0 10px', color: '#c0c0d0', fontSize: 13, lineHeight: 1.6 }}>{adaptiveContext.guidance}</p>
                        <p style={{ margin: 0, color: '#8888a0', fontSize: 12, lineHeight: 1.6 }}>{adaptiveContext.recommendedAnalysis}</p>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, alignContent: 'start' }}>
                        <AdaptiveSignal label="Open" value={String(adaptiveContext.currentSignals.openTasks)} />
                        <AdaptiveSignal label="Overdue" value={String(adaptiveContext.currentSignals.overdueTasks)} urgent={adaptiveContext.currentSignals.overdueTasks > 0} />
                        <AdaptiveSignal label="Distraction" value={`${adaptiveContext.currentSignals.recentDistractionMinutes}m`} urgent={adaptiveContext.currentSignals.recentDistractionMinutes >= 30} />
                        <AdaptiveSignal label="Alerts" value={adaptiveContext.alertFatigueLevel} urgent={adaptiveContext.alertFatigueLevel === 'high'} />
                        <div style={{ gridColumn: '1 / -1', fontSize: 11, color: '#8888a0', paddingTop: 4 }}>
                            Next focus window: {adaptiveContext.nextBestFocusWindow || 'still learning'}
                        </div>
                    </div>
                </div>
            )}

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
                            color={goalAlignment?.alignmentScore ? scoreColor(goalAlignment.alignmentScore) : '#eab308'} icon="🎯"
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
                                            background: d.total === 0 ? '#1a1a2e' : productivityRatioColor(ratio),
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
                        <DomainList
                            title="🟢 Top Productive"
                            domains={data?.topProductive || []}
                            color="#22c55e"
                            emptyLabel={buildDomainEmptyCopy('productive', adaptiveContext)}
                        />
                        <DomainList
                            title="🔴 Top Distractions"
                            domains={data?.topDistraction || []}
                            color="#ef4444"
                            emptyLabel={buildDomainEmptyCopy('distraction', adaptiveContext)}
                        />
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
                            <div style={{ textAlign: 'center', padding: 24, color: '#8888a0' }}>
                                {buildNoSessionsCopy(adaptiveContext)}
                            </div>
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
                            <div style={{ fontSize: 48, fontWeight: 800, color: scoreColor(consistency.overallScore) }}>
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
                                        <span style={{ fontSize: 12, fontWeight: 700, color: scoreColor(dim.score) }}>
                                            {dim.score}/100
                                        </span>
                                    </div>
                                    <div style={{ height: 6, background: '#12121a', borderRadius: 3, overflow: 'hidden' }}>
                                        <div style={{
                                            width: `${dim.score}%`, height: '100%', borderRadius: 3, transition: 'width 0.5s ease',
                                            background: scoreColor(dim.score)
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
                                        placeholder={buildGoalNamePlaceholder(adaptiveContext)} className="input"
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
                                        placeholder={buildGoalTargetPlaceholder(newGoal.metric, adaptiveContext)} style={{ width: '100%', padding: 8, background: '#12121a', border: '1px solid #2a2a40', borderRadius: 6, color: '#f0f0f5', fontSize: 13 }} />
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
                                    {adaptiveContext && (
                                        <p style={{ margin: '0 0 8px', color: toneColor(adaptiveContext.insightTone), fontSize: 11 }}>
                                            Read through the {modeLabel} lens: {adaptiveContext.interpretationRules[0]}
                                        </p>
                                    )}
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

function stanceColor(stance: string): string {
    if (stance === 'confirmed') return '#22c55e';
    if (stance === 'disputed') return '#ef4444';
    if (stance === 'aspirational') return '#a855f7';
    return '#8888a0';
}

function stanceBorder(stance: string): string {
    if (stance === 'confirmed') return 'rgba(34,197,94,0.35)';
    if (stance === 'disputed') return 'rgba(239,68,68,0.35)';
    if (stance === 'aspirational') return 'rgba(168,85,247,0.35)';
    return 'rgba(255,255,255,0.06)';
}

function hypButtonStyle(color: string): Record<string, string | number> {
    return {
        fontSize: 11,
        fontWeight: 700,
        border: 'none',
        borderRadius: 6,
        padding: '5px 10px',
        cursor: 'pointer',
        background: `${color}22`,
        color,
    };
}

function PressureMetric({ label, value, hint, hot = false }: { label: string; value: string; hint: string; hot?: boolean }) {
    return (
        <div style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: hot ? 'rgba(239,68,68,0.08)' : 'rgba(18,18,26,0.9)',
            border: hot ? '1px solid rgba(239,68,68,0.25)' : '1px solid rgba(255,255,255,0.05)',
        }}>
            <div style={{ fontSize: 10, color: '#8888a0', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: hot ? '#fca5a5' : '#e8e8f0', marginTop: 2 }}>{value}</div>
            <div style={{ fontSize: 10, color: '#6b6b80', marginTop: 2 }}>{hint}</div>
        </div>
    );
}

function MiniSpark({
    label,
    values,
    invertGood = false,
}: {
    label: string;
    values: Array<number | null>;
    invertGood?: boolean;
}) {
    const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
    if (nums.length < 2) return null;
    const max = Math.max(...nums, 0.01);
    const first = nums[0];
    const last = nums[nums.length - 1];
    const rising = last > first + 0.02;
    const falling = last < first - 0.02;
    const good = invertGood ? falling : rising;
    const bad = invertGood ? rising : falling;
    return (
        <div style={{ minWidth: 140 }}>
            <div style={{ fontSize: 10, color: '#8888a0', fontWeight: 700, marginBottom: 6 }}>{label}</div>
            <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', height: 36 }}>
                {nums.map((v, i) => (
                    <div
                        key={i}
                        title={String(v)}
                        style={{
                            width: 8,
                            height: `${Math.max(8, (v / max) * 36)}px`,
                            borderRadius: 2,
                            background: i === nums.length - 1
                                ? (bad ? '#ef4444' : good ? '#22c55e' : '#667eea')
                                : 'rgba(102,126,234,0.45)',
                        }}
                    />
                ))}
            </div>
            <div style={{ fontSize: 10, color: '#6b6b80', marginTop: 4 }}>
                {Math.round(first * 100)} → {Math.round(last * 100)}
            </div>
        </div>
    );
}

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

function AdaptiveSignal({ label, value, urgent = false }: { label: string; value: string; urgent?: boolean }) {
    return (
        <div style={{ padding: 10, background: '#12121a', borderRadius: 8 }}>
            <div style={{ fontSize: 10, color: '#8888a0', marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: urgent ? '#ef4444' : '#e0e0f0', textTransform: 'capitalize' }}>{value}</div>
        </div>
    );
}

function DomainList({ title, domains, color, emptyLabel = 'No data yet.' }: { title: string; domains: { domain: string; mins: number }[]; color: string; emptyLabel?: string }) {
    return (
        <div className="card" style={{ padding: 20 }}>
            <h3 style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 16, color }}>{title}</h3>
            {domains.length > 0 ? domains.slice(0, 8).map((d, i) => (
                <div key={d.domain} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: i < Math.min(domains.length, 8) - 1 ? '1px solid #1a1a2e' : 'none' }}>
                    <span style={{ fontSize: 12, color: '#8888a0', width: 20 }}>#{i + 1}</span>
                    <span style={{ flex: 1, fontSize: 13 }}>{d.domain}</span>
                    <span style={{ fontSize: 12, color, fontWeight: 600 }}>{d.mins}m</span>
                </div>
            )) : <div style={{ color: '#8888a0', fontSize: 13 }}>{emptyLabel}</div>}
        </div>
    );
}
