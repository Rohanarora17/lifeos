'use client';

import { useState, useRef, useEffect } from 'react';

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

interface ChatContext {
    personalization?: {
        mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
        guidance: string;
        energy: 'high' | 'medium' | 'low';
        mood: 'high' | 'medium' | 'low' | null;
        plannedFocus?: {
            plannedToday: number;
            completedToday: number;
            skippedToday: number;
            nextTitle: string | null;
            nextMinutes: number | null;
            recentFollowThroughRate: number | null;
        };
        nextBestFocusWindow: string;
    };
}

const modeLabel: Record<NonNullable<ChatContext['personalization']>['mode'], string> = {
    protect_focus: 'protect focus',
    deadline_pressure: 'deadline pressure',
    recovery: 'recovery',
    planning: 'planning',
    normal: 'balanced',
};

function buildGreeting(context: ChatContext | null) {
    const personalization = context?.personalization;
    if (!personalization) {
        return "Hello. I’m loading your LifeOS context so this chat can use your tasks, focus sessions, plans, and feedback.";
    }

    const planned = personalization.plannedFocus;
    if (planned?.nextTitle) {
        return `You’re in ${modeLabel[personalization.mode]} mode with ${personalization.energy} energy.\n\nNext planned focus: **${planned.nextTitle}**${planned.nextMinutes ? ` for ${planned.nextMinutes}m` : ''}. Ask me to protect it, resize it, or move it around today’s constraints.`;
    }

    if (planned && planned.plannedToday > 0 && planned.completedToday < planned.plannedToday) {
        return `You’re in ${modeLabel[personalization.mode]} mode. Planned focus is at ${planned.completedToday}/${planned.plannedToday} blocks today.\n\nAsk me what to do next, or how to recover the remaining plan without adding noise.`;
    }

    return `You’re in ${modeLabel[personalization.mode]} mode with ${personalization.energy} energy.\n\n${personalization.guidance}`;
}

function buildPlaceholder(context: ChatContext | null) {
    const personalization = context?.personalization;
    if (!personalization) return 'Loading your current context...';
    if (personalization.plannedFocus?.nextTitle) return `Ask about ${personalization.plannedFocus.nextTitle}...`;
    if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
        return 'Ask for the smallest useful next step...';
    }
    if (personalization.mode === 'planning') return 'Ask how to shape tomorrow...';
    if (personalization.mode === 'deadline_pressure') return 'Ask what relieves pressure next...';
    return 'Ask from today’s actual context...';
}

export default function ChatPage() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [context, setContext] = useState<ChatContext | null>(null);
    const [contextLoaded, setContextLoaded] = useState(false);
    const endRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        fetch('/api/dashboard')
            .then(r => r.json())
            .then((data: ChatContext) => setContext(data))
            .catch(() => setContext(null))
            .finally(() => setContextLoaded(true));
    }, []);

    // Initial greeting
    useEffect(() => {
        if (contextLoaded && messages.length === 0) {
            setMessages([{
                id: '0',
                role: 'assistant',
                content: buildGreeting(context),
            }]);
        }
    }, [context, contextLoaded, messages.length]);

    const scrollToBottom = () => {
        endRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleSend = async () => {
        if (!input.trim() || loading) return;

        const val = input.trim();
        setInput('');

        const newUserMsg: ChatMessage = { id: Date.now().toString(), role: 'user', content: val };
        const updatedMessages = [...messages, newUserMsg];
        setMessages(updatedMessages);
        setLoading(true);

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: updatedMessages.map(m => ({ role: m.role, content: m.content })) })
            });

            if (!res.ok || !res.body) {
                const data = await res.json().catch(() => ({}));
                setMessages(prev => [...prev, {
                    id: (Date.now() + 1).toString(),
                    role: 'assistant',
                    content: data.text || 'I encountered an error connecting to my cognition engine.'
                }]);
                return;
            }

            // Streaming response — show tokens as they arrive
            const msgId = (Date.now() + 1).toString();
            setMessages(prev => [...prev, { id: msgId, role: 'assistant', content: '' }]);
            setLoading(false);

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                fullText += decoder.decode(value, { stream: true });
                setMessages(prev => prev.map(m => m.id === msgId ? { ...m, content: fullText } : m));
            }
        } catch (error) {
            setMessages(prev => [...prev, {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: 'Network error communicating with the server.'
            }]);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="max-w-4xl mx-auto h-[calc(100vh-6rem)] flex flex-col">
            <header className="mb-6">
                <h1 className="text-2xl font-black mb-1">Jarvis Chat 💬</h1>
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    {context?.personalization
                        ? `${modeLabel[context.personalization.mode]} · ${context.personalization.energy} energy · ${context.personalization.guidance}`
                        : 'Loading today’s LifeOS context...'}
                </p>
            </header>

            <div className="flex-1 card flex flex-col overflow-hidden" style={{ border: '2px solid var(--border)' }}>
                {/* Chat Area */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                    {messages.map(m => (
                        <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                            <div
                                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed`}
                                style={{
                                    background: m.role === 'user' ? 'var(--gradient-primary)' : 'var(--bg-secondary)',
                                    color: m.role === 'user' ? 'black' : 'var(--text-primary)',
                                    borderBottomRightRadius: m.role === 'user' ? '4px' : '16px',
                                    borderBottomLeftRadius: m.role === 'assistant' ? '4px' : '16px',
                                }}
                            >
                                {m.content}
                            </div>
                        </div>
                    ))}
                    {loading && (
                        <div className="flex justify-start">
                            <div className="max-w-[80%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm bg-[var(--bg-secondary)] flex gap-2 items-center">
                                <span className="animate-bounce">●</span>
                                <span className="animate-bounce" style={{ animationDelay: '0.2s' }}>●</span>
                                <span className="animate-bounce" style={{ animationDelay: '0.4s' }}>●</span>
                            </div>
                        </div>
                    )}
                    <div ref={endRef} />
                </div>

                {/* Input Area */}
                <div className="p-4 border-t" style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
                    <div className="flex items-center gap-3">
                        <input
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleSend()}
                            placeholder={buildPlaceholder(context)}
                            className="input flex-1"
                            disabled={loading}
                        />
                        <button
                            onClick={handleSend}
                            disabled={loading || !input.trim()}
                            className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform hover:scale-105"
                            style={{ background: 'var(--gradient-primary)', color: '#000' }}
                        >
                            ➤
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
