'use client';

import { useCallback, useEffect, useState } from 'react';

interface Activity {
    id: number | string;
    url: string;
    domain: string;
    title: string;
    category: string;
    subcategory: string;
    started_at: string;
    ended_at: string | null;
    duration_seconds: number;
    youtube_video_id: string | null;
    youtube_channel: string | null;
    ai_classification?: string;
    device_name?: string;
    session_id?: string | null;
    session?: {
        session_id: string;
        target_title: string | null;
        goal_title: string | null;
        started_at: number;
        state: string;
    } | null;
    record_type?: 'legacy' | 'guardian_interval' | 'guardian_evidence_segment';
    capture_source?: 'chrome' | 'vision' | 'idle' | 'private' | 'unverified' | 'legacy';
    counted?: number;
    score_eligible?: number;
    selection_reason?: string;
    capture_status?: string;
    app?: string;
    window_title?: string;
    engagement_state?: 'interactive' | 'passive_engaged' | 'uncertain' | 'confirmed_active' | 'inactive' | 'private' | 'disconnected';
    engagement_confidence?: number;
    confirmation_status?: string;
    provisional?: number;
    pipeline_mode?: 'shadow' | 'authoritative';
}

interface Stats {
    total_activities: number;
    productive_minutes: number;
    distraction_minutes: number;
    neutral_minutes: number;
    total_minutes: number;
}

interface ActivityPolicy {
    headline: string;
    subhead: string;
    emptyTitle: string;
    emptyMessage: string;
    primaryMetricLabel: string;
    productiveLabel: string;
    distractionLabel: string;
    neutralLabel: string;
    interpretation: string;
}

interface ActivityResponse {
    activities?: Activity[];
    stats?: Stats;
    activityPolicy?: ActivityPolicy;
    sourceSummary?: { chromeSeconds: number; visionSeconds: number; unscoredSeconds: number; unverifiedSeconds: number };
    collectorStatus?: {
        ready: boolean; reason: string; frontmostApp: string | null;
        nativeCollector?: { ready: boolean; compatible: boolean; version: string | null; minimumVersion: string };
        chromeCollector?: { detected: boolean; ready: boolean; compatible: boolean; version: string | null; minimumVersion: string; updateRequired: boolean };
        selectedSource?: string;
        updateInstructions?: string[];
    };
    diagnostics?: {
        rawEvidence?: Array<{ event_id: string; collector: string; compatible: number; late_after_watermark: number }>;
        shadowRollout?: {
            requiredAcceptedSessions: number;
            recordedSessions: number;
            acceptedSessions: number;
            eligibleForCutover: boolean;
        };
    };
}

function activityReason(act: Activity): string {
    if (act.selection_reason) return act.selection_reason;
    if (act.ai_classification) {
        try {
            const parsed = JSON.parse(act.ai_classification) as { reasoning?: unknown };
            if (typeof parsed.reasoning === 'string' && parsed.reasoning.trim()) {
                return parsed.reasoning.trim();
            }
        } catch {
            // Fall through to the contextual reason below.
        }
    }

    const subject = act.title || act.domain || act.url || 'this activity';
    const duration = act.duration_seconds > 0
        ? ` for ${Math.max(1, Math.round(act.duration_seconds / 60))}m`
        : '';
    const device = act.device_name && act.device_name !== 'Unknown Device'
        ? ` on ${act.device_name}`
        : '';
    const channel = act.youtube_channel ? ` from ${act.youtube_channel}` : '';

    return `${subject}${channel}${duration}${device} is currently treated as ${act.category}${act.subcategory ? `/${act.subcategory}` : ''} based on captured activity context.`;
}

export default function ActivityPage() {
    const [activities, setActivities] = useState<Activity[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [activityPolicy, setActivityPolicy] = useState<ActivityPolicy | null>(null);
    const [sourceSummary, setSourceSummary] = useState<NonNullable<ActivityResponse['sourceSummary']> | null>(null);
    const [collectorStatus, setCollectorStatus] = useState<NonNullable<ActivityResponse['collectorStatus']> | null>(null);
    const [diagnostics, setDiagnostics] = useState(false);
    const [diagnosticCount, setDiagnosticCount] = useState(0);
    const [shadowRollout, setShadowRollout] = useState<NonNullable<NonNullable<ActivityResponse['diagnostics']>['shadowRollout']> | null>(null);
    const [date, setDate] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
    const [filter, setFilter] = useState<string>('all');

    const loadActivities = useCallback(async (): Promise<ActivityResponse> => {
        const params = new URLSearchParams({ date, limit: '200' });
        if (diagnostics) params.set('diagnostics', 'true');
        if (filter !== 'all') params.set('category', filter);
        const res = await fetch(`/api/activity?${params}`);
        if (!res.ok) throw new Error('Could not load activity.');
        return await res.json() as ActivityResponse;
    }, [date, diagnostics, filter]);

    const applyActivities = useCallback((data: ActivityResponse) => {
        setActivities(data.activities || []);
        setStats(data.stats || null);
        setActivityPolicy(data.activityPolicy || null);
        setSourceSummary(data.sourceSummary || null);
        setCollectorStatus(data.collectorStatus || null);
        setDiagnosticCount(data.diagnostics?.rawEvidence?.length || 0);
        setShadowRollout(data.diagnostics?.shadowRollout || null);
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadActivities().then(data => {
            if (!cancelled) applyActivities(data);
        }).catch(console.error);
        return () => { cancelled = true; };
    }, [applyActivities, loadActivities]);

    const handleCategoryChange = async (id: number | string, newCategory: string) => {
        try {
            const res = await fetch(`/api/activity`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, category: newCategory })
            });
            if (res.ok) {
                applyActivities(await loadActivities());
            }
        } catch (e) {
            console.error(e);
        }
    };

    const formatTime = (mins: number) => {
        if (!mins) return '0m';
        if (mins < 60) return `${Math.round(mins)}m`;
        return `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`;
    };

    const formatTimestamp = (ts: string) => {
        return new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
    };

    const formatSessionStart = (startedAt: number) => {
        return new Date(startedAt).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
        });
    };

    return (
        <div className="max-w-[1000px] mx-auto animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">{activityPolicy?.headline ?? 'Activity Timeline'}</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        {activityPolicy?.subhead ?? 'Everything you browsed, categorized by AI'}
                    </p>
                </div>
                <input
                    type="date"
                    className="input"
                    style={{ width: 'auto' }}
                    value={date}
                    onChange={e => setDate(e.target.value)}
                />
            </div>

            {/* Stats Bar */}
            {stats && (
                <div className="grid grid-cols-4 gap-3 mb-6">
                    <div className="stat-card green">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{activityPolicy?.productiveLabel ?? 'Productive'}</p>
                        <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>{formatTime(stats.productive_minutes)}</p>
                    </div>
                    <div className="stat-card red">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{activityPolicy?.distractionLabel ?? 'Distraction'}</p>
                        <p className="text-xl font-bold" style={{ color: 'var(--accent-red)' }}>{formatTime(stats.distraction_minutes)}</p>
                    </div>
                    <div className="stat-card orange">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{activityPolicy?.neutralLabel ?? 'Neutral'}</p>
                        <p className="text-xl font-bold" style={{ color: 'var(--accent-yellow)' }}>{formatTime(stats.neutral_minutes)}</p>
                    </div>
                    <div className="stat-card blue">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{activityPolicy?.primaryMetricLabel ?? 'Total'}</p>
                        <p className="text-xl font-bold">{formatTime(stats.total_minutes)}</p>
                    </div>
                </div>
            )}

            {activityPolicy && (
                <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
                    {activityPolicy.interpretation}
                </p>
            )}

            <div className="card mb-6" style={{ padding: '18px' }}>
                <div className="flex items-center justify-between gap-3 mb-3">
                    <div>
                        <p className="text-sm font-semibold">What LifeOS captures</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Exactly one source is counted for each Guardian interval. “Active” means verified engagement, not merely keyboard or mouse input. Raw screenshots are analyzed transiently and are not retained.
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <span className={collectorStatus?.nativeCollector?.ready ? 'badge-green' : 'badge-red'} style={{ padding: '4px 8px', borderRadius: '999px', fontSize: '11px' }}>
                            Native {collectorStatus?.nativeCollector?.version || 'not detected'}
                        </span>
                        <span className={collectorStatus?.chromeCollector?.ready ? 'badge-green' : 'badge-yellow'} style={{ padding: '4px 8px', borderRadius: '999px', fontSize: '11px' }}>
                            Chrome {collectorStatus?.chromeCollector?.version || 'fallback'}
                        </span>
                    </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div style={{ padding: '12px', border: '1px solid var(--border)', borderRadius: '10px' }}>
                        <p className="text-xs font-semibold mb-1" style={{ color: '#60a5fa' }}>Chrome activity</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Active URL/domain, tab title, focused dwell, tab switches, and focus/idle state—only while Chrome is verified frontmost.
                        </p>
                        {sourceSummary && <p className="text-xs mt-2">Counted today: {formatTime(sourceSummary.chromeSeconds / 60)}</p>}
                    </div>
                    <div style={{ padding: '12px', border: '1px solid var(--border)', borderRadius: '10px' }}>
                        <p className="text-xs font-semibold mb-1" style={{ color: '#a78bfa' }}>MacBook vision client</p>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            Frontmost app/window, app dwell, and privacy-filtered task alignment—only while a non-Chrome app is frontmost.
                        </p>
                        {sourceSummary && <p className="text-xs mt-2">Counted today: {formatTime(sourceSummary.visionSeconds / 60)}</p>}
                    </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-5" style={{ color: 'var(--text-muted)' }}>
                    <span><b style={{ color: 'var(--text-primary)' }}>Interactive:</b> input or navigation</span>
                    <span><b style={{ color: 'var(--text-primary)' }}>Passive:</b> foreground media/content progress</span>
                    <span><b style={{ color: 'var(--text-primary)' }}>Uncertain:</b> asks you after 3m</span>
                    <span><b style={{ color: 'var(--text-primary)' }}>Inactive:</b> away or locked</span>
                    <span><b style={{ color: 'var(--text-primary)' }}>Private:</b> never scored</span>
                </div>
                {(collectorStatus?.updateInstructions?.length || 0) > 0 && (
                    <div className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-3 text-xs text-amber-100">
                        {collectorStatus?.updateInstructions?.join(' ')}
                    </div>
                )}
                {sourceSummary && sourceSummary.unverifiedSeconds > 0 && (
                    <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                        Unverified coverage: {formatTime(sourceSummary.unverifiedSeconds / 60)}. It was not scored.
                    </p>
                )}
            </div>

            {/* Filters */}
            <div className="flex gap-2 mb-4">
                {['all', 'productive', 'neutral', 'distraction'].map(f => (
                    <button
                        key={f}
                        className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => setFilter(f)}
                    >
                        {f === 'all' ? '🌐 All' : f === 'productive' ? '🟢 Productive' : f === 'distraction' ? '🔴 Distraction' : '🟡 Neutral'}
                    </button>
                ))}
                <button className={`btn btn-sm ${diagnostics ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setDiagnostics(value => !value)}>
                    Diagnostics {diagnostics ? `(${diagnosticCount})` : ''}
                </button>
            </div>

            {diagnostics && shadowRollout && (
                <div className="card mb-4" style={{ padding: '12px 14px' }}>
                    <p className="text-sm font-semibold">Evidence V2 shadow rollout</p>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                        {shadowRollout.acceptedSessions}/{shadowRollout.requiredAcceptedSessions} accepted sessions.
                        {shadowRollout.eligibleForCutover
                            ? ' The latest two sessions passed the overlap, gap, and compatibility gates.'
                            : ' Keep legacy scoring authoritative until two consecutive controlled sessions pass.'}
                    </p>
                </div>
            )}

            {/* Timeline */}
            <div className="card">
                {activities.length > 0 ? (
                    <div className="space-y-1">
                        {activities.map(act => (
                            <div key={act.id} className="timeline-item group">
                                <div className={`timeline-dot ${act.category}`} />
                                <div className="w-16 flex-shrink-0 text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                                    {formatTimestamp(act.started_at)}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p
                                        className="text-sm truncate font-medium cursor-help"
                                        title={activityReason(act)}
                                    >
                                        {act.youtube_video_id && '🎬 '}
                                        {act.title || act.url}
                                    </p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{act.domain}</span>
                                        {act.youtube_channel && (
                                            <span className="text-xs" style={{ color: 'var(--accent-purple)' }}>📺 {act.youtube_channel}</span>
                                        )}
                                        {act.device_name && act.device_name !== 'Unknown Device' && (
                                            <span className="text-xs ml-1" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
                                                💻 {act.device_name}
                                            </span>
                                        )}
                                        {act.capture_source && act.capture_source !== 'legacy' && (
                                            <span className="text-xs" title={act.selection_reason || ''} style={{
                                                color: act.capture_source === 'chrome' ? '#60a5fa' : act.capture_source === 'vision' ? '#a78bfa' : '#9ca3af',
                                                border: '1px solid currentColor', borderRadius: '999px', padding: '1px 6px', opacity: 0.9,
                                            }}>
                                                {act.capture_source === 'chrome'
                                                    ? 'Chrome'
                                                    : act.capture_source === 'vision' && act.subcategory === 'chrome_vision_fallback'
                                                        ? 'Vision fallback'
                                                        : act.capture_source === 'vision'
                                                            ? 'Vision'
                                                            : act.capture_source} · {act.score_eligible === 0 ? 'unscored' : 'counted'}
                                            </span>
                                            )}
                                        {act.session && (
                                            <span
                                                className="text-xs"
                                                title={`Session ${act.session.session_id}`}
                                                style={{
                                                    color: '#c4b5fd',
                                                    border: '1px solid #8b5cf633',
                                                    borderRadius: '999px',
                                                    padding: '1px 6px',
                                                }}
                                            >
                                                🎯 {act.session.target_title || 'Focus session'} · {formatSessionStart(act.session.started_at)}
                                            </span>
                                        )}
                                        {act.provisional === 1 && (
                                            <span className="text-xs badge-yellow" style={{ padding: '1px 6px', borderRadius: '999px' }}>Provisional</span>
                                        )}
                                        {act.pipeline_mode === 'shadow' && (
                                            <span className="text-xs" style={{ color: '#fbbf24' }}>Shadow · not counted</span>
                                        )}
                                        {act.engagement_state && act.engagement_state !== 'interactive' && (
                                            <span className="text-xs" style={{ color: act.engagement_state === 'uncertain' ? '#fbbf24' : act.engagement_state === 'confirmed_active' ? '#34d399' : '#9ca3af' }}>
                                                {act.engagement_state.replaceAll('_', ' ')}
                                                {typeof act.engagement_confidence === 'number' ? ` · ${Math.round(act.engagement_confidence * 100)}% evidence` : ''}
                                            </span>
                                        )}
                                    </div>
                                    {act.capture_source && act.capture_source !== 'legacy' && (
                                        <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                                            Why: {act.selection_reason || 'Selected by the Guardian source arbiter.'}
                                            {act.capture_status ? ` · Capture: ${act.capture_status.replaceAll('_', ' ')}` : ''}
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-3 flex-shrink-0">
                                    <span className="text-xs text-muted-foreground hidden sm:block">
                                        {act.subcategory}
                                    </span>
                                    <select
                                        className={`text-xs font-semibold px-2 py-1 rounded-md border-none outline-none cursor-pointer ${act.category === 'productive' ? 'badge-green' : act.category === 'distraction' ? 'badge-red' : 'badge-yellow'
                                            }`}
                                        value={act.category}
                                        onChange={(e) => handleCategoryChange(act.id, e.target.value)}
                                        title="Change category"
                                    >
                                        <option value="productive" className="bg-[#1e1e24] text-white">Productive</option>
                                        <option value="neutral" className="bg-[#1e1e24] text-white">Neutral</option>
                                        <option value="distraction" className="bg-[#1e1e24] text-white">Distraction</option>
                                    </select>
                                    <span className="text-sm font-mono w-12 text-right" style={{ color: 'var(--text-muted)' }}>
                                        {act.duration_seconds > 0 ? formatTime(Math.round(act.duration_seconds / 60)) : '—'}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="text-center py-16">
                        <div className="text-4xl mb-3">🔍</div>
                        <p className="font-medium mb-1">{activityPolicy?.emptyTitle ?? 'No activity for this date'}</p>
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                            {activityPolicy?.emptyMessage ?? 'Browse the web with the LifeOS extension installed to start tracking'}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
