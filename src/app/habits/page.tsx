'use client';

import { useEffect, useState, useRef } from 'react';
import exifr from 'exifr';

interface DayHabitHistory {
    date: string;
    habits_completed: number;
    total_habits: number;
    habit_score: number | null;
}

interface HabitBreakdownEntry {
    id: number;
    name: string;
    icon: string;
    date: string | null;
    completed: number | null;
    value: number;
}

interface Habit {
    id: number;
    name: string;
    icon: string;
    frequency: string;
    checked_today: number;
    today_value: number;
    total_checkins: number;
    goal_metric: 'boolean' | 'time';
    goal_target: number;
    current_streak: number;
    automaticity_score: number;
}

interface HeatmapDay {
    date: string;
    checkins: number;
    habits_done: number;
    total_habits: number;
}

export default function HabitsPage() {
    const [habits, setHabits] = useState<Habit[]>([]);
    const [heatmapData, setHeatmapData] = useState<HeatmapDay[]>([]);
    const [streakDates, setStreakDates] = useState<string[]>([]);
    const [showNewHabit, setShowNewHabit] = useState(false);
    const [newName, setNewName] = useState('');
    const [newIcon, setNewIcon] = useState('✅');
    const [newGoalMetric, setNewGoalMetric] = useState<'boolean' | 'time'>('boolean');
    const [newGoalTarget, setNewGoalTarget] = useState<number>(60);
    const [showHistory, setShowHistory] = useState(false);
    const [habitHistory, setHabitHistory] = useState<DayHabitHistory[]>([]);
    const [habitBreakdown, setHabitBreakdown] = useState<HabitBreakdownEntry[]>([]);

    const [proofHabitId, setProofHabitId] = useState<number | null>(null);
    const [verifying, setVerifying] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const fetchHeatmap = async () => {
        const res = await fetch('/api/habits?heatmap=true');
        const data = await res.json();
        setHeatmapData(data.heatmap || []);
    };

    const fetchHabits = async () => {
        const res = await fetch('/api/habits');
        const data = await res.json();
        setHabits(data.habits || []);
        setStreakDates(data.streakDates || []);
    };

    useEffect(() => {
        fetchHabits();
        fetchHeatmap();
    }, []);

    useEffect(() => {
        if (showHistory) fetchHistory();
    }, [showHistory]);

    const fetchHistory = async () => {
        const res = await fetch('/api/habits?history=true&days=14');
        const data = await res.json();
        setHabitHistory(data.history || []);
        setHabitBreakdown(data.habitBreakdown || []);
    };

    const toggleCheckin = async (habitId: number) => {
        await fetch('/api/habits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'checkin', habit_id: habitId }),
        });
        fetchHabits();
        fetchHeatmap();
    };

    const addHabit = async () => {
        if (!newName.trim()) return;
        await fetch('/api/habits', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: newName.trim(),
                icon: newIcon,
                goal_metric: newGoalMetric,
                goal_target: newGoalMetric === 'time' ? newGoalTarget : 1
            }),
        });
        setNewName('');
        setNewIcon('✅');
        setNewGoalMetric('boolean');
        setNewGoalTarget(60);
        setShowNewHabit(false);
        fetchHabits();
    };

    const deleteHabit = async (id: number) => {
        await fetch(`/api/habits?id=${id}`, { method: 'DELETE' });
        fetchHabits();
        fetchHeatmap();
    };

    // Calculate streak
    const calculateStreak = () => {
        if (streakDates.length === 0) return 0;
        // eslint-disable-next-line
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const sorted = [...streakDates].sort((a, b) => b.localeCompare(a));
        const diff = Math.round((new Date(today).getTime() - new Date(sorted[0]).getTime()) / 86400000);
        if (diff > 1) return 0;
        let streak = 1;
        for (let i = 0; i < sorted.length - 1; i++) {
            const d = Math.round((new Date(sorted[i]).getTime() - new Date(sorted[i + 1]).getTime()) / 86400000);
            if (d === 1) streak++;
            else break;
        }
        return streak;
    };

    const streak = calculateStreak();

    const triggerPhotoProof = (habitId: number) => {
        setProofHabitId(habitId);
        if (fileInputRef.current) fileInputRef.current.click();
    };

    const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file || !proofHabitId) return;

        setVerifying(true);
        try {
            // Extract EXIF data locally before sending
            let metadata = {};
            try {
                const exifData = await exifr.parse(file, true);
                if (exifData) {
                    metadata = {
                        latitude: exifData.latitude,
                        longitude: exifData.longitude,
                        dateTimeOriginal: exifData.DateTimeOriginal,
                        make: exifData.Make,
                    };
                }
            } catch (err) {
                console.log('No EXIF data found or parse error');
            }

            // Convert to base64
            const reader = new FileReader();
            reader.onload = async () => {
                const base64 = reader.result as string;
                const timestampDate = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

                const res = await fetch('/api/proof', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        habit_id: proofHabitId,
                        image_base64: base64,
                        metadata,
                        date: timestampDate
                    })
                });

                const data = await res.json();
                if (data.verified) {
                    alert(`✅ Verified! ${data.reason}\n\nEarned +50 Coins!`);
                    fetchHabits();
                    fetchHeatmap();
                } else {
                    alert(`❌ Rejected: ${data.reason}`);
                }
                setVerifying(false);
                setProofHabitId(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
            };
            reader.readAsDataURL(file);
        } catch (error) {
            console.error(error);
            alert('Failed to process photo proof.');
            setVerifying(false);
            setProofHabitId(null);
        }
    };

    return (
        <div className="max-w-[1000px] mx-auto animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Habits 🔥</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Every action is a vote for the person you wish to become.
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    <button
                        className="btn btn-ghost"
                        onClick={() => setShowHistory(!showHistory)}
                        style={{ fontSize: '0.85rem' }}
                    >
                        {showHistory ? '🔥 Today\'s View' : '📊 History'}
                    </button>
                    <div className="text-center">
                        <div className="text-3xl">{streak > 0 ? '🔥' : '💤'}</div>
                        <p className="text-sm font-bold">{streak} day streak</p>
                    </div>
                </div>
            </div>

            {/* Habit History Section */}
            {showHistory && (
                <div className="mb-6">
                    {/* Daily Score Chart */}
                    <div className="card mb-4" style={{ padding: '1.5rem' }}>
                        <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>
                            Habit Score — Last 14 Days
                        </h3>
                        <div className="flex items-end gap-1" style={{ height: '100px' }}>
                            {habitHistory.map(day => (
                                <div key={day.date} className="flex-1 flex flex-col items-center justify-end">
                                    <div
                                        className="w-full rounded-t"
                                        style={{
                                            height: `${Math.max(day.habit_score ?? 0, 4)} % `,
                                            background: day.habit_score !== null
                                                ? day.habit_score >= 80 ? 'var(--accent-green)'
                                                    : day.habit_score >= 50 ? 'var(--accent-yellow)'
                                                        : day.habit_score >= 25 ? 'var(--accent-orange)'
                                                            : 'var(--accent-red)'
                                                : 'var(--border)',
                                            minHeight: day.total_habits > 0 ? '4px' : '0',
                                        }}
                                    />
                                    <span className="text-xs mt-1" style={{ color: 'var(--text-muted)', fontSize: '0.6rem' }}>
                                        {new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric' })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Per-Habit Grid */}
                    {(() => {
                        const uniqueHabits = [...new Map(habitBreakdown.map(h => [h.id, { id: h.id, name: h.name, icon: h.icon }])).values()];
                        const dates = habitHistory.map(h => h.date);
                        return (
                            <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead>
                                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                            <th style={{ padding: '0.5rem 1rem', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600, position: 'sticky', left: 0, background: 'var(--bg-card)' }}>Habit</th>
                                            {dates.map(d => (
                                                <th key={d} style={{ padding: '0.5rem 0.25rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.6rem', fontWeight: 500 }}>
                                                    {new Date(d + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short' })}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {uniqueHabits.map(habit => (
                                            <tr key={habit.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                                <td style={{ padding: '0.5rem 1rem', fontSize: '0.8rem', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--bg-card)' }}>
                                                    {habit.icon} {habit.name}
                                                </td>
                                                {dates.map(d => {
                                                    const entry = habitBreakdown.find(b => b.id === habit.id && b.date === d);
                                                    const done = entry?.completed === 1;
                                                    return (
                                                        <td key={d} style={{ padding: '0.25rem', textAlign: 'center' }}>
                                                            <span style={{ fontSize: '0.85rem' }}>{entry?.date ? (done ? '✅' : '❌') : '—'}</span>
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        ))}
                                        {/* Score row */}
                                        <tr style={{ background: 'var(--bg-secondary)' }}>
                                            <td style={{ padding: '0.5rem 1rem', fontSize: '0.75rem', fontWeight: 700, position: 'sticky', left: 0, background: 'var(--bg-secondary)' }}>Score</td>
                                            {habitHistory.map(day => (
                                                <td key={day.date} style={{ padding: '0.5rem 0.25rem', textAlign: 'center', fontSize: '0.7rem', fontWeight: 700, color: day.habit_score !== null ? (day.habit_score >= 80 ? 'var(--accent-green)' : day.habit_score >= 50 ? 'var(--accent-yellow)' : 'var(--accent-orange)') : 'var(--text-muted)' }}>
                                                    {day.habit_score !== null ? `${day.habit_score} % ` : '—'}
                                                </td>
                                            ))}
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                        );
                    })()}
                </div>
            )}

            {/* Heatmap */}
            <div className="card mb-6">
                <Heatmap data={heatmapData} />
                <div className="flex items-center justify-between mt-3">
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {heatmapData.length} check-ins in the last year
                    </p>
                    <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                        <span>Less</span>
                        <div className="heatmap-cell" style={{ width: 10, height: 10 }} />
                        <div className="heatmap-cell level-1" style={{ width: 10, height: 10 }} />
                        <div className="heatmap-cell level-2" style={{ width: 10, height: 10 }} />
                        <div className="heatmap-cell level-3" style={{ width: 10, height: 10 }} />
                        <div className="heatmap-cell level-4" style={{ width: 10, height: 10 }} />
                        <span>More</span>
                    </div>
                </div>
            </div>

            {/* Habits List */}
            <div className="space-y-3">
                {habits.map(habit => (
                    <div key={habit.id} className="card flex items-center gap-4">
                        <button
                            onClick={() => toggleCheckin(habit.id)}
                            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl transition-all flex-shrink-0 relative overflow-hidden group"
                            style={{
                                background: habit.checked_today ? 'var(--accent-green-glow)' : 'var(--bg-secondary)',
                                border: `2px solid ${habit.checked_today ? 'var(--accent-green)' : 'var(--border)'}`,
                            }}
                        >
                            {habit.checked_today ? '✓' : habit.icon}
                        </button>

                        <button
                            onClick={() => triggerPhotoProof(habit.id)}
                            className="w-8 h-8 rounded-full flex items-center justify-center text-sm transition-transform hover:scale-110 shrink-0"
                            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                            title="Upload Photo Proof"
                        >
                            📸
                        </button>
                        <div className="flex-1 space-y-1">
                            <div className="flex justify-between items-center">
                                <p className={`font - medium ${habit.checked_today ? 'line-through' : ''}`}
                                    style={{ color: habit.checked_today ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                                    {habit.name}
                                </p>
                                {habit.goal_metric === 'time' && (
                                    <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                                        {habit.today_value} / {habit.goal_target} min
                                    </span>
                                )}
                            </div>

                            {habit.goal_metric === 'time' && (
                                <div className="w-full h-1.5 bg-[#121212] rounded-full overflow-hidden border border-[#333]">
                                    <div
                                        className="h-full transition-all"
                                        style={{
                                            width: `${Math.min((habit.today_value / habit.goal_target) * 100, 100)} % `,
                                            backgroundColor: habit.checked_today ? 'var(--accent-green)' : 'var(--accent-purple)'
                                        }}
                                    />
                                </div>
                            )}

                            <div className="flex gap-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                                <span>{habit.total_checkins} total check-ins</span>

                                {/* Lally Automaticity Score */}
                                {habit.current_streak > 0 && (
                                    <div className="flex gap-2 items-center">
                                        <span>•</span>
                                        <span className="flex items-center gap-1" title="Habit Automaticity (Lally's Curve)">
                                            🤖 {habit.automaticity_score}% Automatic
                                        </span>
                                        <span>•</span>
                                        <span>🔥 {habit.current_streak}</span>

                                        {/* Habit Progression Suggestion */}
                                        {habit.automaticity_score > 80 && (
                                            <>
                                                <span>•</span>
                                                <span className="badge badge-purple text-[0.65rem] px-1.5 py-0">
                                                    ⭐ Level Up Suggested
                                                </span>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                        <button onClick={() => deleteHabit(habit.id)} className="btn btn-ghost btn-sm">🗑️</button>
                    </div>
                ))}

                {/* New habit form */}
                {showNewHabit ? (
                    <div className="card">
                        <div className="flex gap-3 items-center mb-3">
                            <input
                                className="input"
                                style={{ width: '60px', textAlign: 'center', fontSize: '1.25rem' }}
                                value={newIcon}
                                onChange={e => setNewIcon(e.target.value)}
                                placeholder="🎯"
                            />
                            <div className="flex-1 space-y-2">
                                <input
                                    className="input w-full"
                                    placeholder="Habit name (e.g., Read, Study for 2 hours)..."
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    autoFocus
                                />
                                <div className="flex gap-2">
                                    <select
                                        className="input text-sm"
                                        value={newGoalMetric}
                                        onChange={(e: any) => setNewGoalMetric(e.target.value)}
                                    >
                                        <option value="boolean">Simple Checkbox</option>
                                        <option value="time">Time based (Productive minutes)</option>
                                    </select>

                                    {newGoalMetric === 'time' && (
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number"
                                                className="input w-24 text-sm"
                                                value={newGoalTarget}
                                                onChange={(e) => setNewGoalTarget(Math.max(1, parseInt(e.target.value) || 60))}
                                                min="1"
                                            />
                                            <span className="text-sm text-gray-400">min</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                        <div className="flex gap-2">
                            <button className="btn btn-primary btn-sm" onClick={addHabit}>Add Habit</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => setShowNewHabit(false)}>Cancel</button>
                        </div>
                    </div>
                ) : (
                    <button
                        className="w-full py-4 border-2 border-dashed rounded-xl text-sm transition-colors"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                        onClick={() => setShowNewHabit(true)}
                        onMouseOver={e => { (e.target as HTMLElement).style.borderColor = 'rgba(102,126,234,0.4)'; (e.target as HTMLElement).style.color = 'var(--text-primary)'; }}
                        onMouseOut={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.color = 'var(--text-muted)'; }}
                    >+ New habit</button>
                )}
            </div>

            {/* Hidden File Input for Photo Proof */}
            <input
                type="file"
                accept="image/*"
                capture="environment"
                ref={fileInputRef}
                className="hidden"
                onChange={handlePhotoUpload}
            />

            {verifying && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
                    <div className="card p-8 text-center max-w-sm" style={{ background: 'var(--bg-secondary)', border: '2px solid var(--accent-purple)' }}>
                        <div className="text-4xl mb-4 animate-spin">🤖</div>
                        <h3 className="text-lg font-bold mb-2">Analyzing Proof...</h3>
                        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Gemini Vision is inspecting your photo and metadata.</p>
                    </div>
                </div>
            )}
        </div>
    );
}

function Heatmap({ data }: { data: HeatmapDay[] }) {
    // Build 365 days grid
    const days: { date: string; level: number }[] = [];
    const dataMap = new Map(data.map(d => [d.date, d]));

    const today = new Date();
    for (let i = 364; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        const entry = dataMap.get(dateStr);
        let level = 0;
        if (entry) {
            const ratio = entry.total_habits > 0 ? entry.habits_done / entry.total_habits : 0;
            if (ratio >= 1) level = 4;
            else if (ratio >= 0.75) level = 3;
            else if (ratio >= 0.5) level = 2;
            else if (ratio > 0) level = 1;
        }
        days.push({ date: dateStr, level });
    }

    // Group by week
    const weeks: typeof days[] = [];
    for (let i = 0; i < days.length; i += 7) {
        weeks.push(days.slice(i, i + 7));
    }

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    return (
        <div className="overflow-x-auto">
            <div className="flex gap-[3px] items-start min-w-fit">
                {/* Day labels */}
                <div className="flex flex-col gap-[3px] mr-2 pt-[18px]">
                    <div className="h-[13px] text-xs flex items-center" style={{ color: 'var(--text-muted)' }}>Mon</div>
                    <div className="h-[13px]" />
                    <div className="h-[13px] text-xs flex items-center" style={{ color: 'var(--text-muted)' }}>Wed</div>
                    <div className="h-[13px]" />
                    <div className="h-[13px] text-xs flex items-center" style={{ color: 'var(--text-muted)' }}>Fri</div>
                    <div className="h-[13px]" />
                    <div className="h-[13px]" />
                </div>
                {/* Weeks */}
                <div className="flex gap-[3px]">
                    {weeks.map((week, wi) => {
                        const firstDay = week[0];
                        const showMonth = wi === 0 || new Date(firstDay.date).getDate() <= 7;
                        return (
                            <div key={wi} className="flex flex-col gap-[3px]">
                                <div className="h-[14px] text-xs" style={{ color: 'var(--text-muted)' }}>
                                    {showMonth ? months[new Date(firstDay.date).getMonth()] : ''}
                                </div>
                                {week.map((day, di) => (
                                    <div
                                        key={di}
                                        className={`heatmap - cell ${day.level > 0 ? `level-${day.level}` : ''}`}
                                        title={`${day.date}: ${day.level > 0 ? `Level ${day.level}` : 'No check-ins'}`}
                                    />
                                ))}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
