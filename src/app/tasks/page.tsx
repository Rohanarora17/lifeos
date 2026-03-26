'use client';

import { useEffect, useState, useRef, useCallback } from 'react';

interface Task {
    id: number;
    title: string;
    description: string;
    status: string;
    priority: string;
    task_type: string;
    course: string | null;
    due_date: string | null;
    due_time: string | null;
    priority_rank: number | null;
    priority_reason: string | null;
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
    { id: 'todo', label: 'Todo', color: 'var(--text-muted)' },
    { id: 'doing', label: 'Doing', color: 'var(--accent-yellow)' },
    { id: 'done', label: 'Done', color: 'var(--accent-green)' },
];

function daysUntil(due: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dueDate = new Date(due + 'T00:00:00');
    return Math.round((dueDate.getTime() - today.getTime()) / 86400000);
}

function DeadlineBadge({ due_date, due_time }: { due_date: string; due_time: string | null }) {
    const days = daysUntil(due_date);
    const timeLabel = due_time ? ` ${due_time}` : '';
    let label: string;
    let color: string;
    let bg: string;

    if (days < 0) {
        label = `Overdue (${Math.abs(days)}d)`;
        color = 'var(--accent-red)';
        bg = 'rgba(220,53,69,0.15)';
    } else if (days === 0) {
        label = `Due today${timeLabel}`;
        color = 'var(--accent-red)';
        bg = 'rgba(220,53,69,0.15)';
    } else if (days === 1) {
        label = `Tomorrow${timeLabel}`;
        color = 'var(--accent-orange)';
        bg = 'rgba(255,152,0,0.15)';
    } else if (days <= 3) {
        label = `in ${days}d${timeLabel}`;
        color = 'var(--accent-orange)';
        bg = 'rgba(255,152,0,0.15)';
    } else {
        label = `in ${days}d`;
        color = 'var(--text-muted)';
        bg = 'var(--bg-card)';
    }

    return (
        <span style={{
            display: 'inline-block',
            fontSize: '0.68rem',
            fontWeight: 600,
            padding: '1px 6px',
            borderRadius: '4px',
            color,
            background: bg,
            letterSpacing: '0.01em',
        }}>
            {label}
        </span>
    );
}

function TypeBadge({ task_type }: { task_type: string }) {
    if (task_type === 'task') return null;
    const isExam = task_type === 'exam';
    return (
        <span style={{
            display: 'inline-block',
            fontSize: '0.65rem',
            fontWeight: 700,
            padding: '1px 5px',
            borderRadius: '3px',
            color: isExam ? 'var(--accent-red)' : 'var(--accent-blue)',
            background: isExam ? 'rgba(220,53,69,0.12)' : 'rgba(13,110,253,0.12)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
        }}>
            {task_type}
        </span>
    );
}

export default function TasksPage() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [newTaskCol, setNewTaskCol] = useState<string | null>(null);
    const [newTaskTitle, setNewTaskTitle] = useState('');
    const [newTaskPriority, setNewTaskPriority] = useState('medium');
    const [newTaskType, setNewTaskType] = useState('task');
    const [newTaskCourse, setNewTaskCourse] = useState('');
    const [newTaskDue, setNewTaskDue] = useState('');
    const [draggedTask, setDraggedTask] = useState<Task | null>(null);
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState<DayHistory[]>([]);
    const [completedTasks, setCompletedTasks] = useState<CompletedTask[]>([]);
    const [selectedDay, setSelectedDay] = useState<string | null>(null);
    const [editingTaskId, setEditingTaskId] = useState<number | null>(null);
    const [editingTitle, setEditingTitle] = useState('');
    const [reprioritizing, setReprioritizing] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const fetchTasks = useCallback(async () => {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        setTasks(data.tasks || []);
    }, []);

    useEffect(() => { fetchTasks(); }, [fetchTasks]);
    useEffect(() => { if (newTaskCol && inputRef.current) inputRef.current.focus(); }, [newTaskCol]);

    const fetchHistory = useCallback(async () => {
        const res = await fetch('/api/tasks?history=true&days=14');
        const data = await res.json();
        setHistory(data.history || []);
        setCompletedTasks(data.completedTasks || []);
    }, []);

    useEffect(() => { if (showHistory) fetchHistory(); }, [showHistory, fetchHistory]);

    const addTask = async (status: string) => {
        if (!newTaskTitle.trim()) return;
        await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: newTaskTitle.trim(),
                status,
                priority: newTaskPriority,
                task_type: newTaskType,
                course: newTaskCourse.trim() || null,
                due_date: newTaskDue || null,
            }),
        });
        setNewTaskTitle('');
        setNewTaskPriority('medium');
        setNewTaskType('task');
        setNewTaskCourse('');
        setNewTaskDue('');
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

    const saveTaskTitle = async (taskId: number) => {
        const trimmed = editingTitle.trim();
        if (trimmed) {
            await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: taskId, title: trimmed }),
            });
            fetchTasks();
        }
        setEditingTaskId(null);
    };

    const reprioritize = async () => {
        setReprioritizing(true);
        await fetch('/api/tasks/prioritize', { method: 'POST' });
        await fetchTasks();
        setReprioritizing(false);
    };

    const handleDrop = (columnId: string) => {
        if (draggedTask && draggedTask.status !== columnId) moveTask(draggedTask.id, columnId);
        setDraggedTask(null);
    };

    const getScoreColor = (score: number | null) => {
        if (score === null) return 'var(--text-muted)';
        if (score >= 80) return 'var(--accent-green)';
        if (score >= 50) return 'var(--accent-yellow)';
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

    const dayCompletedTasks = selectedDay ? completedTasks.filter(t => t.completed_date === selectedDay) : [];

    return (
        <div className="animate-fade-in">
            {/* Header */}
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Tasks</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        {showHistory ? 'Day-by-day task performance' : 'Drag between columns to update status'}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {!showHistory && (
                        <button
                            className="btn btn-ghost"
                            onClick={reprioritize}
                            disabled={reprioritizing}
                            title="Re-rank all tasks with AI"
                            style={{ fontSize: '0.82rem', opacity: reprioritizing ? 0.6 : 1 }}
                        >
                            {reprioritizing ? 'Ranking...' : 'Re-prioritize'}
                        </button>
                    )}
                    <button
                        className="btn btn-ghost"
                        onClick={() => { setShowHistory(!showHistory); setSelectedDay(null); }}
                        style={{ fontSize: '0.85rem' }}
                    >
                        {showHistory ? 'Board' : 'History'}
                    </button>
                </div>
            </div>

            {showHistory ? (
                <div>
                    {/* Score Bar Chart */}
                    <div className="card mb-6" style={{ padding: '1.5rem' }}>
                        <h3 className="text-sm font-semibold mb-4" style={{ color: 'var(--text-secondary)' }}>
                            Task Completion — Last 14 Days
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

                    {/* Daily Table */}
                    <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                                    {['Day', 'Assigned', 'Done', 'Pending', 'Score'].map(h => (
                                        <th key={h} style={{ padding: '0.75rem 1rem', textAlign: h === 'Day' ? 'left' : 'center', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600 }}>{h}</th>
                                    ))}
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
                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center', fontSize: '0.85rem' }}>{day.tasks_assigned > 0 ? day.tasks_assigned : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center', fontSize: '0.85rem', color: 'var(--accent-green)' }}>{day.tasks_completed > 0 ? day.tasks_completed : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center', fontSize: '0.85rem', color: day.tasks_pending > 0 ? 'var(--accent-orange)' : 'var(--text-muted)' }}>{day.tasks_pending > 0 ? day.tasks_pending : '—'}</td>
                                        <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                                            {day.task_score !== null ? (
                                                <span className="badge" style={{ background: `${getScoreColor(day.task_score)}22`, color: getScoreColor(day.task_score), fontWeight: 700, fontSize: '0.75rem' }}>
                                                    {day.task_score}%
                                                </span>
                                            ) : <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>—</span>}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {selectedDay && dayCompletedTasks.length > 0 && (
                        <div className="card mt-4" style={{ padding: '1rem' }}>
                            <h4 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>
                                Completed on {formatDate(selectedDay)}
                            </h4>
                            <div className="flex flex-col gap-2">
                                {dayCompletedTasks.map((t, i) => (
                                    <div key={i} className="flex items-center gap-2 text-sm">
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
                // ─── Kanban Board ─────────────────────────────────────────────
                <div
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(3, 1fr)',
                        gap: '1rem',
                        minHeight: 'calc(100vh - 200px)',
                        alignItems: 'start',
                    }}
                >
                    {COLUMNS.map(col => {
                        // Tasks ordered by priority_rank then due_date (already pre-sorted by API)
                        const colTasks = tasks.filter(t => t.status === col.id);
                        return (
                            <div
                                key={col.id}
                                className="kanban-column"
                                style={{ minHeight: '200px' }}
                                onDragOver={e => e.preventDefault()}
                                onDrop={() => handleDrop(col.id)}
                            >
                                {/* Column Header */}
                                <div className="kanban-column-header">
                                    <span style={{ fontWeight: 700, color: col.color }}>{col.label}</span>
                                    <span className="ml-auto badge" style={{
                                        background: 'var(--bg-card)',
                                        color: col.color,
                                        fontSize: '0.75rem',
                                    }}>
                                        {colTasks.length}
                                    </span>
                                </div>

                                {/* Task Cards */}
                                <div className="flex-1 overflow-y-auto p-1">
                                    {colTasks.length === 0 && (
                                        <div style={{
                                            padding: '2rem 1rem',
                                            textAlign: 'center',
                                            color: 'var(--text-muted)',
                                            fontSize: '0.8rem',
                                        }}>
                                            No tasks
                                        </div>
                                    )}
                                    {colTasks.map(task => (
                                        <div
                                            key={task.id}
                                            className={`kanban-card ${draggedTask?.id === task.id ? 'dragging' : ''}`}
                                            draggable
                                            onDragStart={() => setDraggedTask(task)}
                                            onDragEnd={() => setDraggedTask(null)}
                                        >
                                            {/* Top row: rank badge + title + delete */}
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex items-start gap-2 flex-1 min-w-0">
                                                    {/* Priority rank badge */}
                                                    {task.priority_rank !== null && (
                                                        <span title={task.priority_reason ?? ''} style={{
                                                            flexShrink: 0,
                                                            fontSize: '0.65rem',
                                                            fontWeight: 800,
                                                            lineHeight: 1,
                                                            padding: '2px 5px',
                                                            borderRadius: '4px',
                                                            background: task.priority_rank === 1
                                                                ? 'rgba(220,53,69,0.18)'
                                                                : task.priority_rank <= 3
                                                                    ? 'rgba(255,152,0,0.15)'
                                                                    : 'var(--bg-card)',
                                                            color: task.priority_rank === 1
                                                                ? 'var(--accent-red)'
                                                                : task.priority_rank <= 3
                                                                    ? 'var(--accent-orange)'
                                                                    : 'var(--text-muted)',
                                                            marginTop: '2px',
                                                            cursor: task.priority_reason ? 'help' : 'default',
                                                        }}>
                                                            #{task.priority_rank}
                                                        </span>
                                                    )}

                                                    {/* Title */}
                                                    {editingTaskId === task.id ? (
                                                        <input
                                                            autoFocus
                                                            className="input text-sm font-medium"
                                                            style={{ padding: '2px 6px', height: 'auto', minWidth: 0 }}
                                                            value={editingTitle}
                                                            onChange={e => setEditingTitle(e.target.value)}
                                                            onBlur={() => saveTaskTitle(task.id)}
                                                            onKeyDown={e => {
                                                                if (e.key === 'Enter') saveTaskTitle(task.id);
                                                                if (e.key === 'Escape') setEditingTaskId(null);
                                                            }}
                                                        />
                                                    ) : (
                                                        <p
                                                            className="text-sm font-medium leading-snug cursor-text"
                                                            onClick={e => { e.stopPropagation(); setEditingTaskId(task.id); setEditingTitle(task.title); }}
                                                        >
                                                            {task.title}
                                                        </p>
                                                    )}
                                                </div>
                                                <button
                                                    onClick={() => deleteTask(task.id)}
                                                    className="text-xs opacity-0 hover:opacity-100 transition-opacity flex-shrink-0"
                                                    style={{ color: 'var(--text-muted)' }}
                                                >✕</button>
                                            </div>

                                            {/* Meta row: course tag + type badge */}
                                            {(task.course || task.task_type !== 'task') && (
                                                <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                                                    {task.course && (
                                                        <span style={{
                                                            fontSize: '0.68rem',
                                                            fontWeight: 600,
                                                            padding: '1px 6px',
                                                            borderRadius: '4px',
                                                            color: 'var(--accent-blue)',
                                                            background: 'rgba(13,110,253,0.1)',
                                                        }}>
                                                            {task.course}
                                                        </span>
                                                    )}
                                                    <TypeBadge task_type={task.task_type} />
                                                </div>
                                            )}

                                            {/* Priority reason (AI rationale) */}
                                            {task.priority_reason && (
                                                <p className="text-xs mt-1" style={{
                                                    color: 'var(--text-muted)',
                                                    fontStyle: 'italic',
                                                    lineHeight: 1.4,
                                                }}>
                                                    {task.priority_reason}
                                                </p>
                                            )}

                                            {/* Deadline badge */}
                                            {task.due_date && (
                                                <div className="mt-1.5">
                                                    <DeadlineBadge due_date={task.due_date} due_time={task.due_time} />
                                                </div>
                                            )}

                                            {/* Move buttons (quick shortcuts) */}
                                            <div className="flex gap-1 mt-2">
                                                {COLUMNS.filter(c => c.id !== col.id).map(c => (
                                                    <button
                                                        key={c.id}
                                                        onClick={() => moveTask(task.id, c.id)}
                                                        style={{
                                                            fontSize: '0.65rem',
                                                            padding: '2px 7px',
                                                            borderRadius: '4px',
                                                            border: '1px solid var(--border)',
                                                            background: 'transparent',
                                                            color: 'var(--text-muted)',
                                                            cursor: 'pointer',
                                                        }}
                                                        onMouseOver={e => (e.currentTarget.style.color = c.color)}
                                                        onMouseOut={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                                                    >
                                                        → {c.label}
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {/* Add task form */}
                                <div className="p-2 border-t" style={{ borderColor: 'var(--border)' }}>
                                    {newTaskCol === col.id ? (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                            <input
                                                ref={inputRef}
                                                type="text"
                                                className="input"
                                                placeholder="Task title..."
                                                value={newTaskTitle}
                                                onChange={e => setNewTaskTitle(e.target.value)}
                                                onKeyDown={e => {
                                                    if (e.key === 'Enter') addTask(col.id);
                                                    if (e.key === 'Escape') { setNewTaskCol(null); setNewTaskTitle(''); }
                                                }}
                                            />
                                            {/* Type + Course row */}
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                <select
                                                    className="input text-xs"
                                                    style={{ flex: '0 0 auto', width: '90px' }}
                                                    value={newTaskType}
                                                    onChange={e => setNewTaskType(e.target.value)}
                                                >
                                                    <option value="task">Task</option>
                                                    <option value="assignment">Assignment</option>
                                                    <option value="exam">Exam</option>
                                                </select>
                                                <input
                                                    type="text"
                                                    className="input text-xs"
                                                    placeholder="Course (e.g. CS 101)"
                                                    value={newTaskCourse}
                                                    onChange={e => setNewTaskCourse(e.target.value)}
                                                    style={{ flex: 1 }}
                                                />
                                            </div>
                                            {/* Priority + Due date row */}
                                            <div style={{ display: 'flex', gap: '6px' }}>
                                                <select
                                                    className="input text-xs"
                                                    style={{ flex: '0 0 auto', width: '80px' }}
                                                    value={newTaskPriority}
                                                    onChange={e => setNewTaskPriority(e.target.value)}
                                                >
                                                    <option value="low">Low</option>
                                                    <option value="medium">Medium</option>
                                                    <option value="high">High</option>
                                                    <option value="critical">Critical</option>
                                                </select>
                                                <input
                                                    type="date"
                                                    className="input text-xs"
                                                    value={newTaskDue}
                                                    onChange={e => setNewTaskDue(e.target.value)}
                                                    style={{ flex: 1 }}
                                                />
                                            </div>
                                            {/* Action buttons */}
                                            <div className="flex gap-2">
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
                                        >
                                            + Add task
                                        </button>
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
