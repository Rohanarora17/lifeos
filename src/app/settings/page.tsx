'use client';

import { useEffect, useState } from 'react';

interface AdaptiveSettingsPolicy {
    mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
    guidance: string;
    energy: 'high' | 'medium' | 'low';
    mood: 'high' | 'medium' | 'low' | null;
    alertFatigueLevel: 'low' | 'medium' | 'high';
    focusTrend: 'improving' | 'declining' | 'stable';
    nextBestFocusWindow: string;
    nudgeThresholdMinutes: number;
    nudgeReason: string;
    sessionMinutes: number;
    dailyCapacityMinutes: number;
    focusBands: {
        excellent: number;
        good: number;
        neutral: number;
    };
    rewardMultiplier: number;
    rewardGuidance: string;
    scheduleGuidance: string;
    overrideNote: string;
    recommendedOverrides: Array<{
        key: string;
        value: string;
        label: string;
        reason: string;
        currentValue: string | null;
    }>;
}

interface SettingField {
    key: string;
    label: string;
    type: string;
    placeholder: string;
    adaptiveHint?: string;
}

interface SettingGroup {
    title: string;
    description: string;
    fields: SettingField[];
}

interface SelfModelBelief {
    id: string;
    kind: string;
    label: string;
    value: string;
    confidence: number;
    evidence: string[];
}

interface SelfModelGap {
    id: string;
    label: string;
    reason: string;
    suggestedQuestion: string;
    priority: 'low' | 'medium' | 'high';
}

interface SelfModel {
    confidence: number;
    summary: string;
    beliefs: SelfModelBelief[];
    gaps: SelfModelGap[];
    coverage: {
        activeMemoryFacts: number;
        feedbackEvents30d: number;
        checkins14d: number;
        focusSessions30d: number;
    };
}



export default function SettingsPage() {
    const [editValues, setEditValues] = useState<Record<string, string>>({});
    const [adaptivePolicy, setAdaptivePolicy] = useState<AdaptiveSettingsPolicy | null>(null);
    const [selfModel, setSelfModel] = useState<SelfModel | null>(null);
    const [saved, setSaved] = useState(false);
    const [syncing, setSyncing] = useState<string | null>(null);
    const [syncResult, setSyncResult] = useState<string | null>(null);

    useEffect(() => {
        Promise.all([
            fetch('/api/settings').then(r => r.json()),
            fetch('/api/personalization/model').then(r => r.json()).catch(() => null),
        ]).then(([settingsData, modelData]) => {
            setEditValues(settingsData.settings || {});
            setAdaptivePolicy(settingsData.adaptivePolicy ?? null);
            setSelfModel(modelData?.selfModel ?? null);
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

	            setAdaptivePolicy(verifyData.adaptivePolicy ?? null);
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

    const applyRecommendation = (key: string, value: string) => {
        setEditValues(prev => ({ ...prev, [key]: value }));
        setSyncResult(`Applied recommendation for ${key}. Save changes to persist.`);
        setTimeout(() => setSyncResult(null), 3500);
    };

    const groups: SettingGroup[] = [
        {
            title: '🔑 API Keys & Accounts',
            description: 'Connect your services (Vertex AI is the required Gemini runtime path)',
            fields: [
                { key: 'gemini_api_key', label: 'Gemini API Key (Deprecated, not used by runtime)', type: 'password', placeholder: 'AIzaSy...' },
                { key: 'gcp_project_id', label: 'Vertex Project ID (legacy fallback for GOOGLE_CLOUD_PROJECT)', type: 'text', placeholder: 'my-gcp-project-123' },
                { key: 'gcp_location', label: 'Vertex Location (legacy fallback for GOOGLE_CLOUD_LOCATION)', type: 'text', placeholder: 'us-central1' },
                { key: 'github_pat', label: 'GitHub Personal Access Token', type: 'password', placeholder: 'ghp_...' },
                { key: 'github_username', label: 'GitHub Username', type: 'text', placeholder: 'your-username' },
                { key: 'calendar_ics_url', label: 'Google Calendar ICS URL', type: 'text', placeholder: 'https://calendar.google.com/calendar/ical/...' },
            ]
        },
	        {
	            title: '⏱️ Nudge Settings',
	            description: adaptivePolicy
	                ? `Manual guardrail. Runtime threshold now: ${adaptivePolicy.nudgeThresholdMinutes} min (${adaptivePolicy.nudgeReason}).`
	                : 'Control the base nudge guardrail; runtime policy can adapt it.',
	            fields: [
	                {
	                    key: 'nudge_threshold_minutes',
	                    label: 'Base distraction threshold override (minutes)',
	                    type: 'number',
	                    placeholder: '15',
	                    adaptiveHint: adaptivePolicy ? `Active now: ${adaptivePolicy.nudgeThresholdMinutes} min · ${adaptivePolicy.nudgeReason}` : undefined,
	                },
	            ]
	        },
	        {
	            title: '📊 Scoring',
	            description: adaptivePolicy
	                ? `Base point values. Rewards currently use ${adaptivePolicy.rewardMultiplier.toFixed(2)}x because ${adaptivePolicy.rewardGuidance}.`
	                : 'Base gamification point values; reward policy can adapt around these.',
	            fields: [
	                { key: 'xp_per_task', label: 'Base XP per task completed', type: 'number', placeholder: '50', adaptiveHint: adaptivePolicy?.rewardGuidance },
	                { key: 'xp_per_habit', label: 'Base XP per habit check-in', type: 'number', placeholder: '20', adaptiveHint: adaptivePolicy?.rewardGuidance },
	                { key: 'xp_per_productive_hour', label: 'Base XP per productive hour', type: 'number', placeholder: '30', adaptiveHint: adaptivePolicy ? `Daily capacity currently ${adaptivePolicy.dailyCapacityMinutes} min.` : undefined },
	                { key: 'xp_per_commit', label: 'Base XP per GitHub commit', type: 'number', placeholder: '10' },
		                { key: 'level_xp_base', label: 'Base XP per level', type: 'number', placeholder: '500', adaptiveHint: adaptivePolicy ? `Focus bands now: good ${adaptivePolicy.focusBands.good}+, excellent ${adaptivePolicy.focusBands.excellent}+.` : undefined },
	            ]
	        },
	        {
	            title: '⏰ Schedule',
	            description: adaptivePolicy?.scheduleGuidance ?? 'When to generate reports; scheduler may adapt delivery based on context.',
		            fields: [
		                { key: 'daily_summary_time', label: 'Daily summary time override', type: 'text', placeholder: '23:00', adaptiveHint: adaptivePolicy?.scheduleGuidance },
		                { key: 'morning_brief_time', label: 'Morning brief time override', type: 'text', placeholder: '08:00', adaptiveHint: adaptivePolicy ? `Next best focus window: ${adaptivePolicy.nextBestFocusWindow}. Session default now ${adaptivePolicy.sessionMinutes} min.` : undefined },
		                { key: 'evening_reflection_time', label: 'Evening reflection override', type: 'text', placeholder: '21:30', adaptiveHint: adaptivePolicy?.scheduleGuidance },
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

		            {adaptivePolicy && (
		                <div
	                    className="card mb-6"
	                    style={{
	                        border: '1px solid rgba(99,102,241,0.22)',
	                        background: 'rgba(99,102,241,0.045)',
	                    }}
	                >
	                    <div className="flex items-start justify-between gap-4">
	                        <div>
	                            <h3 className="font-semibold mb-1">Adaptive Runtime Policy</h3>
	                            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
	                                {adaptivePolicy.mode.replace(/_/g, ' ')} · {adaptivePolicy.energy} energy · {adaptivePolicy.guidance}
	                            </p>
	                        </div>
	                        <div className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>
	                            Focus {adaptivePolicy.focusTrend}
	                            <br />
	                            Alert fatigue {adaptivePolicy.alertFatigueLevel}
	                        </div>
	                    </div>
	                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4 text-xs">
	                        <div style={{ color: 'var(--text-secondary)' }}>
	                            <b style={{ color: 'var(--text-primary)' }}>Nudge now:</b> {adaptivePolicy.nudgeThresholdMinutes} min
	                            <br />
	                            {adaptivePolicy.nudgeReason}
	                        </div>
	                        <div style={{ color: 'var(--text-secondary)' }}>
	                            <b style={{ color: 'var(--text-primary)' }}>Focus session:</b> {adaptivePolicy.sessionMinutes} min default
	                            <br />
	                            Capacity {adaptivePolicy.dailyCapacityMinutes} min · next window {adaptivePolicy.nextBestFocusWindow}
	                        </div>
	                        <div style={{ color: 'var(--text-secondary)' }}>
	                            <b style={{ color: 'var(--text-primary)' }}>Rewards:</b> {adaptivePolicy.rewardMultiplier.toFixed(2)}x
	                            <br />
	                            {adaptivePolicy.rewardGuidance}
	                        </div>
	                        <div style={{ color: 'var(--text-secondary)' }}>
	                            <b style={{ color: 'var(--text-primary)' }}>Focus bands:</b> neutral {adaptivePolicy.focusBands.neutral}+ · good {adaptivePolicy.focusBands.good}+ · excellent {adaptivePolicy.focusBands.excellent}+
	                        </div>
	                    </div>
		                    <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
		                        {adaptivePolicy.overrideNote}
		                    </p>
                            {adaptivePolicy.recommendedOverrides.length > 0 && (
                                <div className="mt-4 space-y-2">
                                    {adaptivePolicy.recommendedOverrides.slice(0, 3).map(rec => (
                                        <div
                                            key={rec.key}
                                            className="flex items-center justify-between gap-3 rounded-lg px-3 py-2"
                                            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}
                                        >
                                            <div>
                                                <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{rec.label}</p>
                                                <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                                    {rec.key}: {rec.currentValue ?? 'unset'} → {rec.value} · {rec.reason}
                                                </p>
                                            </div>
                                            <button
                                                className="btn btn-ghost btn-sm"
                                                onClick={() => applyRecommendation(rec.key, rec.value)}
                                            >
                                                Apply
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
			                </div>
			            )}

                    {selfModel && (
                        <div
                            className="card mb-6"
                            style={{
                                border: '1px solid rgba(34,197,94,0.18)',
                                background: 'rgba(34,197,94,0.035)',
                            }}
                        >
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <h3 className="font-semibold mb-1">What LifeOS Thinks It Knows</h3>
                                    <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                                        {selfModel.summary}
                                    </p>
                                </div>
                                <div className="text-right text-xs" style={{ color: 'var(--text-muted)' }}>
                                    Model confidence
                                    <br />
                                    <b style={{ color: 'var(--text-primary)', fontSize: 18 }}>{Math.round(selfModel.confidence * 100)}%</b>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 text-xs">
                                <ModelSignal label="Memory facts" value={selfModel.coverage.activeMemoryFacts} />
                                <ModelSignal label="Feedback" value={selfModel.coverage.feedbackEvents30d} />
                                <ModelSignal label="Check-ins" value={selfModel.coverage.checkins14d} />
                                <ModelSignal label="Sessions" value={selfModel.coverage.focusSessions30d} />
                            </div>

                            <div className="mt-4 space-y-2">
                                {selfModel.beliefs.slice(0, 4).map(belief => (
                                    <div key={belief.id} style={{ padding: '10px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="text-sm font-medium">{belief.label}</span>
                                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{Math.round(belief.confidence * 100)}%</span>
                                        </div>
                                        <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>{belief.value}</p>
                                        {belief.evidence[0] && (
                                            <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{belief.evidence[0]}</p>
                                        )}
                                    </div>
                                ))}
                            </div>

                            {selfModel.gaps[0] && (
                                <div className="mt-4 rounded-lg p-3" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.14)' }}>
                                    <p className="text-xs font-semibold mb-1" style={{ color: 'var(--accent-orange)' }}>
                                        Highest-value question
                                    </p>
                                    <p className="text-sm" style={{ color: 'var(--text-primary)' }}>{selfModel.gaps[0].suggestedQuestion}</p>
                                    <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{selfModel.gaps[0].reason}</p>
                                </div>
                            )}
                        </div>
                    )}

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
	                                    {field.adaptiveHint && (
	                                        <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
	                                            {field.adaptiveHint}
	                                        </p>
	                                    )}
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

function ModelSignal({ label, value }: { label: string; value: number }) {
    return (
        <div style={{
            padding: '10px',
            borderRadius: 8,
            background: 'rgba(255,255,255,0.035)',
            border: '1px solid rgba(255,255,255,0.06)',
        }}>
            <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</p>
            <p className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{value}</p>
        </div>
    );
}
