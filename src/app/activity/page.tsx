'use client';

import { useEffect, useState } from 'react';

interface Activity {
    id: number;
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
}

interface Stats {
    total_activities: number;
    productive_minutes: number;
    distraction_minutes: number;
    neutral_minutes: number;
    total_minutes: number;
}

export default function ActivityPage() {
    const [activities, setActivities] = useState<Activity[]>([]);
    const [stats, setStats] = useState<Stats | null>(null);
    const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
    const [filter, setFilter] = useState<string>('all');

    useEffect(() => {
        fetchActivities();
    }, [date, filter]);

    const fetchActivities = async () => {
        const params = new URLSearchParams({ date, limit: '200' });
        if (filter !== 'all') params.set('category', filter);
        const res = await fetch(`/api/activity?${params}`);
        const data = await res.json();
        setActivities(data.activities || []);
        setStats(data.stats || null);
    };

    const handleCategoryChange = async (id: number, newCategory: string) => {
        try {
            const res = await fetch(`/api/activity`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, category: newCategory })
            });
            if (res.ok) {
                fetchActivities(); // Refresh to update UI and stats
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
        return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    };

    return (
        <div className="max-w-[1000px] mx-auto animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Activity Timeline 📊</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Everything you browsed, categorized by AI</p>
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
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Productive</p>
                        <p className="text-xl font-bold" style={{ color: 'var(--accent-green)' }}>{formatTime(stats.productive_minutes)}</p>
                    </div>
                    <div className="stat-card red">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Distraction</p>
                        <p className="text-xl font-bold" style={{ color: 'var(--accent-red)' }}>{formatTime(stats.distraction_minutes)}</p>
                    </div>
                    <div className="stat-card orange">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Neutral</p>
                        <p className="text-xl font-bold" style={{ color: 'var(--accent-yellow)' }}>{formatTime(stats.neutral_minutes)}</p>
                    </div>
                    <div className="stat-card blue">
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Total</p>
                        <p className="text-xl font-bold">{formatTime(stats.total_minutes)}</p>
                    </div>
                </div>
            )}

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
            </div>

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
                                        title={act.ai_classification ? JSON.parse(act.ai_classification).reasoning : 'No reasoning available'}
                                    >
                                        {act.youtube_video_id && '🎬 '}
                                        {act.title || act.url}
                                    </p>
                                    <div className="flex items-center gap-2 mt-0.5">
                                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{act.domain}</span>
                                        {act.youtube_channel && (
                                            <span className="text-xs" style={{ color: 'var(--accent-purple)' }}>📺 {act.youtube_channel}</span>
                                        )}
                                    </div>
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
                        <p className="font-medium mb-1">No activity for this date</p>
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                            Browse the web with the LifeOS extension installed to start tracking
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
