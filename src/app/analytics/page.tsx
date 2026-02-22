'use client';

import { useEffect, useState } from 'react';

export default function AnalyticsPage() {
    const [weekData, setWeekData] = useState<any[]>([]);
    const [topDomains, setTopDomains] = useState<any[]>([]);

    useEffect(() => {
        fetch('/api/dashboard')
            .then(r => r.json())
            .then(data => {
                setWeekData(data.weekTrend || []);
                setTopDomains(data.today?.topDomains || []);
            });
    }, []);

    const maxMinutes = Math.max(...weekData.map(d => (d.productive_minutes || 0) + (d.distraction_minutes || 0)), 1);

    return (
        <div className="max-w-[1000px] mx-auto animate-fade-in">
            <h1 className="text-2xl font-bold mb-1">Analytics 📈</h1>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>Your productivity trends and insights</p>

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

                            return (
                                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                    <div className="flex flex-col justify-end" style={{ height: '180px' }}>
                                        <div style={{ height: `${dHeight}px`, background: 'var(--accent-red)', borderRadius: '4px 4px 0 0', minHeight: dMin > 0 ? '4px' : 0, opacity: 0.7 }} />
                                        <div style={{ height: `${pHeight}px`, background: 'var(--accent-green)', borderRadius: dMin > 0 ? '0' : '4px 4px 0 0', minHeight: pMin > 0 ? '4px' : 0 }} />
                                    </div>
                                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                        {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                                    </p>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-center py-10" style={{ color: 'var(--text-muted)' }}>No data yet. Start tracking to see trends!</p>
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
                            const height = ((day.xp_earned || 0) / maxXp) * 100;
                            return (
                                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                                    <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{day.xp_earned || 0}</span>
                                    <div className="w-full flex items-end" style={{ height: '80px' }}>
                                        <div className="w-full rounded-t-md" style={{
                                            height: `${height}%`,
                                            background: 'var(--gradient-primary)',
                                            minHeight: day.xp_earned > 0 ? '4px' : 0
                                        }} />
                                    </div>
                                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                        {new Date(day.date).toLocaleDateString('en-US', { weekday: 'short' })}
                                    </p>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-center py-10" style={{ color: 'var(--text-muted)' }}>No data yet</p>
                )}
            </div>

            {/* Top Domains Table */}
            <div className="card">
                <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>Top Sites Today</h3>
                {topDomains.length > 0 ? (
                    <div className="space-y-2">
                        {topDomains.map((d: any, i: number) => {
                            const maxDomainMinutes = Math.max(...topDomains.map((x: any) => x.minutes), 1);
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
                                                {d.minutes < 60 ? `${Math.round(d.minutes)}m` : `${Math.floor(d.minutes / 60)}h ${Math.round(d.minutes % 60)}m`}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <p className="text-center py-10" style={{ color: 'var(--text-muted)' }}>No data yet</p>
                )}
            </div>
        </div>
    );
}
