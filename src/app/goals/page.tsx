'use client';

import { useEffect, useState } from 'react';
import { progressColor, efficacyEmoji } from '@/lib/score-classify';

interface LinkedTask {
    id: number;
    title: string;
    status: string;
    completed_at: string | null;
}

interface LinkedHabit {
    id: number;
    name: string;
    icon: string;
    total_checkins: number;
    week_checkins: number;
}

interface Goal {
    id: number;
    title: string;
    description: string;
    type: string;
    category: string;
    deadline: string | null;
    active: number;
    progress: number;
    taskProgress: number;
    habitHealth: number | null;
    completedTasks: number;
    totalTasks: number;
    tmtScore: number | null;
    momentum: number | null;
    linkedTasks: LinkedTask[];
    linkedHabits: LinkedHabit[];
    intentions: { id: number; if_condition: string; then_action: string; active: number; times_triggered: number }[];
    health_status: 'on_track' | 'at_risk' | 'off_track' | null;
    velocity_needed: number | null;
    actual_velocity: number | null;
}

export default function GoalsPage() {
    const [goals, setGoals] = useState<Goal[]>([]);
    const [selfEfficacy, setSelfEfficacy] = useState(50);
    const [showNewGoal, setShowNewGoal] = useState(false);
    const [expandedGoal, setExpandedGoal] = useState<number | null>(null);
    const [allTasks, setAllTasks] = useState<{ id: number; title: string; status: string; goal_id: number | null }[]>([]);
    const [allHabits, setAllHabits] = useState<{ id: number; name: string; icon: string; goal_id: number | null }[]>([]);
    const [editingGoalId, setEditingGoalId] = useState<number | null>(null);
    const [editingGoalTitle, setEditingGoalTitle] = useState('');

    // Form state
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [category, setCategory] = useState('productivity');
    const [deadline, setDeadline] = useState('');

    // Intention form state
    const [newIf, setNewIf] = useState('');
    const [newThen, setNewThen] = useState('');

    useEffect(() => {
        fetchGoals();
        fetchUnlinked();
    }, []);

    const fetchGoals = async () => {
        const res = await fetch('/api/goals');
        const data = await res.json();
        setGoals(data.goals || []);
        setSelfEfficacy(data.selfEfficacy ?? 50);
    };

    const fetchUnlinked = async () => {
        const [tasksRes, habitsRes] = await Promise.all([
            fetch('/api/tasks'),
            fetch('/api/habits')
        ]);
        const tasksData = await tasksRes.json();
        const habitsData = await habitsRes.json();
        setAllTasks((tasksData.tasks || []).filter((t: any) => !t.goal_id));
        setAllHabits((habitsData.habits || []).filter((h: any) => !h.goal_id));
    };

    const addGoal = async () => {
        if (!title.trim()) return;
        await fetch('/api/goals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title.trim(), description, category, deadline: deadline || null }),
        });
        setTitle(''); setDescription(''); setDeadline('');
        setShowNewGoal(false);
        fetchGoals();
    };

    const deleteGoal = async (id: number) => {
        await fetch(`/api/goals?id=${id}`, { method: 'DELETE' });
        fetchGoals();
        fetchUnlinked();
    };

    const saveGoalTitle = async (id: number) => {
        const trimmed = editingGoalTitle.trim();
        if (trimmed) {
            await fetch('/api/goals', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, title: trimmed }),
            });
            fetchGoals();
        }
        setEditingGoalId(null);
    };

    const toggleActive = async (goal: Goal) => {
        await fetch('/api/goals', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: goal.id, active: goal.active ? 0 : 1 }),
        });
        fetchGoals();
    };

    const linkTask = async (taskId: number, goalId: number) => {
        await fetch('/api/tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: taskId, goal_id: goalId }),
        });
        fetchGoals();
        fetchUnlinked();
    };

    const linkHabit = async (habitId: number, goalId: number) => {
        // habits don't have a PATCH for goal_id yet, use the DB directly
        await fetch('/api/goals', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: goalId }), // triggers a refetch
        });
        // For now, we'll do this through a custom endpoint - let's add it via tasks API pattern
    };

    const unlinkTask = async (taskId: number) => {
        await fetch('/api/tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: taskId, goal_id: null })
        });
        fetchGoals();
        fetchUnlinked();
    };

    const addIntention = async (goalId: number) => {
        if (!newIf.trim() || !newThen.trim()) return;
        await fetch('/api/intentions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ if_condition: newIf, then_action: newThen, goal_id: goalId })
        });
        setNewIf('');
        setNewThen('');
        fetchGoals();
    };

    const deleteIntention = async (id: number) => {
        await fetch(`/api/intentions?id=${id}`, { method: 'DELETE' });
        fetchGoals();
    };

    const getProgressColor = (p: number) => {
        return progressColor(p);
    };

    const daysUntil = (dateStr: string) => {
        const d = Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000);
        if (d < 0) return `${Math.abs(d)}d overdue`;
        if (d === 0) return 'Today';
        if (d === 1) return 'Tomorrow';
        return `${d} days`;
    };

    return (
        <div className="max-w-[1000px] mx-auto animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Goals 🎯</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Goals drive tasks. Tasks build habits. Habits sustain progress.
                    </p>
                </div>
                <div className="text-center">
                    <div className="text-2xl">{efficacyEmoji(selfEfficacy)}</div>
                    <p className="text-xs font-semibold" style={{ color: getProgressColor(selfEfficacy) }}>
                        {selfEfficacy}% Efficacy
                    </p>
                </div>
            </div>

            {/* Goals List */}
            <div className="space-y-4">
                {goals.map(goal => (
                    <div
                        key={goal.id}
                        className={`card transition-all ${!goal.active ? 'opacity-50 grayscale' : ''}`}
                        style={{ padding: '1.25rem' }}
                    >
                        {/* Header Row */}
                        <div className="flex items-start gap-3">
                            <button
                                onClick={() => toggleActive(goal)}
                                className="w-10 h-10 rounded-xl flex items-center justify-center text-lg transition-all flex-shrink-0 mt-0.5"
                                style={{
                                    background: goal.active ? 'var(--accent-green-glow)' : 'var(--bg-secondary)',
                                    border: `2px solid ${goal.active ? 'var(--accent-green)' : 'var(--border)'}`,
                                }}
                            >
                                {goal.progress >= 100 ? '🏆' : goal.active ? '🎯' : '💤'}
                            </button>

                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    {editingGoalId === goal.id ? (
                                        <input
                                            autoFocus
                                            className="input font-semibold text-lg"
                                            style={{ padding: '2px 8px', height: 'auto' }}
                                            value={editingGoalTitle}
                                            onChange={e => setEditingGoalTitle(e.target.value)}
                                            onBlur={() => saveGoalTitle(goal.id)}
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') saveGoalTitle(goal.id);
                                                if (e.key === 'Escape') setEditingGoalId(null);
                                            }}
                                        />
                                    ) : (
                                        <h3
                                            className="font-semibold text-lg cursor-text"
                                            onClick={() => { setEditingGoalId(goal.id); setEditingGoalTitle(goal.title); }}
                                        >{goal.title}</h3>
                                    )}
                                    {goal.deadline && (
                                        <span className="badge text-xs" style={{
                                            background: new Date(goal.deadline) < new Date() ? 'rgba(255,85,85,0.15)' : 'rgba(255,165,0,0.15)',
                                            color: new Date(goal.deadline) < new Date() ? 'var(--accent-red)' : 'var(--accent-orange)',
                                        }}>
                                            ⏰ {daysUntil(goal.deadline)}
                                        </span>
                                    )}
                                    {goal.tmtScore !== null && (
                                        <span className="badge text-xs" style={{
                                            background: goal.tmtScore > 20 ? 'rgba(76,175,80,0.15)' : 'rgba(255,85,85,0.15)',
                                            color: goal.tmtScore > 20 ? 'var(--accent-green)' : 'var(--accent-red)',
                                        }} title="TMT Motivation Score — higher = more motivated">
                                            {goal.tmtScore > 20 ? '🔋' : '⚡'} TMT {goal.tmtScore}%
                                        </span>
                                    )}
                                    {goal.momentum !== null && goal.momentum !== 0 && (
                                        <span className="badge text-xs" style={{
                                            background: goal.momentum > 0 ? 'rgba(76,175,80,0.15)' : 'rgba(255,165,0,0.15)',
                                            color: goal.momentum > 0 ? 'var(--accent-green)' : 'var(--accent-orange)',
                                        }}>
                                            {goal.momentum > 0 ? '📈' : '📉'} {goal.momentum > 0 ? '+' : ''}{goal.momentum}%
                                        </span>
                                    )}
                                    {goal.health_status && goal.health_status !== 'on_track' && (
                                        <span className="badge text-xs" style={{
                                            background: goal.health_status === 'off_track' ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)',
                                            color: goal.health_status === 'off_track' ? '#ef4444' : '#f59e0b',
                                        }} title={goal.velocity_needed != null ? `Need ${goal.velocity_needed.toFixed(0)}m/day · getting ${(goal.actual_velocity ?? 0).toFixed(0)}m/day` : undefined}>
                                            {goal.health_status === 'off_track' ? 'Off track' : 'At risk'}
                                        </span>
                                    )}
                                    {goal.health_status === 'on_track' && goal.velocity_needed != null && (
                                        <span className="badge text-xs" style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e' }}>
                                            On track
                                        </span>
                                    )}
                                </div>
                                {goal.description && (
                                    <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>{goal.description}</p>
                                )}

                                {/* Progress Bar */}
                                <div className="mt-3 flex items-center gap-3">
                                    <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                                        <div
                                            className="h-full rounded-full transition-all"
                                            style={{
                                                width: `${Math.min(goal.progress, 100)}%`,
                                                background: getProgressColor(goal.progress),
                                            }}
                                        />
                                    </div>
                                    <span className="text-sm font-bold tabular-nums" style={{ color: getProgressColor(goal.progress), minWidth: '3rem', textAlign: 'right' }}>
                                        {goal.progress}%
                                    </span>
                                </div>
                                {goal.velocity_needed != null && (
                                    <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                                        {(goal.actual_velocity ?? 0).toFixed(0)}m/day actual · {goal.velocity_needed.toFixed(0)}m/day needed
                                    </div>
                                )}

                                {/* Mini Stats */}
                                <div className="flex gap-4 mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                                    <span>✅ {goal.completedTasks}/{goal.totalTasks} tasks</span>
                                    {goal.habitHealth !== null && <span>🔥 Habit health: {goal.habitHealth}%</span>}
                                    <span className="px-2 py-0.5 rounded-full bg-[#1e1e1e] border border-[#333] capitalize">{goal.category}</span>
                                </div>
                            </div>

                            <div className="flex items-center gap-1 flex-shrink-0">
                                <button
                                    onClick={() => setExpandedGoal(expandedGoal === goal.id ? null : goal.id)}
                                    className="btn btn-ghost btn-sm"
                                >{expandedGoal === goal.id ? '▲' : '▼'}</button>
                                <button onClick={() => deleteGoal(goal.id)} className="btn btn-ghost btn-sm">🗑️</button>
                            </div>
                        </div>

                        {/* Expanded: Linked Tasks & Habits + Link New */}
                        {expandedGoal === goal.id && (
                            <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
                                {/* Linked Tasks */}
                                <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                    📋 LINKED TASKS ({goal.linkedTasks.length})
                                </h4>
                                <div className="space-y-1 mb-3">
                                    {goal.linkedTasks.map(t => (
                                        <div key={t.id} className="flex items-center gap-2 text-sm py-1">
                                            <span>{t.status === 'done' ? '✅' : t.status === 'doing' ? '⚡' : '○'}</span>
                                            <span className={t.status === 'done' ? 'line-through' : ''} style={{ color: t.status === 'done' ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                                                {t.title}
                                            </span>
                                            <button onClick={() => unlinkTask(t.id)} className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>✕</button>
                                        </div>
                                    ))}
                                    {goal.linkedTasks.length === 0 && (
                                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No tasks linked yet</p>
                                    )}
                                </div>

                                {/* Link Unlinked Task */}
                                {allTasks.length > 0 && (
                                    <select
                                        className="input text-sm mb-4 w-full"
                                        onChange={(e) => { if (e.target.value) { linkTask(parseInt(e.target.value), goal.id); e.target.value = ''; } }}
                                        defaultValue=""
                                    >
                                        <option value="" disabled>+ Link an existing task...</option>
                                        {allTasks.map(t => (
                                            <option key={t.id} value={t.id}>{t.title} ({t.status})</option>
                                        ))}
                                    </select>
                                )}

                                {/* Linked Habits */}
                                <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                                    🔥 LINKED HABITS ({goal.linkedHabits.length})
                                </h4>
                                <div className="space-y-1">
                                    {goal.linkedHabits.map(h => (
                                        <div key={h.id} className="flex items-center gap-2 text-sm py-1">
                                            <span>{h.icon}</span>
                                            <span>{h.name}</span>
                                            <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
                                                {h.week_checkins}/7 this week
                                            </span>
                                        </div>
                                    ))}
                                    {goal.linkedHabits.length === 0 && (
                                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No habits linked yet — link from the habits page</p>
                                    )}
                                </div>

                                {/* Implementation Intentions */}
                                <h4 className="text-xs font-semibold mt-4 mb-2" style={{ color: 'var(--text-secondary)' }}>
                                    ⚡ IMPLEMENTATION INTENTIONS ({goal.intentions?.length || 0})
                                </h4>
                                <div className="space-y-2 mb-3">
                                    {(goal.intentions || []).map(int => (
                                        <div key={int.id} className="text-sm py-2 px-3 rounded-lg flex items-start gap-2" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
                                            <div className="flex-1">
                                                <p><span className="font-bold text-xs" style={{ color: 'var(--accent-purple)' }}>IF</span> {int.if_condition}</p>
                                                <p><span className="font-bold text-xs" style={{ color: 'var(--accent-blue)' }}>THEN</span> {int.then_action}</p>
                                                <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>Triggered {int.times_triggered} times</p>
                                            </div>
                                            <button onClick={() => deleteIntention(int.id)} className="text-xs ml-auto hover:text-red-400" style={{ color: 'var(--text-muted)' }}>✕</button>
                                        </div>
                                    ))}
                                    {(!goal.intentions || goal.intentions.length === 0) && (
                                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No if-then plans defined. Define one to increase success rate.</p>
                                    )}
                                </div>
                                <div className="flex flex-col gap-2 p-3 rounded-lg mt-2" style={{ background: 'rgba(157, 78, 221, 0.05)', border: '1px dashed var(--accent-purple)' }}>
                                    <div className="flex gap-2 items-center">
                                        <span className="font-bold text-xs w-10 text-right" style={{ color: 'var(--accent-purple)' }}>IF</span>
                                        <input className="input w-full text-xs py-1" placeholder="I feel distracted by social media..." value={newIf} onChange={e => setNewIf(e.target.value)} />
                                    </div>
                                    <div className="flex gap-2 items-center">
                                        <span className="font-bold text-xs w-10 text-right" style={{ color: 'var(--accent-blue)' }}>THEN</span>
                                        <input className="input w-full text-xs py-1" placeholder="I will take a 5-minute break outside." value={newThen} onChange={e => setNewThen(e.target.value)} />
                                    </div>
                                    <button className="btn btn-sm shrink-0 self-end mt-1 text-xs" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }} onClick={() => addIntention(goal.id)}>Add Intention</button>
                                </div>
                            </div>
                        )}
                    </div>
                ))}

                {/* New goal form */}
                {showNewGoal ? (
                    <div className="card space-y-3" style={{ padding: '1.25rem' }}>
                        <input
                            className="input w-full font-medium"
                            placeholder="Goal Title (e.g., Build ZK Proof System)..."
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            autoFocus
                        />
                        <input
                            className="input w-full text-sm"
                            placeholder="Description (optional)"
                            value={description}
                            onChange={e => setDescription(e.target.value)}
                        />
                        <div className="grid grid-cols-2 gap-3">
                            <select className="input text-sm" value={category} onChange={(e: any) => setCategory(e.target.value)}>
                                <option value="productivity">🔧 Productivity</option>
                                <option value="learning">📚 Learning</option>
                                <option value="health">💪 Health</option>
                                <option value="finance">💰 Finance</option>
                                <option value="other">🌟 Other</option>
                            </select>
                            <input
                                type="date"
                                className="input text-sm"
                                value={deadline}
                                onChange={e => setDeadline(e.target.value)}
                                placeholder="Deadline (optional)"
                            />
                        </div>
                        <div className="flex justify-end gap-2 pt-2 border-t border-[#333]">
                            <button className="btn btn-ghost btn-sm" onClick={() => setShowNewGoal(false)}>Cancel</button>
                            <button className="btn btn-primary btn-sm" onClick={addGoal}>Create Goal</button>
                        </div>
                    </div>
                ) : (
                    <button
                        className="w-full py-4 border-2 border-dashed rounded-xl text-sm transition-colors"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                        onClick={() => setShowNewGoal(true)}
                        onMouseOver={e => { (e.target as HTMLElement).style.borderColor = 'rgba(102,126,234,0.4)'; (e.target as HTMLElement).style.color = 'var(--text-primary)'; }}
                        onMouseOut={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.color = 'var(--text-muted)'; }}
                    >+ New Goal</button>
                )}
            </div>
        </div >
    );
}
