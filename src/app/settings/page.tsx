'use client';

import { useEffect, useState } from 'react';



export default function SettingsPage() {
    const [settings, setSettings] = useState<Record<string, string>>({});
    const [editValues, setEditValues] = useState<Record<string, string>>({});
    const [saved, setSaved] = useState(false);
    const [syncing, setSyncing] = useState<string | null>(null);
    const [syncResult, setSyncResult] = useState<string | null>(null);

    useEffect(() => {
        fetch('/api/settings')
            .then(r => r.json())
            .then(data => {
                setSettings(data.settings || {});
                setEditValues(data.settings || {});
            });
    }, []);

    const saveSettings = async () => {
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings: editValues }),
            });

            // Read back to verify save worked
            const verifyRes = await fetch('/api/settings');
            const verifyData = await verifyRes.json();
            const verified = verifyData.settings || {};

            // Count verified keys (non-sensitive values should match exactly)
            let verifiedCount = 0;
            let totalCount = 0;
            for (const key of Object.keys(editValues)) {
                totalCount++;
                if (key.includes('api_key') || key.includes('pat') || key.includes('token')) {
                    // Sensitive keys are masked, just check they're not empty
                    if (editValues[key] && verified[key] && verified[key].startsWith('••••')) {
                        verifiedCount++;
                    } else if (!editValues[key]) {
                        verifiedCount++; // empty is fine
                    }
                } else if (verified[key] === editValues[key]) {
                    verifiedCount++;
                }
            }

            setSettings(verified);
            setSaved(true);
            setSyncResult(`✅ ${verifiedCount}/${totalCount} settings saved and verified`);
            setTimeout(() => { setSaved(false); setSyncResult(null); }, 3000);
        } catch {
            setSyncResult('❌ Failed to save settings');
            setTimeout(() => setSyncResult(null), 3000);
        }
    };

    const triggerSync = async (type: string, endpoint: string) => {
        setSyncing(type);
        setSyncResult(null);
        try {
            const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = await res.json();
            if (data.errors?.length) {
                setSyncResult(`⚠️ ${data.errors[0]}`);
            } else if (data.synced !== undefined) {
                setSyncResult(`✅ Synced ${data.synced} items`);
            } else if (data.collected !== undefined) {
                setSyncResult(`✅ Collected ${data.collected} apps`);
            } else {
                setSyncResult('✅ Done');
            }
        } catch (err) {
            setSyncResult(`❌ ${String(err)}`);
        }
        setSyncing(null);
        setTimeout(() => setSyncResult(null), 5000);
    };

    const groups = [
        {
            title: '🔑 API Keys & Accounts',
            description: 'Connect your services',
            fields: [
                { key: 'gemini_api_key', label: 'Gemini API Key (Free Tier)', type: 'password', placeholder: 'AIzaSy...' },
                { key: 'gcp_project_id', label: 'GCP Project ID (Vertex AI)', type: 'text', placeholder: 'my-gcp-project-123' },
                { key: 'gcp_location', label: 'GCP Location', type: 'text', placeholder: 'us-central1' },
                { key: 'github_pat', label: 'GitHub Personal Access Token', type: 'password', placeholder: 'ghp_...' },
                { key: 'github_username', label: 'GitHub Username', type: 'text', placeholder: 'your-username' },
                { key: 'calendar_ics_url', label: 'Google Calendar ICS URL', type: 'text', placeholder: 'https://calendar.google.com/calendar/ical/...' },
            ]
        },
        {
            title: '⏱️ Nudge Settings',
            description: 'Control when AI nudges you',
            fields: [
                { key: 'nudge_threshold_minutes', label: 'Distraction threshold (minutes)', type: 'number', placeholder: '15' },
            ]
        },
        {
            title: '📊 Scoring',
            description: 'Gamification point values',
            fields: [
                { key: 'xp_per_task', label: 'XP per task completed', type: 'number', placeholder: '50' },
                { key: 'xp_per_habit', label: 'XP per habit check-in', type: 'number', placeholder: '20' },
                { key: 'xp_per_productive_hour', label: 'XP per productive hour', type: 'number', placeholder: '30' },
                { key: 'xp_per_commit', label: 'XP per GitHub commit', type: 'number', placeholder: '10' },
                { key: 'level_xp_base', label: 'Base XP per level', type: 'number', placeholder: '500' },
            ]
        },
        {
            title: '⏰ Schedule',
            description: 'When to generate reports',
            fields: [
                { key: 'daily_summary_time', label: 'Daily summary time', type: 'text', placeholder: '23:00' },
                { key: 'morning_brief_time', label: 'Morning brief time', type: 'text', placeholder: '08:00' },
            ]
        },
        {
            title: '✉️ Email Notifications',
            description: 'Receive alerts via email (powered by Resend)',
            fields: [
                { key: 'resend_api_key', label: 'Resend API Key', type: 'password', placeholder: 're_...' },
                { key: 'notification_email', label: 'Notification Email', type: 'text', placeholder: 'you@email.com' },
                { key: 'email_alerts_enabled', label: 'Email Alerts Enabled (true/false)', type: 'text', placeholder: 'true' },
            ]
        },
    ];

    return (
        <div className="max-w-[700px] mx-auto animate-fade-in">
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Settings ⚙️</h1>
                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Configure your LifeOS instance</p>
                </div>
                <button className="btn btn-primary" onClick={saveSettings}>
                    {saved ? '✓ Saved!' : 'Save Changes'}
                </button>
            </div>

            <div className="space-y-6">
                {groups.map(group => (
                    <div key={group.title} className="card">
                        <h3 className="font-semibold mb-1">{group.title}</h3>
                        <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>{group.description}</p>
                        <div className="space-y-4">
                            {group.fields.map(field => (
                                <div key={field.key}>
                                    <label className="text-sm font-medium block mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                                        {field.label}
                                    </label>
                                    <input
                                        className="input"
                                        type={field.type}
                                        placeholder={field.placeholder}
                                        value={editValues[field.key] || ''}
                                        onChange={e => setEditValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                                    />
                                </div>
                            ))}
                        </div>
                    </div>
                ))}

                {/* Sync Actions */}
                <div className="card">
                    <h3 className="font-semibold mb-1">🔄 Data Sync</h3>
                    <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Manually trigger data syncs</p>
                    <div className="flex flex-wrap gap-3">
                        <button
                            className="btn"
                            onClick={() => triggerSync('github', '/api/github')}
                            disabled={syncing === 'github'}
                            style={{ background: 'rgba(110,84,148,0.2)', border: '1px solid rgba(110,84,148,0.3)', color: '#b48eff', cursor: 'pointer' }}
                        >
                            {syncing === 'github' ? '⏳ Syncing...' : '🐙 Sync GitHub'}
                        </button>
                        <button
                            className="btn"
                            onClick={() => triggerSync('calendar', '/api/calendar')}
                            disabled={syncing === 'calendar'}
                            style={{ background: 'rgba(66,133,244,0.15)', border: '1px solid rgba(66,133,244,0.3)', color: '#6fb3ff', cursor: 'pointer' }}
                        >
                            {syncing === 'calendar' ? '⏳ Syncing...' : '📅 Sync Calendar'}
                        </button>
                        <button
                            className="btn"
                            onClick={() => triggerSync('screentime', '/api/screentime')}
                            disabled={syncing === 'screentime'}
                            style={{ background: 'rgba(52,199,89,0.15)', border: '1px solid rgba(52,199,89,0.3)', color: '#34c759', cursor: 'pointer' }}
                        >
                            {syncing === 'screentime' ? '⏳ Collecting...' : '🖥️ Collect Screen Time'}
                        </button>
                    </div>
                    {syncResult && (
                        <p className="text-xs mt-3" style={{ color: syncResult.startsWith('✅') ? '#34c759' : syncResult.startsWith('⚠️') ? '#ff9f0a' : '#ff453a' }}>
                            {syncResult}
                        </p>
                    )}
                </div>

                {/* Domain Lists */}
                <div className="card">
                    <h3 className="font-semibold mb-1">🌐 Domain Hints (Optional)</h3>
                    <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Optional hints for the AI classifier. The AI classifies ALL domains dynamically — use these only to force overrides.</p>
                    <div className="space-y-4">
                        <div>
                            <label className="text-sm font-medium block mb-1.5" style={{ color: 'var(--accent-red)' }}>
                                Always Distraction (comma-separated)
                            </label>
                            <textarea
                                className="input"
                                style={{ minHeight: '60px', resize: 'vertical' }}
                                value={editValues.distraction_domains || ''}
                                onChange={e => setEditValues(prev => ({ ...prev, distraction_domains: e.target.value }))}
                                placeholder='["twitter.com", "instagram.com"]'
                            />
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1.5" style={{ color: 'var(--accent-green)' }}>
                                Always Productive (comma-separated)
                            </label>
                            <textarea
                                className="input"
                                style={{ minHeight: '60px', resize: 'vertical' }}
                                value={editValues.productive_domains || ''}
                                onChange={e => setEditValues(prev => ({ ...prev, productive_domains: e.target.value }))}
                                placeholder='["github.com", "stackoverflow.com"]'
                            />
                        </div>
                    </div>
                </div>

                {/* Auto-Start */}
                <div className="card">
                    <h3 className="font-semibold mb-1">🚀 Auto-Start</h3>
                    <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                        Start LifeOS automatically on login
                    </p>
                    <div style={{ padding: 12, background: '#0a0a12', borderRadius: 8, border: '1px solid #1a1a2e' }}>
                        <p className="text-xs" style={{ color: '#8888a0' }}>
                            Run the following command to install auto-start:
                        </p>
                        <code className="text-xs block mt-2" style={{
                            padding: '8px 12px', background: '#12121a', borderRadius: 6,
                            color: '#e0e0f0', wordBreak: 'break-all', fontFamily: 'monospace',
                        }}>
                            bash scripts/install-launchagent.sh
                        </code>
                    </div>
                </div>
            </div>
        </div>
    );
}
