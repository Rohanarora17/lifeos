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
  const [optimizeResult, setOptimizeResult] = useState<{
    promoted: { version: string } | null;
    canary: { status: string; canaryScore?: number; baselineCanaryScore?: number };
    baseline: { score: number; hardFailures: number };
    candidates: Array<{ version: string; score: number; hardFailures: number; rationale: string | null }>;
    mutationSource: string;
  } | null>(null);
  const [optimizerData, setOptimizerData] = useState<{
    activeArtifact: { id: number; version: string; guardian_eval_score: number; promoted_at: string | null } | null;
    recentRuns: Array<{ id: number; artifact_version: string | null; guardian_eval_score: number; hard_failures: number; status: string; completed_at: string | null }>;
    promotions: Array<{ version: string; guardian_eval_score: number; reason: string; promoted_at: string }>;
    canaryResults: Array<{ guardian_eval_score: number; status: string; notes: string | null }>;
  } | null>(null);
  const [historyData, setHistoryData] = useState<{
    overrides: Array<{
      id: number; session_id: string; url: string; title: string | null;
      reason: string; requested_minutes: number | null; approved: number;
      decision_reason: string; created_at: string;
    }>;
    sessions: Array<{
      session_id: string; target_title: string; goal_title: string | null;
      mood: string | null; duration_minutes: number; elapsed_minutes: number;
      average_focus_score: number; final_focus_score: number;
      blocked_count: number; override_count: number;
      dominant_distraction_domain: string | null; completed_at: string;
    }>;
  } | null>(null);
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

  const fetchHistoryData = useCallback(async () => {
    try {
      const res = await fetch('/api/guardian/history');
      if (res.ok) {
        const data = await res.json();
        setHistoryData({ overrides: data.overrides ?? [], sessions: data.sessions ?? [] });
      }
    } catch {}
  }, []);

  const fetchOptimizerData = useCallback(async () => {
    try {
      const res = await fetch('/api/guardian/optimize');
      if (res.ok) {
        const data = await res.json();
        setOptimizerData({
          activeArtifact: data.activeArtifact ?? null,
          recentRuns: data.recentRuns ?? [],
          promotions: data.promotions ?? [],
          canaryResults: data.canaryResults ?? [],
        });
      }
    } catch {}
  }, []);

  useEffect(() => {
    Promise.all([fetchBriefing(), fetchActiveSession(), fetchOptimizerData(), fetchHistoryData()]).finally(() => setLoading(false));
    const interval = setInterval(fetchBriefing, 60_000);
    return () => clearInterval(interval);
  }, [fetchBriefing, fetchActiveSession, fetchOptimizerData, fetchHistoryData]);

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
      if (res.status === 409) {
        alert('Cannot run optimizer during an active session.');
        return;
      }
      if (data.result) setOptimizeResult(data.result);
      await fetchOptimizerData();
    } catch (e) {
      console.error('Optimizer error:', e);
    } finally {
      setOptimizing(false);
    }
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

      {/* Session History */}
      {historyData && historyData.sessions.length > 0 && (
        <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px', marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Session History
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {historyData.sessions.map(s => (
              <div key={s.session_id} style={{
                display: 'grid', gridTemplateColumns: '1fr auto auto auto',
                alignItems: 'center', gap: '10px',
                padding: '8px 10px', background: '#0a0a12', borderRadius: '8px',
              }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: '#c0c0d5' }}>{s.target_title}</div>
                  {s.goal_title && <div style={{ fontSize: '10px', color: '#555570' }}>{s.goal_title}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{
                    fontSize: '14px', fontWeight: 800,
                    color: s.average_focus_score >= 75 ? '#22c55e' : s.average_focus_score >= 50 ? '#f59e0b' : '#ef4444',
                  }}>
                    {Math.round(s.average_focus_score)}
                  </div>
                  <div style={{ fontSize: '10px', color: '#555570' }}>focus</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '12px', color: '#8888a0' }}>{s.elapsed_minutes}m</div>
                  {s.blocked_count > 0 && <div style={{ fontSize: '10px', color: '#ef4444' }}>{s.blocked_count} blocked</div>}
                </div>
                <div style={{ fontSize: '10px', color: '#444460' }}>
                  {new Date(s.completed_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Override Review */}
      {historyData && historyData.overrides.length > 0 && (
        <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px', marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Override Review
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {historyData.overrides.map(o => {
              let displayUrl = o.url;
              try { displayUrl = new URL(o.url).hostname.replace(/^www\./, ''); } catch {}
              return (
                <div key={o.id} style={{
                  padding: '8px 10px', background: '#0a0a12', borderRadius: '8px',
                  borderLeft: `3px solid ${o.approved ? '#22c55e' : '#ef4444'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                        <span style={{
                          fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px',
                          background: o.approved ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.08)',
                          border: `1px solid ${o.approved ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.2)'}`,
                          color: o.approved ? '#22c55e' : '#ef4444',
                        }}>
                          {o.approved ? 'approved' : 'denied'}
                        </span>
                        <span style={{ fontSize: '12px', fontWeight: 600, color: '#a5b4fc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {displayUrl}
                        </span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#666680' }}>
                        Request: <span style={{ color: '#8888a0' }}>{o.reason}</span>
                      </div>
                      <div style={{ fontSize: '11px', color: '#555570', marginTop: '2px' }}>
                        Decision: {o.decision_reason}
                      </div>
                    </div>
                    <div style={{ fontSize: '10px', color: '#444460', flexShrink: 0 }}>
                      {new Date(o.created_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Optimizer */}
      <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px', marginBottom: '0' }}>

        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
            Policy Optimizer
          </div>
          <button
            onClick={runOptimizer}
            disabled={optimizing}
            style={{
              padding: '7px 16px', borderRadius: '8px', border: '1px solid #2a2a40',
              background: optimizing ? '#1a1a2e' : '#0a0a12', color: optimizing ? '#555570' : '#8888a0',
              fontSize: '12px', cursor: optimizing ? 'default' : 'pointer', fontWeight: 600,
            }}
          >
            {optimizing ? 'Running…' : 'Run Optimizer'}
          </button>
        </div>

        {/* Active policy */}
        <div style={{ marginBottom: '16px', padding: '10px 12px', background: '#0a0a12', border: '1px solid #2a2a40', borderRadius: '9px' }}>
          <div style={{ fontSize: '10px', color: '#555570', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Active Policy</div>
          {optimizerData?.activeArtifact ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#a5b4fc' }}>
                v{optimizerData.activeArtifact.version}
              </span>
              <span style={{ fontSize: '12px', color: '#8888a0' }}>
                eval score <span style={{ color: '#f0f0f5', fontWeight: 600 }}>{optimizerData.activeArtifact.guardian_eval_score.toFixed(2)}</span>
              </span>
              {optimizerData.activeArtifact.promoted_at && (
                <span style={{ fontSize: '10px', color: '#555570', marginLeft: 'auto' }}>
                  promoted {new Date(optimizerData.activeArtifact.promoted_at).toLocaleDateString()}
                </span>
              )}
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: '#555570' }}>No active policy yet — run the optimizer to generate a baseline.</div>
          )}
        </div>

        {/* Last run result */}
        {optimizeResult && (
          <div style={{ marginBottom: '16px', padding: '10px 12px', background: '#0a0a12', border: '1px solid #2a2a40', borderRadius: '9px' }}>
            <div style={{ fontSize: '10px', color: '#555570', fontWeight: 600, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Last Run · <span style={{ color: optimizeResult.mutationSource === 'llm' ? '#22c55e' : '#f59e0b' }}>{optimizeResult.mutationSource === 'llm' ? 'LLM mutations' : 'fallback variants'}</span>
            </div>

            {/* Baseline */}
            <div style={{ fontSize: '11px', color: '#8888a0', marginBottom: '8px' }}>
              Baseline: <span style={{ color: '#f0f0f5', fontWeight: 600 }}>{optimizeResult.baseline.score.toFixed(2)}</span>
              {optimizeResult.baseline.hardFailures > 0 && (
                <span style={{ color: '#ef4444', marginLeft: '8px' }}>{optimizeResult.baseline.hardFailures} hard failures</span>
              )}
            </div>

            {/* Candidates */}
            {optimizeResult.candidates.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '8px' }}>
                {optimizeResult.candidates.map((c, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'flex-start', gap: '8px',
                    padding: '6px 8px', borderRadius: '6px',
                    background: c.score > optimizeResult.baseline.score && c.hardFailures === 0
                      ? 'rgba(34,197,94,0.06)' : 'transparent',
                    border: `1px solid ${c.score > optimizeResult.baseline.score && c.hardFailures === 0 ? 'rgba(34,197,94,0.2)' : '#1a1a2e'}`,
                  }}>
                    <div style={{ flexShrink: 0, fontSize: '11px', fontWeight: 700, color: '#a5b4fc', minWidth: '60px' }}>
                      v{c.version}
                    </div>
                    <div style={{ flexShrink: 0, fontSize: '11px', fontWeight: 700, color: c.score > optimizeResult.baseline.score ? '#22c55e' : '#ef4444', minWidth: '36px' }}>
                      {c.score.toFixed(2)}
                    </div>
                    {c.hardFailures > 0 && (
                      <div style={{ flexShrink: 0, fontSize: '10px', color: '#ef4444' }}>{c.hardFailures} fail</div>
                    )}
                    {c.rationale && (
                      <div style={{ fontSize: '11px', color: '#666680', lineHeight: 1.4 }}>{c.rationale}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Promoted / Canary */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {optimizeResult.promoted ? (
                <span style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '5px', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.25)', color: '#22c55e', fontWeight: 600 }}>
                  Promoted v{optimizeResult.promoted.version}
                </span>
              ) : (
                <span style={{ fontSize: '11px', padding: '3px 8px', borderRadius: '5px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444', fontWeight: 600 }}>
                  No promotion — baseline retained
                </span>
              )}
              {optimizeResult.canary && (
                <span style={{
                  fontSize: '11px', padding: '3px 8px', borderRadius: '5px', fontWeight: 600,
                  background: optimizeResult.canary.status === 'passed' ? 'rgba(99,102,241,0.1)' : 'rgba(239,68,68,0.08)',
                  border: `1px solid ${optimizeResult.canary.status === 'passed' ? 'rgba(99,102,241,0.25)' : 'rgba(239,68,68,0.2)'}`,
                  color: optimizeResult.canary.status === 'passed' ? '#a5b4fc' : '#ef4444',
                }}>
                  Canary {optimizeResult.canary.status}
                  {optimizeResult.canary.canaryScore != null && ` · ${optimizeResult.canary.canaryScore.toFixed(2)}`}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Recent eval runs */}
        {optimizerData && optimizerData.recentRuns.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '10px', color: '#555570', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Recent Eval Runs</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {optimizerData.recentRuns.map(run => (
                <div key={run.id} style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '5px 8px', background: '#0a0a12', borderRadius: '6px',
                }}>
                  <span style={{ fontSize: '10px', color: '#555570', minWidth: '18px' }}>#{run.id}</span>
                  <span style={{ fontSize: '11px', color: '#a5b4fc', minWidth: '60px' }}>
                    {run.artifact_version ? `v${run.artifact_version}` : '—'}
                  </span>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: run.guardian_eval_score >= 0.7 ? '#22c55e' : run.guardian_eval_score >= 0.5 ? '#f59e0b' : '#ef4444' }}>
                    {run.guardian_eval_score.toFixed(2)}
                  </span>
                  {run.hard_failures > 0 && (
                    <span style={{ fontSize: '10px', color: '#ef4444' }}>{run.hard_failures} fail</span>
                  )}
                  <span style={{
                    fontSize: '10px', padding: '1px 6px', borderRadius: '4px', marginLeft: 'auto',
                    background: run.status === 'promoted' ? 'rgba(34,197,94,0.1)' : run.status === 'rolled_back' ? 'rgba(239,68,68,0.08)' : '#1a1a2e',
                    color: run.status === 'promoted' ? '#22c55e' : run.status === 'rolled_back' ? '#ef4444' : '#555570',
                  }}>
                    {run.status}
                  </span>
                  {run.completed_at && (
                    <span style={{ fontSize: '10px', color: '#444460' }}>
                      {new Date(run.completed_at).toLocaleDateString()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Promotion history */}
        {optimizerData && optimizerData.promotions.length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '10px', color: '#555570', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Promotion History</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {optimizerData.promotions.map((p, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '5px 8px', background: '#0a0a12', borderRadius: '6px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#a5b4fc', minWidth: '60px' }}>v{p.version}</span>
                  <span style={{ fontSize: '11px', color: '#22c55e', minWidth: '36px' }}>{p.guardian_eval_score.toFixed(2)}</span>
                  <span style={{ fontSize: '11px', color: '#666680', flex: 1 }}>{p.reason}</span>
                  <span style={{ fontSize: '10px', color: '#444460', flexShrink: 0 }}>
                    {new Date(p.promoted_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Last canary */}
        {optimizerData && optimizerData.canaryResults.length > 0 && (
          <div>
            <div style={{ fontSize: '10px', color: '#555570', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Last Canary</div>
            {(() => {
              const c = optimizerData.canaryResults[0];
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', background: '#0a0a12', borderRadius: '6px' }}>
                  <span style={{
                    fontSize: '11px', fontWeight: 700, padding: '2px 7px', borderRadius: '5px',
                    background: c.status === 'passed' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.08)',
                    border: `1px solid ${c.status === 'passed' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.2)'}`,
                    color: c.status === 'passed' ? '#22c55e' : '#ef4444',
                  }}>
                    {c.status}
                  </span>
                  <span style={{ fontSize: '11px', color: '#8888a0' }}>score <span style={{ color: '#f0f0f5', fontWeight: 600 }}>{c.guardian_eval_score.toFixed(2)}</span></span>
                  {c.notes && <span style={{ fontSize: '11px', color: '#555570', flex: 1 }}>{c.notes}</span>}
                </div>
              );
            })()}
          </div>
        )}

        {/* Empty state */}
        {!optimizerData?.activeArtifact && !optimizeResult && (
          <div style={{ fontSize: '12px', color: '#444460', textAlign: 'center', padding: '8px 0' }}>
            No optimization history. Run the optimizer to generate and evaluate policy candidates.
          </div>
        )}

      </div>
    </div>
  );
}
