'use client';

import { useEffect, useState } from 'react';

interface Goal {
    id: number;
    title: string;
    type: 'daily' | 'weekly' | 'custom';
    metric: 'duration' | 'count';
    target_value: number;
    unit: string;
    category: 'productivity' | 'learning' | 'health' | 'finance' | 'other';
    active: number;
}

export default function GoalsPage() {
    const [goals, setGoals] = useState<Goal[]>([]);
    const [showNewGoal, setShowNewGoal] = useState(false);

    // Form state
    const [title, setTitle] = useState('');
    const [type, setType] = useState<'daily' | 'weekly' | 'custom'>('daily');
    const [metric, setMetric] = useState<'duration' | 'count'>('duration');
    const [targetValue, setTargetValue] = useState(60);
    const [unit, setUnit] = useState('minutes');
    const [category, setCategory] = useState<'productivity' | 'learning'>('productivity');

    useEffect(() => {
        fetchGoals();
    }, []);

    const fetchGoals = async () => {
        const res = await fetch('/api/goals');
        const data = await res.json();
        setGoals(data.goals || []);
    };

    const addGoal = async () => {
        if (!title.trim()) return;
        await fetch('/api/goals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: title.trim(),
                type,
                metric,
                target_value: targetValue,
                unit,
                category
            }),
        });

        setTitle('');
        setTargetValue(60);
        setShowNewGoal(false);
        fetchGoals();
    };

    const deleteGoal = async (id: number) => {
        await fetch(`/api/goals?id=${id}`, { method: 'DELETE' });
        fetchGoals();
    };

    const toggleActive = async (goal: Goal) => {
        await fetch(`/api/goals`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: goal.id, active: goal.active ? 0 : 1 }),
        });
        fetchGoals();
    };

    return (
        <div className="max-w-[1000px] mx-auto animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Goals 🎯</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Define what success looks like. The AI will use these to guide you.
                    </p>
                </div>
            </div>

            {/* Goals List */}
            <div className="space-y-3">
                {goals.map(goal => (
                    <div key={goal.id} className={`card flex items-center gap-4 transition-all ${!goal.active ? 'opacity-50 grayscale' : ''}`}>
                        <button
                            onClick={() => toggleActive(goal)}
                            className="w-10 h-10 rounded-xl flex items-center justify-center text-xl transition-all flex-shrink-0"
                            style={{
                                background: goal.active ? 'var(--accent-green-glow)' : 'var(--bg-secondary)',
                                border: `2px solid ${goal.active ? 'var(--accent-green)' : 'var(--border)'}`,
                            }}
                        >
                            {goal.active ? '✓' : 'zzz'}
                        </button>
                        <div className="flex-1">
                            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
                                {goal.title}
                            </p>
                            <p className="text-xs mt-1 space-x-2" style={{ color: 'var(--text-muted)' }}>
                                <span className="px-2 py-0.5 rounded-full bg-[#1e1e1e] border border-[#333] capitalize">{goal.type}</span>
                                <span className="px-2 py-0.5 rounded-full bg-[#1e1e1e] border border-[#333]">{goal.target_value} {goal.unit}</span>
                                <span className="px-2 py-0.5 rounded-full bg-[#1e1e1e] border border-[#333] capitalize">{goal.category}</span>
                            </p>
                        </div>
                        <button onClick={() => deleteGoal(goal.id)} className="btn btn-ghost btn-sm">🗑️</button>
                    </div>
                ))}

                {/* New goal form */}
                {showNewGoal ? (
                    <div className="card space-y-4">
                        <input
                            className="input w-full font-medium"
                            placeholder="Goal Title (e.g., Code Every Day)..."
                            value={title}
                            onChange={e => setTitle(e.target.value)}
                            autoFocus
                        />
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <select className="input text-sm" value={type} onChange={(e: any) => setType(e.target.value)}>
                                <option value="daily">Daily</option>
                                <option value="weekly">Weekly</option>
                            </select>
                            <select className="input text-sm" value={category} onChange={(e: any) => setCategory(e.target.value)}>
                                <option value="productivity">Productivity</option>
                                <option value="learning">Learning</option>
                                <option value="health">Health</option>
                                <option value="finance">Finance</option>
                            </select>
                            <div className="flex items-center gap-2">
                                <input
                                    type="number"
                                    className="input w-full text-sm"
                                    value={targetValue}
                                    onChange={(e) => setTargetValue(Math.max(1, parseInt(e.target.value) || 1))}
                                />
                            </div>
                            <select className="input text-sm" value={unit} onChange={(e: any) => setUnit(e.target.value)}>
                                <option value="minutes">Minutes</option>
                                <option value="hours">Hours</option>
                                <option value="times">Times</option>
                                <option value="modules">Modules</option>
                            </select>
                        </div>
                        <div className="flex justify-end gap-2 pt-2 border-t border-[#333]">
                            <button className="btn btn-ghost btn-sm" onClick={() => setShowNewGoal(false)}>Cancel</button>
                            <button className="btn btn-primary btn-sm" onClick={addGoal}>Save Goal</button>
                        </div>
                    </div>
                ) : (
                    <button
                        className="w-full py-4 border-2 border-dashed rounded-xl text-sm transition-colors"
                        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
                        onClick={() => setShowNewGoal(true)}
                        onMouseOver={e => { (e.target as HTMLElement).style.borderColor = 'rgba(102,126,234,0.4)'; (e.target as HTMLElement).style.color = 'var(--text-primary)'; }}
                        onMouseOut={e => { (e.target as HTMLElement).style.borderColor = 'var(--border)'; (e.target as HTMLElement).style.color = 'var(--text-muted)'; }}
                    >+ New Core Goal</button>
                )}
            </div>
        </div>
    );
}
