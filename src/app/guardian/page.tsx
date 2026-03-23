'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import GuardianDashboard from '@/components/GuardianDashboard';

interface DayBriefing {
  recentSessions: number;
  avgFocusScore: number;
  activeGoals: string[];
  activeTasks: string[];
  upcomingFocusTarget: string | null;
  bestStartHour: number | null;
  recurringDistractions: string[];
  coachingStyle: 'gentle' | 'balanced' | 'direct';
  energyForecast: 'low' | 'medium' | 'high';
  openingMessage: string;
  recentReflections: Array<{
    id: number;
    sessionId: string;
    reflectionText: string;
    focusQuality: 'excellent' | 'good' | 'neutral' | 'poor';
    generatedAt: string;
  }>;
  upcomingCommitments: Array<{
    id: string;
    targetTitle: string;
    intendedStartAt: number;
    plannedMinutes: number;
    status: string;
  }>;
}

interface ActiveSession {
  sessionId: string;
  targetTitle: string;
  durationMinutes: number;
  state: string;
}

const QUALITY_COLOR: Record<string, string> = {
  excellent: '#22c55e',
  good: '#3b82f6',
  neutral: '#8888a0',
  poor: '#ef4444',
};

export default function GuardianPage() {
  const [briefing, setBriefing] = useState<DayBriefing | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [topic, setTopic] = useState('');
  const [duration, setDuration] = useState(60);
  const [mood, setMood] = useState<'high' | 'medium' | 'low' | ''>('');
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduleTime, setScheduleTime] = useState('');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<string | null>(null);
  const topicRef = useRef<HTMLInputElement>(null);

  const fetchBriefing = useCallback(async () => {
    try {
      const res = await fetch('/api/guardian/day-briefing');
      if (res.ok) {
        const data = await res.json();
        setBriefing(data.briefing ?? data);
      }
    } catch {}
  }, []);

  const fetchActiveSession = useCallback(async () => {
    try {
      const res = await fetch('/api/extension/session');
      if (!res.ok) return;
      const data = await res.json();
      if (data.activeSession?.state === 'ACTIVE') {
        setActiveSession(data.activeSession);
      } else {
        setActiveSession(null);
      }
    } catch {}
  }, []);

  useEffect(() => {
    Promise.all([fetchBriefing(), fetchActiveSession()]).finally(() => setLoading(false));
    const interval = setInterval(fetchBriefing, 60_000);
    return () => clearInterval(interval);
  }, [fetchBriefing, fetchActiveSession]);

  // Pre-fill topic from briefing
  useEffect(() => {
    if (briefing?.upcomingFocusTarget && !topic) {
      setTopic(briefing.upcomingFocusTarget);
    }
  }, [briefing, topic]);

  const startSession = async () => {
    if (!topic.trim()) { topicRef.current?.focus(); return; }
    setStarting(true);
    try {
      const res = await fetch('/api/guardian/session/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: topic.trim(),
          durationMinutes: duration,
          mood: mood || null,
          source: 'dashboard',
        }),
      });
      const data = await res.json();
      if (data.session) {
        setActiveSession(data.session);
        setTopic('');
      }
    } catch {}
    setStarting(false);
  };

  const endSession = async () => {
    if (!activeSession) return;
    try {
      await fetch('/api/guardian/session/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSession.sessionId }),
      });
    } catch {}
    setActiveSession(null);
    await fetchBriefing();
  };

  const dismissCommitment = async (id: string) => {
    try {
      await fetch(`/api/guardian/soft-watch?id=${id}`, { method: 'DELETE' });
      await fetchBriefing();
    } catch {}
  };

  const scheduleCommitment = async () => {
    if (!topic.trim() || !scheduleTime) return;
    const [hh, mm] = scheduleTime.split(':').map(Number);
    const d = new Date();
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    try {
      await fetch('/api/guardian/soft-watch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetTitle: topic.trim(),
          intendedStartAt: d.getTime(),
          plannedMinutes: duration,
          source: 'dashboard',
        }),
      });
      setScheduleMode(false);
      setScheduleTime('');
      await fetchBriefing();
    } catch {}
  };

  const runOptimizer = async () => {
    setOptimizing(true);
    setOptimizeResult(null);
    try {
      const res = await fetch('/api/guardian/optimize', { method: 'POST' });
      const data = await res.json();
      if (data.result?.promoted) {
        setOptimizeResult(`Promoted: ${data.result.promoted.version} (canary: ${data.result.canary?.status ?? 'n/a'})`);
      } else {
        setOptimizeResult(`No improvement found. Baseline retained. Canary: ${data.result?.canary?.status ?? 'n/a'}`);
      }
    } catch (e) {
      setOptimizeResult(`Error: ${String(e)}`);
    }
    setOptimizing(false);
  };

  const formatHour = (h: number | null) => {
    if (h === null) return '—';
    const period = h >= 12 ? 'PM' : 'AM';
    const display = h % 12 === 0 ? 12 : h % 12;
    return `${display}${period}`;
  };

  const formatCommitmentTime = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: '#8888a0' }}>
        Loading guardian...
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '24px 16px', fontFamily: "'Inter', sans-serif" }}>

      {/* Header */}
      <div style={{ marginBottom: '28px' }}>
        <div style={{ fontSize: '11px', color: '#6366f1', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: '4px' }}>
          Guardian
        </div>
        <h1 style={{ fontSize: '28px', fontWeight: 900, color: '#f0f0f5', margin: 0, letterSpacing: '-0.5px' }}>
          {briefing?.openingMessage ?? 'Ready when you are.'}
        </h1>
      </div>

      {/* Live Session — shown when active */}
      {activeSession ? (
        <div style={{ marginBottom: '28px' }}>
          <GuardianDashboard
            sessionId={activeSession.sessionId}
            plannedMinutes={activeSession.durationMinutes}
            targetTitle={activeSession.targetTitle}
          />
          <button
            onClick={endSession}
            style={{
              marginTop: '12px', width: '100%', padding: '10px',
              background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '10px', color: '#ef4444', fontWeight: 600, fontSize: '14px', cursor: 'pointer',
            }}
          >
            End Session
          </button>
        </div>
      ) : (
        /* Session Start Form */
        <div style={{
          background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px',
          padding: '20px', marginBottom: '28px',
        }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Start a Session
          </div>
          <input
            ref={topicRef}
            type="text"
            placeholder="What are you working on?"
            value={topic}
            onChange={e => setTopic(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !scheduleMode && void startSession()}
            style={{
              width: '100%', padding: '10px 12px', background: '#0a0a12', border: '1px solid #2a2a40',
              borderRadius: '8px', color: '#f0f0f5', fontSize: '14px', marginBottom: '10px', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <select
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              style={{
                flex: 1, padding: '9px', background: '#0a0a12', border: '1px solid #2a2a40',
                borderRadius: '8px', color: '#f0f0f5', fontSize: '13px', cursor: 'pointer',
              }}
            >
              {[25, 45, 60, 90, 120].map(m => (
                <option key={m} value={m}>{m < 60 ? `${m}m` : `${m / 60}h`}</option>
              ))}
            </select>
            <select
              value={mood}
              onChange={e => setMood(e.target.value as typeof mood)}
              style={{
                flex: 1, padding: '9px', background: '#0a0a12', border: '1px solid #2a2a40',
                borderRadius: '8px', color: mood ? '#f0f0f5' : '#555570', fontSize: '13px', cursor: 'pointer',
              }}
            >
              <option value="">Mood (optional)</option>
              <option value="high">High energy</option>
              <option value="medium">Medium</option>
              <option value="low">Low / tired</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            {!scheduleMode ? (
              <>
                <button
                  onClick={startSession}
                  disabled={starting || !topic.trim()}
                  style={{
                    flex: 3, padding: '10px', borderRadius: '9px', border: 'none',
                    background: topic.trim() ? 'linear-gradient(135deg, #6366f1, #8b5cf6)' : '#2a2a40',
                    color: topic.trim() ? '#fff' : '#555570', fontWeight: 700, fontSize: '14px',
                    cursor: topic.trim() ? 'pointer' : 'default',
                  }}
                >
                  {starting ? 'Starting...' : 'Lock In'}
                </button>
                <button
                  onClick={() => setScheduleMode(true)}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '9px',
                    border: '1px solid #2a2a40', background: 'transparent',
                    color: '#8888a0', fontSize: '13px', cursor: 'pointer',
                  }}
                >
                  Schedule
                </button>
              </>
            ) : (
              <>
                <input
                  type="time"
                  value={scheduleTime}
                  onChange={e => setScheduleTime(e.target.value)}
                  style={{
                    flex: 2, padding: '9px', background: '#0a0a12', border: '1px solid #6366f1',
                    borderRadius: '8px', color: '#f0f0f5', fontSize: '13px',
                  }}
                />
                <button
                  onClick={scheduleCommitment}
                  disabled={!scheduleTime || !topic.trim()}
                  style={{
                    flex: 2, padding: '10px', borderRadius: '9px', border: 'none',
                    background: scheduleTime && topic.trim() ? '#6366f1' : '#2a2a40',
                    color: scheduleTime && topic.trim() ? '#fff' : '#555570',
                    fontWeight: 700, fontSize: '13px', cursor: 'pointer',
                  }}
                >
                  Confirm
                </button>
                <button
                  onClick={() => setScheduleMode(false)}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '9px',
                    border: '1px solid #2a2a40', background: 'transparent',
                    color: '#8888a0', fontSize: '13px', cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Two-column: stats + upcoming */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '28px' }}>
        {/* Briefing stats */}
        <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px' }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Today
          </div>
          {briefing && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {[
                { label: 'Avg Focus', value: briefing.recentSessions > 0 ? `${Math.round(briefing.avgFocusScore)}` : '—', sub: briefing.recentSessions > 0 ? `${briefing.recentSessions} sessions` : 'no sessions yet' },
                { label: 'Best Start', value: formatHour(briefing.bestStartHour), sub: 'based on history' },
                { label: 'Energy', value: briefing.energyForecast, sub: briefing.coachingStyle + ' coaching' },
              ].map((row, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '12px', color: '#8888a0' }}>{row.label}</span>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#f0f0f5', textTransform: 'capitalize' }}>{row.value}</div>
                    <div style={{ fontSize: '10px', color: '#555570' }}>{row.sub}</div>
                  </div>
                </div>
              ))}
              {briefing.recurringDistractions.length > 0 && (
                <div style={{ marginTop: '4px', padding: '8px', background: 'rgba(239,68,68,0.06)', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.15)' }}>
                  <div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 600, marginBottom: '4px' }}>Recurring distractions</div>
                  <div style={{ fontSize: '11px', color: '#8888a0' }}>{briefing.recurringDistractions.join(', ')}</div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Upcoming commitments */}
        <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px' }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Scheduled
          </div>
          {!briefing?.upcomingCommitments?.length ? (
            <div style={{ fontSize: '12px', color: '#555570', textAlign: 'center', padding: '16px 0' }}>
              No upcoming sessions.<br />Use "Schedule" to plan ahead.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {briefing.upcomingCommitments.map(c => (
                <div key={c.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '8px 10px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
                  borderRadius: '8px',
                }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#f0f0f5' }}>{c.targetTitle}</div>
                    <div style={{ fontSize: '10px', color: '#8888a0' }}>{formatCommitmentTime(c.intendedStartAt)} · {c.plannedMinutes}m</div>
                  </div>
                  <button
                    onClick={() => void dismissCommitment(c.id)}
                    style={{ background: 'none', border: 'none', color: '#555570', cursor: 'pointer', fontSize: '16px', padding: '2px 6px' }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Active goals */}
      {briefing && briefing.activeGoals.length > 0 && (
        <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px', marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '12px' }}>
            Active Goals
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {briefing.activeGoals.map((g, i) => (
              <div
                key={i}
                onClick={() => setTopic(g)}
                style={{
                  padding: '8px 12px', background: '#0a0a12', border: '1px solid #2a2a40',
                  borderRadius: '8px', fontSize: '13px', color: '#c0c0d5', cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
              >
                {g}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Reflections */}
      {briefing && briefing.recentReflections.length > 0 && (
        <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px', marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Recent Reflections
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {briefing.recentReflections.map(r => (
              <div key={r.id} style={{ display: 'flex', gap: '12px' }}>
                <div style={{
                  width: '6px', flexShrink: 0, borderRadius: '3px',
                  background: QUALITY_COLOR[r.focusQuality] ?? '#8888a0',
                }} />
                <div>
                  <div style={{ fontSize: '13px', color: '#c0c0d5', lineHeight: 1.5 }}>{r.reflectionText}</div>
                  <div style={{ fontSize: '10px', color: '#555570', marginTop: '4px' }}>
                    {r.focusQuality} · {new Date(r.generatedAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Optimizer */}
      <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px' }}>
        <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '10px' }}>
          Policy Optimizer
        </div>
        <div style={{ fontSize: '12px', color: '#555570', marginBottom: '12px' }}>
          Run a bounded optimization cycle — evaluates policy mutations, promotes the winner only if it beats the baseline on all eval cases with no hard failures.
        </div>
        <button
          onClick={runOptimizer}
          disabled={optimizing}
          style={{
            padding: '9px 18px', borderRadius: '8px', border: '1px solid #2a2a40',
            background: optimizing ? '#1a1a2e' : '#0a0a12', color: optimizing ? '#555570' : '#8888a0',
            fontSize: '13px', cursor: optimizing ? 'default' : 'pointer', fontWeight: 600,
          }}
        >
          {optimizing ? 'Running...' : 'Run Optimizer'}
        </button>
        {optimizeResult && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: '#c0c0d5', padding: '8px', background: '#0a0a12', borderRadius: '6px' }}>
            {optimizeResult}
          </div>
        )}
      </div>
    </div>
  );
}
