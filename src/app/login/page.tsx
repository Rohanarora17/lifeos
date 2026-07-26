'use client';

import { FormEvent, useState } from 'react';

export default function LoginPage() {
    const [token, setToken] = useState('');
    const [status, setStatus] = useState<'idle' | 'submitting' | 'error'>('idle');
    const [message, setMessage] = useState('');

    async function submit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setStatus('submitting');
        setMessage('');

        try {
            const response = await fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            });
            const payload = await response.json();
            if (!response.ok || !payload.authenticated) {
                setStatus('error');
                setMessage(
                    payload.error === 'security_not_configured'
                        ? 'LifeOS authentication is not configured on this server.'
                        : 'Access token rejected.',
                );
                return;
            }

            const requestedPath = new URLSearchParams(window.location.search).get('returnTo') || '/';
            window.location.assign(requestedPath.startsWith('/') ? requestedPath : '/');
        } catch {
            setStatus('error');
            setMessage('LifeOS could not reach the server.');
        }
    }

    return (
        <main style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: 24,
            background: '#0b0d10',
            color: '#f4f4f5',
        }}>
            <form
                onSubmit={submit}
                style={{
                    width: 'min(100%, 360px)',
                    display: 'grid',
                    gap: 16,
                    padding: 24,
                    border: '1px solid #2a2e35',
                    borderRadius: 8,
                    background: '#14171b',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <h1 style={{ margin: 0, fontSize: 20, letterSpacing: 0 }}>LifeOS access</h1>
                </div>
                <label style={{ display: 'grid', gap: 8, fontSize: 13, color: '#c5c7cc' }}>
                    Access token
                    <input
                        type="password"
                        autoComplete="current-password"
                        value={token}
                        onChange={event => setToken(event.target.value)}
                        required
                        autoFocus
                        style={{
                            minHeight: 42,
                            padding: '0 12px',
                            border: '1px solid #3b4048',
                            borderRadius: 6,
                            background: '#0e1115',
                            color: '#f4f4f5',
                            fontSize: 15,
                        }}
                    />
                </label>
                {message && (
                    <p role="alert" style={{ margin: 0, color: '#fda4af', fontSize: 13 }}>
                        {message}
                    </p>
                )}
                <button
                    type="submit"
                    disabled={status === 'submitting'}
                    style={{
                        minHeight: 42,
                        border: 0,
                        borderRadius: 6,
                        background: '#f4f4f5',
                        color: '#111318',
                        fontWeight: 650,
                        cursor: status === 'submitting' ? 'wait' : 'pointer',
                    }}
                >
                    {status === 'submitting' ? 'Checking...' : 'Unlock'}
                </button>
            </form>
        </main>
    );
}
