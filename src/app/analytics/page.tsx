'use client';

import { useEffect, useState } from 'react';

interface WeekTrendDay {
    date: string;
    xp_earned: number | null;
    productive_minutes: number | null;
    distraction_minutes: number | null;
}

interface TopDomain {
    domain: string;
    minutes: number;
    category: 'productive' | 'distraction' | 'neutral' | string;
}

interface Insight {
    id: number;
    insight: string;
    type: string;
    created_at: string;
}

interface AnalyticsPolicyDay {
    date: string;
    posture: 'stretch' | 'steady' | 'minimum' | 'recovery';
    productiveTargetMinutes: number;
    distractionBudgetMinutes: number;
    productivityRatio: number;
    capacityFit: 'above_capacity' | 'on_track' | 'under_capacity' | 'insufficient_signal';
    reason: string;
}

interface AnalyticsPolicy {
    mode: string;
    lensTitle: string;
    lensSummary: string;
    primaryMetric: string;
    productiveTargetMinutes: number;
    distractionBudgetMinutes: number;
    xpBaseline: number;
    plannedFocus: {
        plannedToday: number;
        completedToday: number;
        skippedToday: number;
        nextTitle: string | null;
        nextMinutes: number | null;
        recentFollowThroughRate: number | null;
    };
    analysisWindowDays: number;
    days: AnalyticsPolicyDay[];
}

interface AnalyticsPersonalization {
    mode: string;
    guidance: string;
    energy: 'high' | 'medium' | 'low';
    mood: 'high' | 'medium' | 'low' | null;
    standupGoal: string | null;
    nextBestFocusWindow: string;
    plannedFocus: {
        nextTitle: string | null;
        nextMinutes: number | null;
        recentFollowThroughRate: number | null;
    };
}

const FIT_LABEL: Record<AnalyticsPolicyDay['capacityFit'], string> = {
    above_capacity: 'above capacity',
    on_track: 'on track',
    under_capacity: 'under capacity',
    insufficient_signal: 'learning',
};

const FIT_COLOR: Record<AnalyticsPolicyDay['capacityFit'], string> = {
    above_capacity: 'var(--accent-green)',
    on_track: 'var(--accent-blue)',
    under_capacity: 'var(--accent-orange)',
    insufficient_signal: 'var(--text-muted)',
};

function formatMinutes(minutes: number): string {
    return minutes < 60 ? `${Math.round(minutes)}m` : `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
}

function buildInsightEmptyMessage(policy: AnalyticsPolicy | null, personalization: AnalyticsPersonalization | null): string {
    if (!policy) {
        if (personalization?.plannedFocus.nextTitle) return `No deep insights yet. Run analysis after ${personalization.plannedFocus.nextTitle} has outcome data.`;
        if (personalization?.standupGoal) return `No deep insights yet. Track one block for today's stated goal: ${personalization.standupGoal}.`;
        if (personalization?.mode === 'recovery' || personalization?.energy === 'low' || personalization?.mood === 'low') return 'No deep insights yet. Sleep, mood, and one low-pressure block will give today useful signal.';
        return 'No deep insights yet. Run analysis after tracking a few sessions, habits, and reflections.';
    }
    if (policy.mode === 'recovery') return 'No recovery patterns yet. Run analysis after logging sleep, mood, and one low-pressure focus block.';
    if (policy.mode === 'deadline_pressure') return 'No deadline-relief patterns yet. Run analysis after a pressure block and session feedback.';
    if (policy.mode === 'planning') return 'No tomorrow-setup patterns yet. Run analysis after an evening check-in and next-day plan.';
    if (policy.plannedFocus.nextTitle) return `No deep insights yet. Run analysis after planned focus on ${policy.plannedFocus.nextTitle} resolves.`;
    return `No deep insights yet. Run analysis when ${policy.lensTitle.toLowerCase()} has enough recent signal.`;
}

function buildTrendEmptyMessage(policy: AnalyticsPolicy | null, personalization: AnalyticsPersonalization | null): string {
    if (!policy) {
        if (personalization?.plannedFocus.nextTitle) return `No tracked activity yet. Start ${personalization.plannedFocus.nextTitle} so plan and actual work can be compared.`;
        if (personalization?.nextBestFocusWindow) return `No tracked activity yet. Seed the baseline during ${personalization.nextBestFocusWindow}.`;
        return 'No tracked activity yet. Start a focus session or enable activity tracking.';
    }
    if (policy.mode === 'recovery') return `No tracked activity yet. Even ${formatMinutes(policy.productiveTargetMinutes)} of recovery-safe work will calibrate today.`;
    if (policy.mode === 'deadline_pressure') return `No tracked activity yet. Capture the first deadline-relief block against a ${formatMinutes(policy.productiveTargetMinutes)} target.`;
    if (policy.mode === 'planning') return 'No tracked activity yet. Generate tomorrow blocks so analytics can compare plan vs follow-through.';
    return `No tracked activity yet. The current learned target is ${formatMinutes(policy.productiveTargetMinutes)} productive.`;
}

function buildXpEmptyMessage(policy: AnalyticsPolicy | null, personalization: AnalyticsPersonalization | null): string {
    if (!policy) {
        if (personalization?.mode === 'planning') return 'No XP signal yet. Generate tomorrow blocks so XP can measure plan follow-through.';
        if (personalization?.mode === 'recovery' || personalization?.energy === 'low' || personalization?.mood === 'low') return 'No XP signal yet. A minimum recovery-safe block is enough to seed today.';
        return 'No XP signal yet. Complete a time-based task, session, or habit to seed the baseline.';
    }
    if (policy.xpBaseline > 0) return `No XP in this window yet. Your recent baseline is ${policy.xpBaseline} XP.`;
    if (policy.mode === 'recovery') return 'No XP signal yet. A minimum habit or short recovery-safe block is enough to seed today.';
    return 'No XP signal yet. Complete one time-based task or planned focus block to establish the baseline.';
}

function buildDomainEmptyMessage(policy: AnalyticsPolicy | null, personalization: AnalyticsPersonalization | null): string {
    if (!policy) {
        if (personalization?.plannedFocus.nextTitle) return `No site signal yet. Track ${personalization.plannedFocus.nextTitle} so useful and drifting domains can be separated.`;
        if (personalization?.mode === 'deadline_pressure') return 'No site signal yet. Track the pressure block before optional browsing.';
        return 'No site signal yet. Enable tracking or start a Guardian session.';
    }
    if (policy.mode === 'protect_focus') return 'No site signal yet. Start the protected focus block so interruptions can be measured.';
    if (policy.mode === 'deadline_pressure') return 'No site signal yet. Track the deadline block so useful and drifting domains can be separated.';
    if (policy.mode === 'planning') return 'No site signal yet. Tomorrow planning needs calendar, notes, or research activity to compare.';
    return `No site signal yet. Analytics will compare domains against a ${formatMinutes(policy.distractionBudgetMinutes)} distraction budget.`;
}

export default function AnalyticsPage() {
    const [weekData, setWeekData] = useState<WeekTrendDay[]>([]);
    const [topDomains, setTopDomains] = useState<TopDomain[]>([]);
    const [insights, setInsights] = useState<Insight[]>([]);
    const [analyticsPolicy, setAnalyticsPolicy] = useState<AnalyticsPolicy | null>(null);
    const [personalization, setPersonalization] = useState<AnalyticsPersonalization | null>(null);
    const [generating, setGenerating] = useState(false);

    useEffect(() => {
        fetch('/api/dashboard')
            .then(r => r.json())
            .then(data => {
                setWeekData(data.weekTrend || []);
                setTopDomains(data.today?.topDomains || []);
                setAnalyticsPolicy(data.intelligence?.analyticsPolicy || null);
                setPersonalization(data.personalization || null);
            });

        fetch('/api/analytics/insights')
            .then(r => r.json())
            .then(data => setInsights(data.insights || []));
    }, []);

    const generateInsights = async () => {
        setGenerating(true);
        try {
            await fetch('/api/analytics/insights', { method: 'POST' });
            const res = await fetch('/api/analytics/insights');
            const data = await res.json();
            setInsights(data.insights || []);
        } catch (e) {
            console.error(e);
        } finally {
            setGenerating(false);
        }
    };

    const maxMinutes = Math.max(...weekData.map(d => (d.productive_minutes || 0) + (d.distraction_minutes || 0)), 1);
    const policyByDate = new Map((analyticsPolicy?.days || []).map(day => [day.date, day]));

    return (
        <div className="max-w-[1000px] mx-auto animate-fade-in">
            <h1 className="text-2xl font-bold mb-1">Analytics 📈</h1>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
                {analyticsPolicy ? analyticsPolicy.lensSummary : 'Your productivity trends and insights'}
            </p>

            {analyticsPolicy && (
                <section className="card mb-6" style={{ padding: '1rem 1.25rem', border: '1px solid rgba(255,255,255,0.08)' }}>
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                        <div>
                            <h2 className="text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--accent-blue)' }}>
                                {analyticsPolicy.lensTitle}
                            </h2>
                            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                                {analyticsPolicy.mode.replace('_', ' ')} · {analyticsPolicy.primaryMetric.replace('_', ' ')}
                            </p>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                            <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-secondary)' }}>
                                <div className="text-[10px] uppercase font-bold" style={{ color: 'var(--text-muted)' }}>Target</div>
                                <div className="text-sm font-bold">{formatMinutes(analyticsPolicy.productiveTargetMinutes)}</div>
                            </div>
                            <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-secondary)' }}>
                                <div className="text-[10px] uppercase font-bold" style={{ color: 'var(--text-muted)' }}>Budget</div>
                                <div className="text-sm font-bold">{formatMinutes(analyticsPolicy.distractionBudgetMinutes)}</div>
                            </div>
                            <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-secondary)' }}>
                                <div className="text-[10px] uppercase font-bold" style={{ color: 'var(--text-muted)' }}>XP base</div>
                                <div className="text-sm font-bold">{analyticsPolicy.xpBaseline || 'learning'}</div>
                            </div>
                            {analyticsPolicy.plannedFocus.plannedToday > 0 && (
                                <div className="rounded-lg px-3 py-2" style={{ background: 'var(--bg-secondary)' }}>
                                    <div className="text-[10px] uppercase font-bold" style={{ color: 'var(--text-muted)' }}>Plan</div>
                                    <div className="text-sm font-bold">
                                        {analyticsPolicy.plannedFocus.completedToday}/{analyticsPolicy.plannedFocus.plannedToday}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                    {analyticsPolicy.plannedFocus.nextTitle && (
                        <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
                            Next planned focus: {analyticsPolicy.plannedFocus.nextTitle}
                            {analyticsPolicy.plannedFocus.nextMinutes ? ` · ${formatMinutes(analyticsPolicy.plannedFocus.nextMinutes)}` : ''}
                            {analyticsPolicy.plannedFocus.recentFollowThroughRate !== null
                                ? ` · ${Math.round(analyticsPolicy.plannedFocus.recentFollowThroughRate * 100)}% recent follow-through`
                                : ''}
                        </p>
                    )}
                </section>
            )}

            {/* AI Hidden Patterns */}
            <div className="card mb-6" style={{ padding: '1.5rem', border: '2px solid var(--accent-purple)' }}>
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-bold uppercase tracking-wider" style={{ color: 'var(--accent-purple)' }}>🧠 Hidden Pattern Analysis</h3>
                    <button
                        onClick={generateInsights}
                        disabled={generating}
                        className="btn btn-sm"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--accent-purple)', color: 'var(--accent-purple)' }}
                    >
                        {generating ? 'Scanning 30 days of data...' : 'Run Deep Correlation Analysis'}
                    </button>
                </div>

                {insights.length > 0 ? (
                    <div className="space-y-3">
                        {insights.map(insight => (
                            <div key={insight.id} className="p-3 rounded-xl flex items-start gap-3" style={{ background: 'var(--bg-secondary)' }}>
                                <span className="text-xl shrink-0 mt-0.5">
                                    {insight.type === 'correlation' ? '🔗' : insight.type === 'warning' ? '⚠️' : '🎉'}
                                </span>
                                <p className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>{insight.insight}</p>
                            </div>
                        ))}
                    </div>
                ) : (
                    <p className="text-sm text-center py-4 italic" style={{ color: 'var(--text-muted)' }}>
                        {buildInsightEmptyMessage(analyticsPolicy, personalization)}
                    </p>
                )}
            </div>

            {/* 7-day bar chart */}
            <div className="card mb-6">
                <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>Last 7 Days</h3>
                {weekData.length > 0 ? (
                    <div className="flex items-end gap-3 h-[200px]">
                        {weekData.map((day, i) => {
                            const pMin = day.productive_minutes || 0;
                            const dMin = day.distraction_minutes || 0;
                            const total = pMin + dMin || 1;
                            const height = ((pMin + dMin) / maxMinutes) * 180;
                            const pHeight = (pMin / total) * height;
                            const dHeight = (dMin / total) * height;
                            const policyDay = policyByDate.get(day.date);

                            return (
                                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                    <div className="flex flex-col justify-end" style={{ height: '180px' }}>
                                        <div style={{ height: `${dHeight}px`, background: 'var(--accent-red)', borderRadius: '4px 4px 0 0', minHeight: dMin > 0 ? '4px' : 0, opacity: 0.7 }} />
                                        <div style={{ height: `${pHeight}px`, background: 'var(--accent-green)', borderRadius: dMin > 0 ? '0' : '4px 4px 0 0', minHeight: pMin > 0 ? '4px' : 0 }} />
                                    </div>
                                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                        {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                                    </p>
                                    {policyDay && (
                                        <span
                                            className="text-[10px] font-bold whitespace-nowrap"
                                            title={policyDay.reason}
                                            style={{ color: FIT_COLOR[policyDay.capacityFit] }}
                                        >
                                            {FIT_LABEL[policyDay.capacityFit]}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-center py-10" style={{ color: 'var(--text-muted)' }}>{buildTrendEmptyMessage(analyticsPolicy, personalization)}</p>
                )}
                <div className="flex items-center gap-4 mt-4 justify-center">
                    <div className="flex items-center gap-2 text-xs">
                        <div className="w-3 h-3 rounded" style={{ background: 'var(--accent-green)' }} />
                        <span style={{ color: 'var(--text-muted)' }}>Productive</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                        <div className="w-3 h-3 rounded" style={{ background: 'var(--accent-red)', opacity: 0.7 }} />
                        <span style={{ color: 'var(--text-muted)' }}>Distraction</span>
                    </div>
                </div>
            </div>

            {/* XP Trend */}
            <div className="card mb-6">
                <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>XP Earned (7 Days)</h3>
                {weekData.length > 0 ? (
                    <div className="flex items-end gap-3 h-[120px]">
                        {weekData.map((day, i) => {
                            const maxXp = Math.max(...weekData.map(d => d.xp_earned || 0), 1);
                            const policyDay = policyByDate.get(day.date);
                            const baseline = analyticsPolicy?.xpBaseline || 0;
                            const xpEarned = day.xp_earned || 0;
                            const height = (xpEarned / maxXp) * 100;
                            const aboveBaseline = baseline > 0 && xpEarned >= baseline;
                            return (
                                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                    <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{xpEarned}</span>
                                    <div className="w-full flex items-end" style={{ height: '80px' }}>
                                        <div className="w-full rounded-t-md" style={{
                                            height: `${height}%`,
                                            background: aboveBaseline ? 'var(--accent-green)' : 'var(--gradient-primary)',
                                            minHeight: xpEarned > 0 ? '4px' : 0
                                        }} />
                                    </div>
                                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                        {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                                    </p>
                                    {policyDay && (
                                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {policyDay.posture}
                                        </span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-center py-10" style={{ color: 'var(--text-muted)' }}>{buildXpEmptyMessage(analyticsPolicy, personalization)}</p>
                )}
            </div>

            {/* Top Domains Table */}
            <div className="card">
                <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>Top Sites Today</h3>
                {topDomains.length > 0 ? (
                    <div className="space-y-2">
                        {topDomains.map((d, i) => {
                            const maxDomainMinutes = Math.max(...topDomains.map(x => x.minutes), 1);
                            return (
                                <div key={i} className="relative">
                                    <div className="absolute inset-0 rounded-lg opacity-10" style={{
                                        width: `${(d.minutes / maxDomainMinutes) * 100}%`,
                                        background: d.category === 'productive' ? 'var(--accent-green)' : d.category === 'distraction' ? 'var(--accent-red)' : 'var(--accent-yellow)'
                                    }} />
                                    <div className="relative flex items-center justify-between py-2 px-3">
                                        <div className="flex items-center gap-2">
                                            <div className={`timeline-dot ${d.category}`} />
                                            <span className="text-sm font-medium">{d.domain}</span>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <span className={`badge ${d.category === 'productive' ? 'badge-green' : d.category === 'distraction' ? 'badge-red' : 'badge-yellow'}`}>
                                                {d.category}
                                            </span>
                                            <span className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>
                                                {formatMinutes(d.minutes)}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-center py-10" style={{ color: 'var(--text-muted)' }}>{buildDomainEmptyMessage(analyticsPolicy, personalization)}</p>
                )}
            </div>
        </div>
    );
}
