'use client';

import { useEffect, useState } from 'react';

interface StudyBlock {
    title: string;
    duration: number;
    type: 'study' | 'break';
    description: string;
}

interface StudyPlan {
    topic: string;
    overview: string;
    blocks: StudyBlock[];
    adaptiveContext?: {
        mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
        energy: 'high' | 'medium' | 'low';
        mood: 'high' | 'medium' | 'low' | null;
        guidance: string;
        studyBlockMinutes: number;
        breakMinutes: number;
        generatedBy: 'ai' | 'adaptive_fallback';
    };
}

interface StudyPlanDefaults {
    recommendedDurationMinutes: number;
    adaptiveContext: {
        mode: NonNullable<StudyPlan['adaptiveContext']>['mode'];
        energy: NonNullable<StudyPlan['adaptiveContext']>['energy'];
        mood: NonNullable<StudyPlan['adaptiveContext']>['mood'];
        guidance: string;
        nextBestFocusWindow: string;
        standupGoal: string | null;
        studyBlockMinutes: number;
        breakMinutes: number;
    };
}

const modeLabel: Record<NonNullable<StudyPlan['adaptiveContext']>['mode'], string> = {
    protect_focus: 'Protect focus',
    deadline_pressure: 'Deadline pressure',
    recovery: 'Recovery',
    planning: 'Planning',
    normal: 'Balanced',
};

export default function StudyPlanPage() {
    const [topic, setTopic] = useState('');
    const [duration, setDuration] = useState<number | ''>('');
    const [difficulty, setDifficulty] = useState('intermediate');
    const [plan, setPlan] = useState<StudyPlan | null>(null);
    const [defaults, setDefaults] = useState<StudyPlanDefaults | null>(null);
    const [durationTouched, setDurationTouched] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        fetch('/api/study-plan')
            .then((res) => res.ok ? res.json() : null)
            .then((data: StudyPlanDefaults | null) => {
                if (cancelled || !data?.recommendedDurationMinutes) return;
                setDefaults(data);
                if (!durationTouched) setDuration(Math.round(data.recommendedDurationMinutes));
            })
            .catch(() => { });
        return () => {
            cancelled = true;
        };
    }, [durationTouched]);

    const generatePlan = async () => {
        if (!topic || !duration) return;
        setLoading(true);
        setError('');
        try {
            const res = await fetch('/api/study-plan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic, durationMinutes: duration, difficulty })
            });
            const data = await res.json();
            if (res.ok) {
                setPlan(data);
            } else {
                setError(data.error || 'Failed to generate plan');
            }
        } catch {
            setError('Error connecting to server');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-[1000px] mx-auto animate-fade-in p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Study Plans 📚</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Generate study sessions shaped by the current day, energy, and workload.
                    </p>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto">
                <div className="max-w-4xl mx-auto space-y-6">
                    {/* Generator Form */}
                    <div className="card p-6 border rounded-xl" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                            <div className="md:col-span-3">
                                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>What do you want to study?</label>
                                <input
                                    type="text"
                                    className="w-full input-field"
                                    placeholder="e.g., Quantum Computing, Rust Ownership, React Hooks"
                                    value={topic}
                                    onChange={(e) => setTopic(e.target.value)}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Time Available (min)</label>
	                                <input
	                                    type="number"
	                                    className="w-full input-field"
	                                    value={duration}
	                                    onChange={(e) => {
	                                        setDurationTouched(true);
	                                        const parsed = parseInt(e.target.value, 10);
	                                        setDuration(Number.isFinite(parsed) && parsed > 0 ? parsed : '');
	                                    }}
	                                    min={10} max={480}
	                                />
                                {defaults && (
                                    <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                                        Suggested {Math.round(defaults.recommendedDurationMinutes)}m from {modeLabel[defaults.adaptiveContext.mode].toLowerCase()} mode · {defaults.adaptiveContext.studyBlockMinutes}m blocks
                                        {defaults.adaptiveContext.breakMinutes > 0 ? ` · ${defaults.adaptiveContext.breakMinutes}m breaks` : ''}
                                    </p>
                                )}
                            </div>
                            <div>
                                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Current Skill Level</label>
                                <select
                                    className="w-full input-field"
                                    value={difficulty}
                                    onChange={(e) => setDifficulty(e.target.value)}
                                >
                                    <option value="beginner">Beginner</option>
                                    <option value="intermediate">Intermediate</option>
                                    <option value="advanced">Advanced</option>
                                </select>
	                            </div>
	                            <div className="flex items-end">
	                                <button
	                                    className="w-full btn-primary h-[42px] flex items-center justify-center gap-2"
	                                    onClick={generatePlan}
	                                    disabled={loading || !topic || !duration}
	                                >
                                    {loading ? 'Generating...' : '✨ Generate Plan'}
                                </button>
                            </div>
                        </div>
                        {defaults && (
                            <div className="mt-2 text-xs rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)', background: 'rgba(255,255,255,0.03)' }}>
                                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{modeLabel[defaults.adaptiveContext.mode]}</span>
                                {' '}· {defaults.adaptiveContext.energy} energy
                                {defaults.adaptiveContext.nextBestFocusWindow ? ` · best window ${defaults.adaptiveContext.nextBestFocusWindow}` : ''}
                                {defaults.adaptiveContext.standupGoal ? ` · today: ${defaults.adaptiveContext.standupGoal}` : ''}
                                <div className="mt-1">{defaults.adaptiveContext.guidance}</div>
                            </div>
                        )}
                        {error && <p className="text-red-500 text-sm">{error}</p>}
                    </div>

                    {/* Generated Plan */}
                    {plan && (
                        <div className="space-y-6 animate-fade-in section-slide-up">
                            <div className="card p-6 border rounded-xl" style={{ borderColor: 'rgba(59, 130, 246, 0.3)', background: 'linear-gradient(to bottom right, rgba(59, 130, 246, 0.05), transparent)' }}>
                                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-2">
                                    <h3 className="text-xl font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                                        <span>🧠</span> {plan.topic}
                                    </h3>
                                    {plan.adaptiveContext && (
                                        <div className="text-xs px-3 py-2 rounded-lg border" style={{ borderColor: 'rgba(99, 102, 241, 0.25)', background: 'rgba(99, 102, 241, 0.08)', color: 'var(--text-secondary)' }}>
                                            <span className="font-bold" style={{ color: 'var(--text-primary)' }}>
                                                {modeLabel[plan.adaptiveContext.mode]}
                                            </span>
                                            {' '}· {plan.adaptiveContext.energy} energy · {plan.adaptiveContext.studyBlockMinutes}m blocks
                                            {plan.adaptiveContext.breakMinutes > 0 ? ` · ${plan.adaptiveContext.breakMinutes}m breaks` : ''}
                                        </div>
                                    )}
                                </div>
                                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{plan.overview}</p>
                                {plan.adaptiveContext && (
                                    <p className="text-xs mt-3" style={{ color: 'var(--text-secondary)' }}>
                                        {plan.adaptiveContext.guidance}
                                    </p>
                                )}
                            </div>

                            <div className="relative">
                                {/* Timeline line */}
                                <div className="absolute left-6 top-0 bottom-0 w-0.5" style={{ background: 'var(--border)' }}></div>

                                <div className="space-y-4">
                                    {plan.blocks.map((block, idx) => (
                                        <div key={idx} className="relative z-10 flex gap-4">
                                            <div className="flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center border-4 border-[var(--bg-main)]"
                                                style={{
                                                    background: block.type === 'study' ? 'rgba(59, 130, 246, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                                                    color: block.type === 'study' ? '#3b82f6' : '#10b981'
                                                }}>
                                                {block.type === 'study' ? '📚' : '☕'}
                                            </div>
                                            <div className="flex-1 card p-4 border rounded-xl" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                                                <div className="flex justify-between items-start mb-1">
                                                    <h4 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>{block.title}</h4>
                                                    <span className="text-xs font-bold px-2 py-1 rounded" style={{
                                                        background: block.type === 'study' ? 'rgba(59, 130, 246, 0.1)' : 'rgba(16, 185, 129, 0.1)',
                                                        color: block.type === 'study' ? '#3b82f6' : '#10b981'
                                                    }}>{block.duration} min</span>
                                                </div>
                                                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{block.description}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
