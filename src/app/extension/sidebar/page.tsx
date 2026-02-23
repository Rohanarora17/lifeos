'use client';

import { useState, useEffect } from 'react';

interface Task {
    id: number;
    title: string;
    priority: string;
}

export default function ExtensionSidebar() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [timeLeft, setTimeLeft] = useState(0); // in seconds
    const [isFocusing, setIsFocusing] = useState(false);
    const [focusDuration, setFocusDuration] = useState(25); // track chosen duration
    const [activeTaskId, setActiveTaskId] = useState<number | null>(null);

    // Fetch active session / tasks
    const fetchContext = async () => {
        try {
            const res = await fetch('/api/extension/session');
            const data = await res.json();
            if (res.ok && data.activeTasks) {
                setTasks(data.activeTasks);
            }
        } catch (e) { }
    };

    useEffect(() => {
        fetchContext();
        // Refresh every minute to stay synced with LifeOS dashboard
        const interval = setInterval(fetchContext, 60000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        let timer: ReturnType<typeof setInterval>;
        if (isFocusing && timeLeft > 0) {
            timer = setInterval(() => setTimeLeft(prev => prev - 1), 1000);
        } else if (isFocusing && timeLeft === 0) {
            // Timer complete
            setIsFocusing(false);
            finishFocusSession();
        }
        return () => clearInterval(timer);
    }, [isFocusing, timeLeft]);

    const startFocus = (minutes: number) => {
        setTimeLeft(minutes * 60);
        setFocusDuration(minutes);
        setIsFocusing(true);

        // Notify extension background script to log focus start
        try {
            if (window.parent !== window) {
                // We're inside the extension sidebar iframe — post to parent
                window.parent.postMessage({ type: 'LIFEOS_FOCUS_START', duration: minutes }, '*');
            }
        } catch (e) { /* not in extension context */ }
    };

    const finishFocusSession = async () => {
        // Notify extension background script
        try {
            if (window.parent !== window) {
                window.parent.postMessage({ type: 'LIFEOS_FOCUS_STOP', duration: focusDuration }, '*');
            }
        } catch (e) { /* not in extension context */ }

        await fetch('/api/focus', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                task_id: activeTaskId,
                duration_minutes: focusDuration
            })
        });
    };

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const markTaskDone = async (id: number) => {
        try {
            await fetch('/api/tasks', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, action: 'done' })
            });
            fetchContext();
        } catch (e) { }
    };

    return (
        <div className="flex flex-col h-full bg-[#0a0a0c] text-white p-2">

            {/* Focus Header */}
            <div className="text-center mb-6">
                <h1 className="text-xl font-black mb-1" style={{ color: 'var(--accent-orange)' }}>LifeOS</h1>
                <p className="text-xs text-gray-400">Context Engine Active</p>
            </div>

            {/* Pomodoro Timer */}
            <div className="card mb-6" style={{ padding: '15px', border: '1px solid #333', borderRadius: '12px', background: '#111' }}>
                <h2 className="text-sm font-bold mb-3 uppercase tracking-wider text-gray-300">Active Focus</h2>

                {isFocusing ? (
                    <div className="text-center py-4">
                        <div className="text-4xl font-black mb-2" style={{ color: 'var(--accent-green)' }}>
                            {formatTime(timeLeft)}
                        </div>
                        <button
                            className="bg-red-500 hover:bg-red-600 text-white text-xs px-3 py-1 rounded"
                            onClick={() => setIsFocusing(false)}
                        >
                            Abandon
                        </button>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <select
                            className="w-full bg-[#222] text-sm p-2 rounded border border-[#333] text-white"
                            onChange={(e) => setActiveTaskId(e.target.value ? parseInt(e.target.value) : null)}
                        >
                            <option value="">No specific task</option>
                            {tasks.map(t => (
                                <option key={t.id} value={t.id}>{t.title}</option>
                            ))}
                        </select>
                        <button
                            className="w-full font-bold py-2 rounded transition-colors"
                            style={{ background: 'var(--accent-orange)', color: 'white' }}
                            onClick={() => startFocus(25)}
                        >
                            Start Pomodoro (25m)
                        </button>
                    </div>
                )}
            </div>

            <hr className="border-[#333] mb-6" />

            {/* Task View */}
            <div>
                <h2 className="text-sm font-bold mb-3 uppercase tracking-wider text-gray-300">Today's Blueprint</h2>
                <div className="space-y-2">
                    {tasks.length === 0 ? (
                        <p className="text-xs text-center text-gray-500 py-4">No active tasks. Highlight text to capture!</p>
                    ) : (
                        tasks.map(t => (
                            <div key={t.id} className="flex items-center gap-2 p-2 rounded bg-[#111] border border-[#222]">
                                <input
                                    type="checkbox"
                                    className="w-4 h-4 rounded cursor-pointer accent-[#ffA500]"
                                    onChange={() => markTaskDone(t.id)}
                                />
                                <span className="text-sm truncate flex-1 leading-tight">{t.title}</span>
                                {t.priority === 'critical' && <span className="text-red-500 text-xs">●</span>}
                            </div>
                        ))
                    )}
                </div>
            </div>

        </div>
    );
}
