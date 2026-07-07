'use client';

import React, { useEffect, useState } from 'react';
import { scoreColor as adaptiveScoreColor } from '@/lib/score-classify';

interface GuardianFeedMessage {
    text: string;
    tone: string;
    time: number;
}

export default function GuardianDashboard({ sessionId, plannedMinutes, targetTitle, startedAt }: { sessionId: string, plannedMinutes: number, targetTitle: string, startedAt?: number }) {
    const [score, setScore] = useState<number>(100);
    const [trend, setTrend] = useState<number>(0);
    const [messages, setMessages] = useState<GuardianFeedMessage[]>([]);
    const [elapsed, setElapsed] = useState<number>(() => startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0);
    const [history, setHistory] = useState<number[]>([100]);
    const [onTopicTime, setOnTopicTime] = useState<number>(0);
    const [distractions, setDistractions] = useState<number>(0);

    // SSE Subscription
    useEffect(() => {
        if (!sessionId) return;
        const sse = new EventSource(`/api/guardian/stream?sessionId=${sessionId}`);

        sse.onmessage = (event) => {
            const data = JSON.parse(event.data);
            if (data.type === 'focus_score') {
                setScore(data.score);
                setTrend(data.delta);
                setHistory(prev => [...prev.slice(-19), data.score]);
            } else if (data.type === 'jarvis_speech') {
                setMessages(prev => [{ text: data.text, tone: String(data.tone ?? ''), time: Date.now() }, ...prev].slice(0, 3));
            } else if (data.type === 'session_stats') {
                setOnTopicTime(data.onTopicTime || 0);
                setDistractions(data.distractions || 0);
                setElapsed(data.elapsed || 0);
            }
        };

        return () => sse.close();
    }, [sessionId]);

    // Local display timer between stream updates
    useEffect(() => {
        if (!sessionId) return;

        const tickTimer = setInterval(() => {
            setElapsed(e => e + 1);
        }, 1000);

        return () => {
            clearInterval(tickTimer);
        };
    }, [sessionId]);

    const formatTime = (sec: number) => {
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const scoreColor = adaptiveScoreColor(score);

    return (
        <div className="w-full max-w-4xl mx-auto p-8 bg-zinc-950 text-white rounded-2xl shadow-2xl relative overflow-hidden">
            {/* Context Header */}
            <div className="flex justify-between items-center mb-12">
                <div>
                    <div className="text-zinc-500 text-xs font-bold tracking-widest uppercase mb-1">Active Session</div>
                    <div className="text-2xl font-black tracking-tight text-blue-400">{targetTitle}</div>
                </div>
                <div className="text-right">
                    <div className="text-4xl font-black font-mono tracking-tighter">{formatTime(elapsed)}</div>
                    <div className="text-zinc-500 text-sm mt-1">/ {plannedMinutes} min planned</div>
                </div>
            </div>

            {/* Core Cockpit */}
            <div className="grid grid-cols-3 gap-8 mb-12">
                {/* Live Focus Score */}
                <div className="col-span-1 border border-zinc-800 rounded-xl p-6 flex flex-col items-center justify-center relative bg-zinc-900/50">
                    <div className="text-zinc-500 text-xs font-bold tracking-widest uppercase mb-4">Live Focus</div>
                    <div className="relative group flex items-center justify-center">
                        <svg className="w-48 h-48 transform -rotate-90">
                            <circle cx="96" cy="96" r="88" fill="none" stroke="#27272a" strokeWidth="8" />
                            <circle cx="96" cy="96" r="88" fill="none" stroke={scoreColor} strokeWidth="8"
                                strokeDasharray="552.9" strokeDashoffset={552.9 - (552.9 * score) / 100}
                                className="transition-all duration-1000 ease-out" />
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <div className="text-6xl font-black tracking-tighter" style={{ color: scoreColor }}>{score}</div>
                            <div className="text-zinc-400 text-sm mt-2 font-bold">{trend >= 0 ? '+' : ''}{trend} pts</div>
                        </div>
                    </div>
                </div>

                {/* Agent Interventions */}
                <div className="col-span-2 border border-zinc-800 rounded-xl p-6 bg-zinc-900/50 flex flex-col">
                    <div className="flex justify-between items-center mb-6">
                        <div className="text-zinc-500 text-xs font-bold tracking-widest uppercase">Guardian Feed</div>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
                            <span className="text-xs text-blue-500 font-medium uppercase tracking-widest">Live</span>
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-4">
                        {messages.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-zinc-600">
                                <span className="text-2xl mb-2">🛡️</span>
                                <p className="text-sm">Guardian is silent. Keep working.</p>
                            </div>
                        ) : (
                            messages.map((m, i) => (
                                <div key={i} className={`p-4 rounded-lg border ${i === 0 ? 'border-zinc-700 bg-zinc-800/80 shadow-md' : 'border-zinc-800/50 bg-zinc-900/30'} flex items-start gap-4 transition-all`}>
                                    <div className="mt-1">
                                        {m.tone === 'direct_push' ? '🛑' : m.tone === 'flow_confirmed' ? '🌊' : '🎙️'}
                                    </div>
                                    <div className="flex-1">
                                        <p className="text-zinc-100 font-medium leading-relaxed">{m.text}</p>
                                        <p className="text-zinc-500 text-xs mt-2 uppercase tracking-wide">{m.tone.replace('_', ' ')} • Just now</p>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>

            {/* Sparkline & Stats Row */}
            <div className="grid grid-cols-4 gap-4">
                <div className="col-span-2 bg-zinc-900 rounded-lg border border-zinc-800 p-4">
                    <div className="text-zinc-500 text-xs font-bold tracking-widest mb-3 uppercase">Session Trend (Last 10 min)</div>
                    <div className="h-16 flex items-end gap-1">
                        {history.map((h, i) => (
                            <div key={i} className="flex-1 bg-blue-500/20 rounded-t border-t border-blue-500 transition-all" style={{ height: `${h}%` }}></div>
                        ))}
                    </div>
                </div>
                <div className="col-span-1 bg-zinc-900 rounded-lg border border-zinc-800 p-4 flex flex-col justify-center">
                    <div className="text-zinc-500 text-xs font-bold tracking-widest uppercase mb-1">On-Topic Time</div>
                    <div className="text-2xl font-bold text-white">{Math.round((onTopicTime / Math.max(1, elapsed)) * 100)}%</div>
                </div>
                <div className="col-span-1 bg-zinc-900 rounded-lg border border-zinc-800 p-4 flex flex-col justify-center">
                    <div className="text-zinc-500 text-xs font-bold tracking-widest uppercase mb-1">Distractions</div>
                    <div className="text-2xl font-bold text-zinc-400">{distractions}</div>
                </div>
            </div>

            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-600 via-indigo-500 to-purple-500 animate-pulse"></div>
        </div>
    );
}
