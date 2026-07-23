'use client';

import { useEffect, useState } from 'react';

interface CalendarEvent {
    id: string;
    title: string;
    description: string;
    start_time: string;
    end_time: string;
    location: string;
}

interface CalendarPolicy {
    headline: string;
    subhead: string;
    emptyTitle: string;
    emptyMessage: string;
    emptyAction: string;
    emphasis: 'protect_focus' | 'plan_focus' | 'recover' | 'sync_calendar' | 'review';
    plannedFocus: {
        plannedToday: number;
        completedToday: number;
        skippedToday: number;
        nextTitle: string | null;
        nextMinutes: number | null;
        recentFollowThroughRate: number | null;
    };
    nextBestFocusWindow: string;
}

export default function CalendarPage() {
    const [events, setEvents] = useState<CalendarEvent[]>([]);
    const [calendarPolicy, setCalendarPolicy] = useState<CalendarPolicy | null>(null);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [view, setView] = useState<'today' | 'upcoming'>('today');

    useEffect(() => {
        loadEvents();
    }, [view]);

    const loadEvents = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/calendar?action=${view}`);
            const data = await res.json();
            setEvents(data.events || []);
            setCalendarPolicy(data.calendarPolicy || null);
        } catch { /* ignore */ }
        setLoading(false);
    };

    const syncCalendar = async () => {
        setSyncing(true);
        await fetch('/api/calendar', { method: 'POST' });
        await loadEvents();
        setSyncing(false);
    };

    const formatTime = (iso: string) => {
        try {
            const d = new Date(iso);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch { return iso; }
    };

    const formatDate = (iso: string) => {
        try {
            const d = new Date(iso);
            return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        } catch { return iso; }
    };

    const isAllDay = (event: CalendarEvent) => {
        return event.start_time.endsWith('T00:00:00') && event.end_time.endsWith('T00:00:00');
    };

    const getDuration = (start: string, end: string) => {
        const diff = new Date(end).getTime() - new Date(start).getTime();
        const mins = Math.round(diff / 60000);
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    };

    // Group events by date for upcoming view
    const groupedEvents = events.reduce((groups, event) => {
        const date = event.start_time.slice(0, 10);
        if (!groups[date]) groups[date] = [];
        groups[date].push(event);
        return groups;
    }, {} as Record<string, CalendarEvent[]>);

    const colors = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6'];
    const getColor = (i: number) => colors[i % colors.length];
    const headline = calendarPolicy?.headline ?? 'Calendar';
    const subhead = calendarPolicy?.subhead ?? 'Your schedule from Google Calendar';

    return (
        <div className="max-w-[700px] mx-auto animate-fade-in">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">{headline}</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{subhead}</p>
                </div>
                <div className="flex gap-2">
                    <button
                        className="btn"
                        onClick={syncCalendar}
                        disabled={syncing}
                        style={{ background: 'rgba(66,133,244,0.15)', border: '1px solid rgba(66,133,244,0.3)', color: '#6fb3ff', cursor: 'pointer', fontSize: 13 }}
                    >
                        {syncing ? '⏳ Syncing...' : '🔄 Sync'}
                    </button>
                </div>
            </div>

            {/* View Toggle */}
            <div className="flex gap-2 mb-6">
                <button
                    onClick={() => setView('today')}
                    className="btn"
                    style={{
                        background: view === 'today' ? 'rgba(99,102,241,0.2)' : 'transparent',
                        border: `1px solid ${view === 'today' ? 'rgba(99,102,241,0.4)' : '#1a1a2e'}`,
                        color: view === 'today' ? '#818cf8' : '#8888a0',
                        cursor: 'pointer', fontSize: 13, padding: '6px 16px', borderRadius: 8,
                    }}
                >
                    Today
                </button>
                <button
                    onClick={() => setView('upcoming')}
                    className="btn"
                    style={{
                        background: view === 'upcoming' ? 'rgba(99,102,241,0.2)' : 'transparent',
                        border: `1px solid ${view === 'upcoming' ? 'rgba(99,102,241,0.4)' : '#1a1a2e'}`,
                        color: view === 'upcoming' ? '#818cf8' : '#8888a0',
                        cursor: 'pointer', fontSize: 13, padding: '6px 16px', borderRadius: 8,
                    }}
                >
                    Next 7 Days
                </button>
            </div>

            {loading ? (
                <div style={{ padding: 48, textAlign: 'center', color: '#555570' }}>
                    <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
                    Loading events...
                </div>
            ) : events.length === 0 ? (
                <div className="card" style={{ padding: 48, textAlign: 'center', color: '#8888a0' }}>
                    <div style={{ fontSize: 48, marginBottom: 16 }}>📅</div>
                    <h3 style={{ margin: '0 0 8px', fontWeight: 700 }}>{calendarPolicy?.emptyTitle ?? 'No Events'}</h3>
                    <p style={{ fontSize: 13 }}>
                        {calendarPolicy?.emptyMessage ?? (view === 'today' ? 'Nothing scheduled today.' : 'No upcoming events.')}<br />
                        <span style={{ color: '#555570' }}>
                            {calendarPolicy?.emptyAction ?? 'Add your Google Calendar ICS URL in Settings -> Sync Calendar'}
                        </span>
                    </p>
                </div>
            ) : (
                <div className="space-y-6">
                    {Object.entries(groupedEvents).map(([date, dateEvents]) => (
                        <div key={date}>
                            {view === 'upcoming' && (
                                <h3 className="text-sm font-semibold mb-3" style={{ color: '#8888a0' }}>
                                    {formatDate(date + 'T12:00:00')}
                                </h3>
                            )}
                            <div className="space-y-3">
                                {dateEvents.map((event, i) => (
                                    <div key={event.id} className="card" style={{
                                        padding: '14px 16px',
                                        borderLeft: `3px solid ${getColor(i)}`,
                                        background: '#0d0d16',
                                    }}>
                                        <div className="flex items-start gap-3">
                                            <div style={{ minWidth: 60, textAlign: 'right' }}>
                                                {isAllDay(event) ? (
                                                    <span style={{ fontSize: 11, fontWeight: 600, color: getColor(i), background: `${getColor(i)}15`, padding: '2px 8px', borderRadius: 4 }}>
                                                        All Day
                                                    </span>
                                                ) : (
                                                    <>
                                                        <div style={{ fontSize: 14, fontWeight: 600, color: '#e0e0f0' }}>
                                                            {formatTime(event.start_time)}
                                                        </div>
                                                        <div style={{ fontSize: 10, color: '#555570' }}>
                                                            {getDuration(event.start_time, event.end_time)}
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#e0e0f0' }}>
                                                    {event.title}
                                                </h4>
                                                {event.location && (
                                                    <p style={{ margin: '4px 0 0', fontSize: 12, color: '#8888a0' }}>
                                                        📍 {event.location}
                                                    </p>
                                                )}
                                                {event.description && (
                                                    <p style={{ margin: '4px 0 0', fontSize: 11, color: '#555570', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {event.description.slice(0, 120)}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
