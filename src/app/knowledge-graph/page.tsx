'use client';

import { useEffect, useState, useCallback } from 'react';
import { masteryColor, masteryTier } from '@/lib/score-classify';

interface KnowledgeNode {
    id: number;
    title: string;
    description: string | null;
    node_type: 'concept' | 'skill' | 'topic';
    mastery: number;
    isBlocked: boolean;
    prereqMastery: number;
    linked_tasks: { id: number; title: string; status: string }[];
    edges_out: { to_node_id: number; edge_type: string; weight: number }[];
}

interface KnowledgeEdge {
    from_node_id: number;
    to_node_id: number;
    edge_type: string;
}

interface Goal {
    id: number;
    title: string;
    node_count: number;
}

const MASTERY_COLOR = (m: number) => {
    const color = masteryColor(m);
    if (m >= 0.8) return { bg: `rgba(16, 185, 129, 0.15)`, border: color, text: color };
    if (m >= 0.5) return { bg: `rgba(245, 158, 11, 0.15)`, border: color, text: color };
    if (m >= 0.2) return { bg: `rgba(239, 68, 68, 0.12)`, border: color, text: color };
    return { bg: 'rgba(100, 116, 139, 0.1)', border: color, text: '#94a3b8' };
};

export default function KnowledgeGraphPage() {
    const [goals, setGoals] = useState<Goal[]>([]);
    const [selectedGoalId, setSelectedGoalId] = useState<number | null>(null);
    const [selectedGoal, setSelectedGoal] = useState<Goal | null>(null);
    const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
    const [edges, setEdges] = useState<KnowledgeEdge[]>([]);
    const [selectedNode, setSelectedNode] = useState<KnowledgeNode | null>(null);
    const [loading, setLoading] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [difficulty, setDifficulty] = useState('intermediate');

    useEffect(() => {
        fetch('/api/knowledge-graph')
            .then(r => r.json())
            .then(d => setGoals(d.goals || []));
    }, []);

    const loadGraph = useCallback(async (goalId: number) => {
        setLoading(true);
        setSelectedNode(null);
        try {
            const res = await fetch(`/api/knowledge-graph?goalId=${goalId}`);
            const data = await res.json();
            setNodes(data.nodes || []);
            setEdges(data.edges || []);
        } finally {
            setLoading(false);
        }
    }, []);

    const generateConcepts = async () => {
        if (!selectedGoal) return;
        setGenerating(true);
        try {
            const res = await fetch('/api/knowledge-graph', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: 'generate_concepts',
                    goal_id: selectedGoal.id,
                    goal_title: selectedGoal.title,
                    difficulty,
                })
            });
            if (res.ok) loadGraph(selectedGoal.id);
        } finally {
            setGenerating(false);
        }
    };

    const deleteNode = async (nodeId: number) => {
        await fetch(`/api/knowledge-graph?nodeId=${nodeId}`, { method: 'DELETE' });
        setSelectedNode(null);
        if (selectedGoalId) loadGraph(selectedGoalId);
    };

    const NODE_TYPE_ICON: Record<string, string> = {
        concept: '💡',
        skill: '⚙️',
        topic: '📚',
    };

    return (
        <div className="max-w-[1200px] mx-auto animate-fade-in p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Knowledge Graph 🕸️</h1>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                        AI-assessed concept mastery — your learning DNA mapped to goals, tasks & study sessions.
                    </p>
                </div>
            </div>

            {/* Goal selector */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                {goals.map(goal => (
                    <button
                        key={goal.id}
                        onClick={() => { setSelectedGoalId(goal.id); setSelectedGoal(goal); loadGraph(goal.id); }}
                        className="card p-4 text-left border rounded-xl transition-all"
                        style={{
                            borderColor: selectedGoalId === goal.id ? 'rgba(102,126,234,0.6)' : 'var(--border)',
                            background: selectedGoalId === goal.id ? 'rgba(102,126,234,0.08)' : 'var(--bg-secondary)',
                        }}
                    >
                        <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{goal.title}</p>
                        <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                            {goal.node_count === 0 ? 'No concepts yet' : `${goal.node_count} concept nodes`}
                        </p>
                    </button>
                ))}
            </div>

            {selectedGoalId && selectedGoal && (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Graph Panel */}
                    <div className="lg:col-span-2">
                        <div className="card border rounded-xl p-5" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)', minHeight: 400 }}>
                            <div className="flex items-center justify-between mb-4">
                                <h3 className="font-bold text-sm" style={{ color: 'var(--text-secondary)' }}>
                                    🕸️ CONCEPT MAP — {selectedGoal.title.toUpperCase()}
                                </h3>
                                {nodes.length === 0 && (
                                    <div className="flex items-center gap-2">
                                        <select
                                            className="input-field text-xs py-1"
                                            value={difficulty}
                                            onChange={e => setDifficulty(e.target.value)}
                                        >
                                            <option value="beginner">Beginner</option>
                                            <option value="intermediate">Intermediate</option>
                                            <option value="advanced">Advanced</option>
                                        </select>
                                        <button
                                            className="btn-primary text-xs px-3 py-1"
                                            onClick={generateConcepts}
                                            disabled={generating}
                                        >
                                            {generating ? '⏳ Generating...' : '✨ AI-Generate Concepts'}
                                        </button>
                                    </div>
                                )}
                            </div>

                            {loading ? (
                                <div className="flex items-center justify-center h-64">
                                    <span style={{ color: 'var(--text-muted)' }}>Loading graph...</span>
                                </div>
                            ) : nodes.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-64 gap-3">
                                    <span className="text-4xl">🧭</span>
                                    <p className="text-center text-sm" style={{ color: 'var(--text-muted)' }}>No concept nodes yet. Use AI to generate the knowledge map for this goal.</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                    {nodes.map(node => {
                                        const colors = MASTERY_COLOR(node.mastery);
                                        const masteryPct = Math.round(node.mastery * 100);
                                        return (
                                            <button
                                                key={node.id}
                                                onClick={() => setSelectedNode(node)}
                                                className="text-left p-4 rounded-xl border transition-all"
                                                style={{
                                                    background: colors.bg,
                                                    borderColor: selectedNode?.id === node.id ? colors.border : 'rgba(255,255,255,0.08)',
                                                    opacity: node.isBlocked ? 0.6 : 1,
                                                }}
                                            >
                                                <div className="flex items-center justify-between mb-2">
                                                    <div className="flex items-center gap-2">
                                                        <span>{NODE_TYPE_ICON[node.node_type]}</span>
                                                        <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>{node.title}</span>
                                                    </div>
                                                    <span className="text-xs font-bold" style={{ color: colors.text }}>{masteryPct}%</span>
                                                </div>
                                                {/* Mastery bar */}
                                                <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                                    <div
                                                        className="h-full rounded-full transition-all duration-700"
                                                        style={{ width: `${masteryPct}%`, background: colors.border }}
                                                    />
                                                </div>
                                                {node.isBlocked && (
                                                    <p className="text-xs mt-2" style={{ color: '#f59e0b' }}>⏳ Prerequisites not met</p>
                                                )}
                                                {node.linked_tasks.length > 0 && (
                                                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                                                        {node.linked_tasks.filter(t => t.status === 'done').length}/{node.linked_tasks.length} tasks done
                                                    </p>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Legend */}
                            {nodes.length > 0 && (
                                <div className="flex gap-4 mt-4 text-xs" style={{ color: 'var(--text-muted)' }}>
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" /> {masteryTier(0.8).label}</span>
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-amber-500 inline-block" /> {masteryTier(0.5).label}</span>
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Needs work</span>
                                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-500 inline-block" /> Not started</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Side Panel */}
                    <div className="space-y-4">
                        {/* Summary Stats */}
                        <div className="card border rounded-xl p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                            <h4 className="font-bold text-xs mb-3" style={{ color: 'var(--text-secondary)' }}>GOAL MASTERY OVERVIEW</h4>
                            {nodes.length === 0 ? (
                                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No nodes to summarize.</p>
                            ) : (
                                <>
                                    <div className="text-3xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>
                                        {Math.round(nodes.reduce((s, n) => s + n.mastery, 0) / nodes.length * 100)}%
                                    </div>
                                    <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>Average concept mastery</p>
                                    <div className="space-y-2">
                                        <div className="flex justify-between text-xs">
                                            <span style={{ color: '#10b981' }}>✅ {masteryTier(0.8).label}</span>
                                            <span>{nodes.filter(n => n.mastery >= 0.8).length}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span style={{ color: '#f59e0b' }}>📈 In progress</span>
                                            <span>{nodes.filter(n => n.mastery >= 0.2 && n.mastery < 0.8).length}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span style={{ color: '#ef4444' }}>🎯 Next focus</span>
                                            <span>{nodes.filter(n => !n.isBlocked && n.mastery < 0.2).length}</span>
                                        </div>
                                        <div className="flex justify-between text-xs">
                                            <span style={{ color: '#64748b' }}>⏳ Blocked</span>
                                            <span>{nodes.filter(n => n.isBlocked).length}</span>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Selected Node Detail */}
                        {selectedNode && (
                            <div className="card border rounded-xl p-4 animate-fade-in" style={{ borderColor: 'rgba(102,126,234,0.3)', background: 'rgba(102,126,234,0.05)' }}>
                                <div className="flex items-start justify-between mb-3">
                                    <h4 className="font-bold text-sm" style={{ color: 'var(--text-primary)' }}>
                                        {NODE_TYPE_ICON[selectedNode.node_type]} {selectedNode.title}
                                    </h4>
                                    <button onClick={() => deleteNode(selectedNode.id)} className="text-xs" style={{ color: '#ef4444' }}>🗑️</button>
                                </div>
                                {selectedNode.description && (
                                    <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>{selectedNode.description}</p>
                                )}
                                <div className="text-2xl font-bold mb-1" style={{ color: MASTERY_COLOR(selectedNode.mastery).text }}>
                                    {Math.round(selectedNode.mastery * 100)}% mastery
                                </div>
                                <div className="h-2 rounded-full overflow-hidden mb-3" style={{ background: 'rgba(255,255,255,0.08)' }}>
                                    <div
                                        className="h-full rounded-full"
                                        style={{ width: `${Math.round(selectedNode.mastery * 100)}%`, background: MASTERY_COLOR(selectedNode.mastery).border }}
                                    />
                                </div>
                                {selectedNode.isBlocked && (
                                    <p className="text-xs p-2 rounded-lg mb-3" style={{ background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b' }}>
                                        ⏳ Locked — complete prerequisites first ({Math.round(selectedNode.prereqMastery * 100)}% prereq mastery)
                                    </p>
                                )}
                                {selectedNode.linked_tasks.length > 0 && (
                                    <div>
                                        <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>LINKED TASKS</p>
                                        <div className="space-y-1">
                                            {selectedNode.linked_tasks.map(t => (
                                                <div key={t.id} className="flex items-center gap-2 text-xs">
                                                    <span>{t.status === 'done' ? '✅' : '○'}</span>
                                                    <span style={{ color: t.status === 'done' ? 'var(--text-muted)' : 'var(--text-primary)', textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>
                                                        {t.title}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {selectedNode.edges_out.length > 0 && (
                                    <div className="mt-3">
                                        <p className="text-xs font-semibold mb-1" style={{ color: 'var(--text-secondary)' }}>UNLOCKS</p>
                                        {selectedNode.edges_out.map(e => {
                                            const target = nodes.find(n => n.id === e.to_node_id);
                                            return target ? (
                                                <div key={e.to_node_id} className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                                    → {target.title}
                                                </div>
                                            ) : null;
                                        })}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Regen button if nodes exist */}
                        {nodes.length > 0 && (
                            <div className="card border rounded-xl p-4" style={{ borderColor: 'var(--border)', background: 'var(--bg-secondary)' }}>
                                <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>AI ACTIONS</p>
                                <select className="input-field text-xs py-1 w-full mb-2" value={difficulty} onChange={e => setDifficulty(e.target.value)}>
                                    <option value="beginner">Beginner</option>
                                    <option value="intermediate">Intermediate</option>
                                    <option value="advanced">Advanced</option>
                                </select>
                                <button className="w-full btn-primary text-xs py-2" onClick={generateConcepts} disabled={generating}>
                                    {generating ? '⏳ Generating...' : '✨ Re-generate Concepts'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {goals.length === 0 && <p className="text-sm text-center mt-10" style={{ color: 'var(--text-muted)' }}>No active goals found. Create goals first to build your knowledge graph.</p>}
        </div>
    );
}
