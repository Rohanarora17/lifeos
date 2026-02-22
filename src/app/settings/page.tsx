'use client';

import { useEffect, useState } from 'react';

export default function SettingsPage() {
    const [settings, setSettings] = useState<Record<string, string>>({});
    const [editValues, setEditValues] = useState<Record<string, string>>({});
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        fetch('/api/settings')
            .then(r => r.json())
            .then(data => {
                setSettings(data.settings || {});
                setEditValues(data.settings || {});
            });
    }, []);

    const saveSettings = async () => {
        await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: editValues }),
        });
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
    };

    const groups = [
        {
            title: '🔑 API Keys',
            description: 'Connect your accounts',
            fields: [
                { key: 'gemini_api_key', label: 'Gemini API Key', type: 'password', placeholder: 'AIzaSy...' },
                { key: 'github_pat', label: 'GitHub Personal Access Token', type: 'password', placeholder: 'ghp_...' },
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

                {/* Domain Lists */}
                <div className="card">
                    <h3 className="font-semibold mb-1">🌐 Domain Classification</h3>
                    <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>Override AI classification for specific domains</p>
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
            </div>
        </div>
    );
}
