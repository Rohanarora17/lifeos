'use client';

import { useState, useRef, useEffect } from 'react';

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
}

export default function ChatPage() {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const endRef = useRef<HTMLDivElement>(null);

    // Initial greeting
    useEffect(() => {
        if (messages.length === 0) {
            setMessages([{
                id: '0',
                role: 'assistant',
                content: "Hello! I'm your LifeOS Assistant. Ask me anything about your tasks, habits, or focus time.\n\nTry: *How many hours did I focus this week?*"
            }]);
        }
    }, [messages.length]);

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
        setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', content: val }]);
        setLoading(true);

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: val })
            });
            const data = await res.json();

            setMessages(prev => [...prev, {
                id: (Date.now() + 1).toString(),
                role: 'assistant',
                content: data.text || 'I encountered an error connecting to my cognition engine.'
            }]);
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
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Talk directly to your local database securely.</p>
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
                            placeholder="Ask me anything..."
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
