import React, { useState, useRef, useEffect } from 'react';

type CoachFeedback = 'helpful' | 'not_helpful' | 'dismissed';

interface CoachMessage {
    role: 'user' | 'assistant';
    content: string;
    outcomeId?: number | null;
    feedback?: CoachFeedback | null;
}

interface CoachContext {
    personalization?: {
        mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
        guidance: string;
        recommendedSessionMinutes: number;
        energy: 'high' | 'medium' | 'low';
        mood: 'high' | 'medium' | 'low' | null;
        standupGoal: string | null;
        nextBestFocusWindow: string;
        alertFatigueLevel: 'low' | 'medium' | 'high';
    };
    intelligence?: {
        recommendedTasks: Array<{
            id: number;
            title: string;
            reason: string;
            momentFit?: 'high' | 'medium' | 'low';
            estimatedMinutes?: number | null;
        }>;
    };
}

const modeLabel: Record<NonNullable<CoachContext['personalization']>['mode'], string> = {
    protect_focus: 'protect focus',
    deadline_pressure: 'deadline pressure',
    recovery: 'recovery',
    planning: 'planning',
    normal: 'balanced',
};

function feedbackButtonStyle(color: string): React.CSSProperties {
    return {
        background: `${color}1A`,
        color,
        border: `1px solid ${color}33`,
        borderRadius: '6px',
        padding: '2px 6px',
        fontSize: '10px',
        cursor: 'pointer',
    };
}

export default function AICoach() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<CoachMessage[]>([]);
    const [inputTitle, setInputTitle] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [context, setContext] = useState<CoachContext | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isOpen]);

    useEffect(() => {
        if (!isOpen) return;
        fetch('/api/dashboard')
            .then(r => r.json())
            .then((data: CoachContext) => setContext(data))
            .catch(() => setContext(null));
    }, [isOpen]);

    const parseMarkdown = (text: string) => {
        const html = text
            // Escape HTML to prevent basic XSS
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;")
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.3);padding:2px 4px;border-radius:3px;font-family:monospace;">$1</code>')
            .replace(/\n/g, '<br/>');
        return { __html: html };
    };

    const sendMessage = async (text: string) => {
        if (!text.trim()) return;

        const userMsg = text.trim();
        setInputTitle('');
        const history = [...messages, { role: 'user' as const, content: userMsg }];
        setMessages(history);
        setIsLoading(true);

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: history.map(({ role, content }) => ({ role, content }))
                })
            });

            const outcomeId = Number(res.headers.get('X-LifeOS-Outcome-Id')) || null;
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await res.json() as { text?: string; outcomeId?: number };
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: data.text || 'Sorry, I had trouble processing that.',
                    outcomeId: data.outcomeId ?? outcomeId,
                    feedback: null,
                }]);
            } else {
                const textResponse = await res.text();
                setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: textResponse || 'Sorry, I had trouble processing that.',
                    outcomeId,
                    feedback: null,
                }]);
            }
        } catch {
            setMessages(prev => [...prev, { role: 'assistant', content: "Error communicating with Jarvis.", feedback: null }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleSend = async () => {
        await sendMessage(inputTitle);
    };

    const sendFeedback = async (messageIndex: number, outcomeId: number, feedback: CoachFeedback) => {
        setMessages(prev => prev.map((message, index) => (
            index === messageIndex ? { ...message, feedback } : message
        )));
        await fetch('/api/chat/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ outcomeId, feedback }),
        }).catch(() => {
            setMessages(prev => prev.map((message, index) => (
                index === messageIndex ? { ...message, feedback: null } : message
            )));
        });
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const topTask = context?.intelligence?.recommendedTasks?.[0];
    const personalization = context?.personalization;
    const starterPrompts = [
        personalization ? `Given ${modeLabel[personalization.mode]} mode, what should I do next?` : 'What should I do next?',
        topTask ? `Help me start: ${topTask.title}` : null,
        personalization?.standupGoal ? `Keep me honest about: ${personalization.standupGoal}` : null,
    ].filter(Boolean) as string[];

    return (
        <div style={{ position: 'fixed', bottom: '30px', right: '30px', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
            {isOpen && (
                <div style={{
                    width: '350px',
                    height: '500px',
                    backgroundColor: '#1a1a24',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '12px',
                    marginBottom: '16px',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
                    overflow: 'hidden'
                }}>
                    {/* Header */}
                    <div style={{ padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#232333' }}>
                        <div>
                            <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                Jarvis Coach
                            </h3>
                            {personalization && (
                                <p style={{ margin: '4px 0 0', color: '#a1a1aa', fontSize: '11px' }}>
                                    {modeLabel[personalization.mode]} · {personalization.energy} energy · {personalization.recommendedSessionMinutes}m default
                                </p>
                            )}
                        </div>
                        <button onClick={() => setIsOpen(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' }}>
                            ✕
                        </button>
                    </div>

                    {/* Messages Area */}
                    <div style={{ flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {messages.length === 0 ? (
                            <div style={{ color: '#a1a1aa', marginTop: '24px', fontSize: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                <div style={{ textAlign: 'center' }}>
                                    <div style={{ color: '#f8fafc', fontWeight: 600, marginBottom: '6px' }}>
                                        {personalization ? `${modeLabel[personalization.mode]} mode` : 'Loading your current mode...'}
                                    </div>
                                    <div style={{ fontSize: '12px', lineHeight: 1.5 }}>
                                        {personalization?.guidance || 'Jarvis will use your current tasks, energy, feedback, and day context.'}
                                    </div>
                                </div>
                                {topTask && (
                                    <div style={{
                                        border: '1px solid rgba(102,126,234,0.25)',
                                        background: 'rgba(102,126,234,0.08)',
                                        borderRadius: '8px',
                                        padding: '10px',
                                    }}>
                                        <div style={{ fontSize: '11px', color: '#93c5fd', marginBottom: '4px' }}>Current best pick</div>
                                        <div style={{ color: '#f8fafc', fontSize: '13px', fontWeight: 600 }}>{topTask.title}</div>
                                        <div style={{ color: '#a1a1aa', fontSize: '11px', marginTop: '4px' }}>{topTask.reason}</div>
                                    </div>
                                )}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    {starterPrompts.map(prompt => (
                                        <button
                                            key={prompt}
                                            onClick={() => sendMessage(prompt)}
                                            disabled={isLoading}
                                            style={{
                                                textAlign: 'left',
                                                border: '1px solid rgba(255,255,255,0.08)',
                                                background: 'rgba(255,255,255,0.04)',
                                                color: '#e5e7eb',
                                                borderRadius: '8px',
                                                padding: '8px 10px',
                                                fontSize: '12px',
                                                cursor: isLoading ? 'not-allowed' : 'pointer',
                                            }}
                                        >
                                            {prompt}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            messages.map((m, idx) => (
                                <div key={idx} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                                    <div style={{
                                        backgroundColor: m.role === 'user' ? '#3b82f6' : '#2d2d3d',
                                        padding: '10px 14px',
                                        borderRadius: '12px',
                                        fontSize: '14px',
                                        lineHeight: '1.4'
                                    }} dangerouslySetInnerHTML={parseMarkdown(m.content)} />
                                    {m.role === 'assistant' && m.outcomeId && (
                                        <div style={{ display: 'flex', gap: '6px', marginTop: '6px', paddingLeft: '4px' }}>
                                            {m.feedback ? (
                                                <span style={{ fontSize: '10px', color: '#888' }}>learned: {m.feedback.replace('_', ' ')}</span>
                                            ) : (
                                                <>
                                                    <button onClick={() => sendFeedback(idx, m.outcomeId as number, 'helpful')} style={feedbackButtonStyle('#22c55e')}>useful</button>
                                                    <button onClick={() => sendFeedback(idx, m.outcomeId as number, 'not_helpful')} style={feedbackButtonStyle('#ef4444')}>off</button>
                                                    <button onClick={() => sendFeedback(idx, m.outcomeId as number, 'dismissed')} style={feedbackButtonStyle('#a1a1aa')}>later</button>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                        {isLoading && (
                            <div style={{ alignSelf: 'flex-start', backgroundColor: '#2d2d3d', padding: '10px 14px', borderRadius: '12px', fontSize: '14px', fontStyle: 'italic', color: '#888' }}>
                                Jarvis is thinking...
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input Area */}
                    <div style={{ padding: '12px', borderTop: '1px solid rgba(255,255,255,0.1)', backgroundColor: '#232333', display: 'flex', gap: '8px' }}>
                        <input
                            type="text"
                            value={inputTitle}
                            onChange={e => setInputTitle(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder="Message Jarvis..."
                            style={{
                                flex: 1,
                                backgroundColor: '#1a1a24',
                                border: '1px solid rgba(255,255,255,0.2)',
                                borderRadius: '8px',
                                padding: '10px',
                                color: 'white',
                                fontSize: '14px',
                                outline: 'none'
                            }}
                        />
                        <button
                            onClick={handleSend}
                            disabled={isLoading || !inputTitle.trim()}
                            style={{
                                backgroundColor: '#3b82f6',
                                border: 'none',
                                borderRadius: '8px',
                                padding: '0 16px',
                                color: 'white',
                                cursor: (isLoading || !inputTitle.trim()) ? 'not-allowed' : 'pointer',
                                opacity: (isLoading || !inputTitle.trim()) ? 0.5 : 1
                            }}
                        >
                            Send
                        </button>
                    </div>
                </div>
            )}

            {/* Floating Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                style={{
                    width: '60px',
                    height: '60px',
                    borderRadius: '50%',
                    backgroundColor: '#3b82f6',
                    border: 'none',
                    color: 'white',
                    fontSize: '28px',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    cursor: 'pointer',
                    boxShadow: '0 4px 15px rgba(59, 130, 246, 0.4)',
                    transition: 'transform 0.2s',
                    transform: isOpen ? 'scale(0.9)' : 'scale(1)'
                }}
            >
                {isOpen ? '✕' : '🤖'}
            </button>
        </div>
    );
}
