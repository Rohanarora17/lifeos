'use client';

import { useEffect, useState, useRef } from 'react';

interface Task {
    id: number;
    title: string;
    description: string;
    status: string;
    due_date: string | null;
    created_at: string;
    completed_at: string | null;
    position: number;
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
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        fetchTasks();
    }, []);

    useEffect(() => {
        if (newTaskCol && inputRef.current) inputRef.current.focus();
    }, [newTaskCol]);

    const fetchTasks = async () => {
        const res = await fetch('/api/tasks');
        const data = await res.json();
        setTasks(data.tasks || []);
    };

    const addTask = async (status: string) => {
        if (!newTaskTitle.trim()) return;
        await fetch('/api/tasks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTaskTitle.trim(), status }),
        });
        setNewTaskTitle('');
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

    return (
        <div className="animate-fade-in">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Tasks 📋</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                        Drag tasks between columns to update their status
                    </p>
                </div>
            </div>

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
                                            <p className="text-sm font-medium leading-snug">{task.title}</p>
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
        </div>
    );
}
