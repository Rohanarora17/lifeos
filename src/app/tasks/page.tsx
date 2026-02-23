'use client';

import { useEffect, useState, useRef } from 'react';

interface Task {
    id: number;
    title: string;
    description: string;
    status: string;
    priority: string;
    due_date: string | null;
    created_at: string;
    completed_at: string | null;
    position: number;
    goal_id: number | null;
}

interface DayHistory {
    date: string;
    tasks_assigned: number;
    tasks_completed: number;
    tasks_pending: number;
    task_score: number | null;
}

interface CompletedTask {
    title: string;
    completed_date: string;
    created_date: string;
}

const COLUMNS = [
    { id: 'backlog', label: 'Backlog', icon: '📥', color: 'var(--text-muted)' },
    { id: 'next', label: 'Next', icon: '📌', color: 'var(--accent-blue)' },
    { id: 'this_week', label: 'This Week', icon: '📅', color: 'var(--accent-purple)' },
    { id: 'today', label: 'Today', icon: '🎯', color: 'var(--accent-orange)' },
    { id: 'doing', label: 'Doing', icon: '⚡', color: 'var(--accent-yellow)' },
    { id: 'done', label: 'Done', icon: '✅', color: 'var(--accent-green)' },
];

export default function TasksPage() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [newTaskCol, setNewTaskCol] = useState<string | null>(null);
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [draggedTask, setDraggedTask] = useState<Task | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState<DayHistory[]>([]);
    const [completedTasks, setCompletedTasks] = useState<CompletedTask[]>([]);
    const [selectedDay, setSelectedDay] = useState<string | null>(null);
    const [newTaskPriority, setNewTaskPriority] = useState('medium');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        fetchTasks();
    }, []);

    useEffect(() => {
        if (newTaskCol && inputRef.current) inputRef.current.focus();
    }, [newTaskCol]);

    useEffect(() => {
        if (showHistory) fetchHistory();
    }, [showHistory]);

    const fetchTasks = async () => {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        setTasks(data.tasks || []);
    };

    const fetchHistory = async () => {
        const res = await fetch('/api/tasks?history=true&days=14');
        const data = await res.json();
        setHistory(data.history || []);
        setCompletedTasks(data.completedTasks || []);
    };

    const addTask = async (status: string) => {
        if (!newTaskTitle.trim()) return;
        await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTaskTitle.trim(), status, priority: newTaskPriority }),
        });
        setNewTaskTitle('');
        setNewTaskPriority('medium');
        setNewTaskCol(null);
        fetchTasks();
    };

    const moveTask = async (taskId: number, newStatus: string) => {
        await fetch('/api/tasks', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: taskId, status: newStatus }),
        });
        fetchTasks();
    };

    const deleteTask = async (taskId: number) => {
        await fetch(`/api/tasks?id=${taskId}`, { method: 'DELETE' });
        fetchTasks();
    };

    const handleDragStart = (task: Task) => {
        setDraggedTask(task);
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault();
    };

    const handleDrop = (columnId: string) => {
        if (draggedTask && draggedTask.status !== columnId) {
            moveTask(draggedTask.id, columnId);
        }
        setDraggedTask(null);
    };

    const getScoreColor = (score: number | null) => {
        if (score === null) return 'var(--text-muted)';
        if (score >= 80) return 'var(--accent-green)';
        if (score >= 50) return 'var(--accent-yellow)';
        if (score >= 25) return 'var(--accent-orange)';
        return 'var(--accent-red)';
    };

    const formatDate = (dateStr: string) => {
        const d = new Date(dateStr + 'T00:00:00');
        const today = new Date().toISOString().slice(0, 10);
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        if (dateStr === today) return 'Today';
        if (dateStr === yesterday) return 'Yesterday';
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    };

    const dayCompletedTasks = selectedDay
        ? completedTasks.filter(t => t.completed_date === selectedDay)
        : [];

    return (
        <div className="animate-fade-in">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Tasks 📋</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        {showHistory ? 'Day-by-day task performance' : 'Drag tasks between columns to update their status'}
                    </p>
                </div>
                <button
                    className="btn btn-ghost"
                    onClick={() => { setShowHistory(!showHistory); setSelectedDay(null); }}
                    style={{ fontSize: '0.85rem' }}
                >
                    {showHistory ? '📋 Board View' : '📊 History'}
                </button>
            </div>

            {showHistory ? (
                <div>
                    {/* Score Bar Chart */}
                    <div className="card mb-6" style={{ padding: '1.5rem' }}>
                        <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>
                            Task Score — Last 14 Days
                        </h3>
                        <div className="flex items-end gap-1" style={{ height: '120px' }}>
                            {history.map(day => (
                                <div
                                    key={day.date}
                                    className="flex-1 flex flex-col items-center justify-end cursor-pointer transition-opacity"
                                    style={{ opacity: selectedDay === day.date ? 1 : 0.7 }}
                                    onClick={() => setSelectedDay(selectedDay === day.date ? null : day.date)}
                                >
                                    <div
                                        className="w-full rounded-t transition-all"
                                        style={{
                                            height: `${Math.max(day.task_score ?? 0, 4)}%`,
                                            background: getScoreColor(day.task_score),
                                            minHeight: day.tasks_assigned > 0 ? '4px' : '0',
                                            border: selectedDay === day.date ? '2px solid var(--text-primary)' : 'none',
                                        }}
                                    />
                                    <span className="text-xs mt-1" style={{ color: 'var(--text-muted)', fontSize: '0.6rem' }}>
                                        {new Date(day.date + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric' })}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>

                    {/* Daily Breakdown Table */}
                    <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                    <th style={{ padding: '0.75rem 1rem', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600 }}>Day</th>
                                    <th style={{ padding: '0.75rem 1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600 }}>Assigned</th>
                                    <th style={{ padding: '0.75rem 1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600 }}>Done</th>
                                    <th style={{ padding: '0.75rem 1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600 }}>Pending</th>
                                    <th style={{ padding: '0.75rem 1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600 }}>Score</th>
                                </tr>
                            </thead>
                            <tbody>
                                {[...history].reverse().map(day => (
                                    <tr
                                        key={day.date}
                                        onClick={() => setSelectedDay(selectedDay === day.date ? null : day.date)}
                                        style={{
                                            borderBottom: '1px solid var(--border)',
                                            cursor: 'pointer',
                                            background: selectedDay === day.date ? 'var(--bg-card-hover)' : 'transparent',
                                        }}
                                    >
                                        <td style={{ padding: '0.75rem 1rem', fontSize: '0.85rem' }}>{formatDate(day.date)}</td>
                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center', fontSize: '0.85rem' }}>
                                            {day.tasks_assigned > 0 ? day.tasks_assigned : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                        </td>
                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center', fontSize: '0.85rem', color: 'var(--accent-green)' }}>
                                            {day.tasks_completed > 0 ? day.tasks_completed : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                                        </td>
                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center', fontSize: '0.85rem', color: day.tasks_pending > 0 ? 'var(--accent-orange)' : 'var(--text-muted)' }}>
                                            {day.tasks_pending > 0 ? day.tasks_pending : '—'}
                                        </td>
                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                                            {day.task_score !== null ? (
                                                <span className="badge" style={{
                                                    background: `${getScoreColor(day.task_score)}22`,
                                                    color: getScoreColor(day.task_score),
                                                    fontWeight: 700,
                                                    fontSize: '0.75rem',
                                                }}>
                                                    {day.task_score}%
                                                </span>
                                            ) : (
                                                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>—</span>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Drilldown: tasks completed on selected day */}
                    {selectedDay && dayCompletedTasks.length > 0 && (
                        <div className="card mt-4" style={{ padding: '1rem' }}>
                            <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                                ✅ Completed on {formatDate(selectedDay)}
                            </h4>
                            <div className="flex flex-col gap-2">
                                {dayCompletedTasks.map((t, i) => (
                                    <div key={i} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                                        <span style={{ color: 'var(--accent-green)' }}>✓</span>
                                        <span>{t.title}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {selectedDay && dayCompletedTasks.length === 0 && (
                        <div className="card mt-4" style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                            No tasks completed on {formatDate(selectedDay)}
                        </div>
                    )}
                </div>
            ) : (
                // Kanban Board
                <div className="flex gap-4 overflow-x-auto pb-4" style={{ minHeight: 'calc(100vh - 200px)' }}>
                    {COLUMNS.map(col => {
                        const colTasks = tasks.filter(t => t.status === col.id);
                        return (
                            <div
                                key={col.id}
                                className="kanban-column flex-shrink-0"
                                onDragOver={handleDragOver}
                                onDrop={() => handleDrop(col.id)}
                            >
                                <div className="kanban-column-header">
                                    <span>{col.icon}</span>
                                    <span>{col.label}</span>
                                    <span className="ml-auto badge" style={{
                                        background: 'var(--bg-card)',
                                        color: col.color,
                                        fontSize: '0.75rem'
                                    }}>{colTasks.length}</span>
                                </div>

                                <div className="flex-1 overflow-y-auto p-1">
                                    {colTasks.map(task => (
                                        <div
                                            key={task.id}
                                            className={`kanban-card ${draggedTask?.id === task.id ? 'dragging' : ''}`}
                                            draggable
                                            onDragStart={() => handleDragStart(task)}
                                            onDragEnd={() => setDraggedTask(null)}
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex items-start gap-2">
                                                    <div className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{
                                                        background: task.priority === 'critical' ? 'var(--accent-red)'
                                                            : task.priority === 'high' ? 'var(--accent-orange)'
                                                                : task.priority === 'low' ? 'var(--text-muted)'
                                                                    : 'var(--accent-blue)'
                                                    }} />
                                                    <p className="text-sm font-medium leading-snug">{task.title}</p>
                                                </div>
                                                <button
                                                    onClick={() => deleteTask(task.id)}
                                                    className="text-xs opacity-0 hover:opacity-100 transition-opacity flex-shrink-0"
                                                    style={{ color: 'var(--text-muted)' }}
                                                >✕</button>
                                            </div>
                                            {task.due_date && (
                                                <div className="mt-2 flex items-center gap-1">
                                                    <span className="badge badge-red text-xs">
                                                        📅 {new Date(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                                    </span>
                                                </div>
                                            )}
                                            {task.description && (
                                                <p className="text-xs mt-2 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                                                    {task.description}
                                                </p>
                                            )}
                                        </div>
                                    ))}
                                </div>

                                {/* Add task */}
                                <div className="p-2 border-t" style={{ borderColor: 'var(--border)' }}>
                                    {newTaskCol === col.id ? (
                                        <div>
                                            <input
                                                ref={inputRef}
                                                type="text"
                                                className="input mb-2"
                                                placeholder="Task title..."
                                                value={newTaskTitle}
                                                onChange={e => setNewTaskTitle(e.target.value)}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') addTask(col.id);
                                                    if (e.key === 'Escape') { setNewTaskCol(null); setNewTaskTitle(''); }
                                                }}
                                            />
                                            <div className="flex gap-2">
                                                <select className="input text-xs" style={{ width: '5rem' }} value={newTaskPriority} onChange={e => setNewTaskPriority(e.target.value)}>
                                                    <option value="low">Low</option>
                                                    <option value="medium">Medium</option>
                                                    <option value="high">High</option>
                                                    <option value="critical">Critical</option>
                                                </select>
                                                <button className="btn btn-primary btn-sm flex-1" onClick={() => addTask(col.id)}>Add</button>
                                                <button className="btn btn-ghost btn-sm" onClick={() => { setNewTaskCol(null); setNewTaskTitle(''); }}>Cancel</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <button
                                            className="w-full text-sm py-2 rounded-lg transition-colors"
                                            style={{ color: 'var(--text-muted)' }}
                                            onClick={() => setNewTaskCol(col.id)}
                                            onMouseOver={e => (e.target as HTMLElement).style.color = 'var(--text-primary)'}
                                            onMouseOut={e => (e.target as HTMLElement).style.color = 'var(--text-muted)'}
                                        >+ Add task</button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
