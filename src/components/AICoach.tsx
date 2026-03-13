import React, { useState, useRef, useEffect } from 'react';

export default function AICoach() {
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState<{ role: 'user' | 'assistant', content: string }[]>([]);
    const [inputTitle, setInputTitle] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages, isOpen]);

    const parseMarkdown = (text: string) => {
        let html = text
            // Escape HTML to prevent basic XSS
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;")
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.3);padding:2px 4px;border-radius:3px;font-family:monospace;">$1</code>')
            .replace(/\n/g, '<br/>');
        return { __html: html };
    };

    const handleSend = async () => {
        if (!inputTitle.trim()) return;

        const userMsg = inputTitle.trim();
        setInputTitle('');
        setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
        setIsLoading(true);

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: [...messages, { role: 'user', content: userMsg }]
                })
            });

            const data = await res.json();
            if (data.text) {
                setMessages(prev => [...prev, { role: 'assistant', content: data.text }]);
            } else {
                setMessages(prev => [...prev, { role: 'assistant', content: "Sorry, I had trouble processing that." }]);
            }
        } catch (e) {
            setMessages(prev => [...prev, { role: 'assistant', content: "Error communicating with Jarvis." }]);
        } finally {
            setIsLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

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
                        <h3 style={{ margin: 0, fontSize: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                            🤖 Jarvis Coach
                        </h3>
                        <button onClick={() => setIsOpen(false)} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '18px' }}>
                            ✕
                        </button>
                    </div>

                    {/* Messages Area */}
                    <div style={{ flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {messages.length === 0 ? (
                            <div style={{ color: '#888', textAlign: 'center', marginTop: '40px', fontSize: '14px' }}>
                                How can I help you focus today?
                            </div>
                        ) : (
                            messages.map((m, idx) => (
                                <div key={idx} style={{
                                    alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                                    backgroundColor: m.role === 'user' ? '#3b82f6' : '#2d2d3d',
                                    padding: '10px 14px',
                                    borderRadius: '12px',
                                    maxWidth: '85%',
                                    fontSize: '14px',
                                    lineHeight: '1.4'
                                }} dangerouslySetInnerHTML={parseMarkdown(m.content)} />
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
