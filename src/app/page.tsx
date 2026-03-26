'use client';

import { useEffect, useState } from 'react';
import ScoreRing from '@/components/ScoreRing';
import DonutChart from '@/components/DonutChart';
import AICoach from '@/components/AICoach';
import { useGuardianSession } from '@/hooks/useGuardianSession';

interface DashboardData {
  today: {
    date: string;
    score: number;
    productive_minutes: number;
    distraction_minutes: number;
    neutral_minutes: number;
    total_minutes: number;
    total_activities: number;
    tasks: { completed_today: number; active_today: number; in_progress: number };
    habits: { completed_today: number; total_habits: number };
    streak: number;
    level: { level: number; currentXp: number; nextLevelXp: number; progress: number };
    totalXp: number;
    topDomains: { domain: string; minutes: number; category: string }[];
    githubCommits: number;
    morningBrief: string | null;
    recentActivities: {
      id: number; url: string; domain: string; title: string;
      category: string; subcategory: string; started_at: string;
      duration_seconds: number; youtube_video_id: string | null;
      device_name?: string;
    }[];
  };
  weekTrend: {
    date: string; xp_earned: number; productive_minutes: number;
    distraction_minutes: number; tasks_completed: number;
  }[];
  intelligence?: {
    cognitiveLoad: { openTaskCount: number; mentalBandwidth: number; status: string; quickWins: any[] };
    recommendedTasks: { id: number; title: string; priority: string; goalTitle: string | null; score: number; reason: string }[];
    efficacyMode: { rate: number; isRecoveryMode: boolean; message: string; suggestedActions: string[] };
    goalConflicts: { goalA: string; goalB: string; message: string }[];
    topGoals: { id: number; title: string; deadline: string | null; category: string; total_tasks: number; done_tasks: number; progress: number }[];
    unreadAlerts: number;
  };
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<{ id: number; type: string; message: string; severity: string; created_at: string }[]>([]);
  const [showAlerts, setShowAlerts] = useState(false);
  const { session, start: startSession, end: endSession } = useGuardianSession();
  const focusSessions: any[] = []; // Legacy section hidden — guardian history is at /guardian
  const [liveFocusStats, setLiveFocusStats] = useState({ productiveSeconds: 0, distractionSeconds: 0 });

  // Reset live stats when a new session starts
  useEffect(() => {
    if (session.active) setLiveFocusStats({ productiveSeconds: 0, distractionSeconds: 0 });
  }, [session.sessionId]);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
    fetch('/api/alerts')
      .then(r => r.json())
      .then(d => setAlerts(d.alerts || []))
      .catch(() => { });
  }, []);

  // Auto-end session when timer hits zero
  useEffect(() => {
    if (session.active && session.timeLeftSeconds === 0) {
      endSession().then(() => fetch('/api/dashboard').then(r => r.json()).then(d => setData(d)).catch(() => {}));
    }
  }, [session.active, session.timeLeftSeconds, endSession]);

  const startFocus = async (goalId: number | null, goalTitle: string | null, taskTitle: string | null, mins: number = 60) => {
    await startSession({
      goalId: goalId ? String(goalId) : null,
      goalTitle,
      conceptNodeName: taskTitle || goalTitle || 'Focus Session',
      durationMinutes: mins,
    });
  };

  const cancelFocus = async () => {
    await endSession();
    fetch('/api/dashboard').then(r => r.json()).then(d => setData(d)).catch(() => {});
  };

  const markAllRead = async () => {
    await fetch('/api/alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setAlerts([]);
    setShowAlerts(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="streak-fire mb-4">⚡</div>
          <p style={{ color: 'var(--text-secondary)' }}>Loading your day...</p>
        </div>
      </div>
    );
  }

  const today = data?.today;
  if (!today) {
    return (
      <div className="text-center py-20">
        <h2 className="text-2xl font-bold mb-2">Welcome to LifeOS! 🚀</h2>
        <p style={{ color: 'var(--text-secondary)' }}>Install the browser extension to start tracking your activity.</p>
      </div>
    );
  }

  const formatTime = (mins: number) => {
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  return (
    <div className="max-w-[1400px] mx-auto space-y-6 animate-fade-in">
      {/* Focus Session Panel — Active or Start */}
      {session.active ? (
        <div className="card relative overflow-hidden" style={{ borderColor: 'var(--accent-purple)', background: 'rgba(157, 78, 221, 0.05)' }}>
          {/* Progress bar at top */}
          <div className="absolute top-0 left-0 h-1 bg-gradient-to-r from-[var(--accent-purple)] to-[var(--accent-blue)]"
            style={{ width: `${session.progressPct}%`, transition: 'width 1s linear' }} />

          <div style={{ display: 'flex', alignItems: 'center', gap: '24px', padding: '8px 0' }}>
            {/* Left: Timer */}
            <div style={{ textAlign: 'center', minWidth: '160px' }}>
              <p className="text-xs font-semibold mb-1" style={{ color: 'var(--accent-purple)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>🎯 Guardian Active</p>
              <div className="font-mono font-bold tracking-wider" style={{ fontSize: '48px', lineHeight: 1, color: 'var(--accent-purple)' }}>
                {Math.floor(session.timeLeftSeconds / 60).toString().padStart(2, '0')}:{(session.timeLeftSeconds % 60).toString().padStart(2, '0')}
              </div>
              <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>remaining</p>
            </div>

            {/* Center: Details */}
            <div style={{ flex: 1 }}>
              <p className="text-base font-semibold mb-2">
                {session.targetTitle || 'Focus Session'}
              </p>
              {/* Progress bar */}
              <div style={{ background: 'rgba(255,255,255,0.06)', borderRadius: '4px', height: '8px', overflow: 'hidden', marginBottom: '8px' }}>
                <div style={{
                  width: `${session.progressPct}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, var(--accent-purple), var(--accent-blue))',
                  borderRadius: '4px',
                  transition: 'width 1s linear',
                }} />
              </div>
              <div className="flex gap-4" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                <span>⏱️ Elapsed: <strong style={{ color: 'var(--text-primary)' }}>{formatTime(Math.round(session.elapsedSeconds / 60))}</strong></span>
                <span>⏳ Remaining: <strong style={{ color: 'var(--text-primary)' }}>{formatTime(Math.ceil(session.timeLeftSeconds / 60))}</strong></span>
                <span>📊 {session.progressPct}% done</span>
              </div>
              {liveFocusStats.productiveSeconds > 0 || liveFocusStats.distractionSeconds > 0 ? (
                <div className="flex gap-4 mt-2" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  <span>🟢 Productive: <strong style={{ color: '#10b981' }}>{formatTime(Math.round(liveFocusStats.productiveSeconds / 60))}</strong></span>
                  <span>🔴 Distracted: <strong style={{ color: '#ef4444' }}>{formatTime(Math.round(liveFocusStats.distractionSeconds / 60))}</strong></span>
                </div>
              ) : null}
            </div>

            {/* Right: Stop button */}
            <div style={{ flexShrink: 0 }}>
              <button
                onClick={cancelFocus}
                style={{
                  padding: '10px 20px',
                  background: 'rgba(239,68,68,0.15)',
                  color: '#ef4444',
                  border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: '8px',
                  fontWeight: 600,
                  fontSize: '13px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                }}
              >⏹ Stop Session</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="card" style={{ borderColor: 'rgba(157,78,221,0.2)' }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>🎯 Start Focus Session</h3>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-end' }}>
            {/* Goal/Task selector */}
            <div style={{ flex: 1 }}>
              <label className="text-[11px]" style={{ color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>What are you working on?</label>
              <select
                id="dashboard-focus-target"
                style={{
                  width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
                  color: 'var(--text-primary)', fontSize: '13px',
                }}
              >
                <option value="">General focus session</option>
                {data?.intelligence?.topGoals?.map(g => (
                  <option key={`goal-${g.id}`} value={`goal-${g.id}`} data-title={g.title}>🎯 {g.title}</option>
                ))}
                {data?.intelligence?.recommendedTasks?.map(t => (
                  <option key={`task-${t.id}`} value={`task-${t.id}`} data-title={t.title}>📋 {t.title}</option>
                ))}
              </select>
            </div>

            {/* Duration picker */}
            <div>
              <label className="text-[11px]" style={{ color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Duration</label>
              <select
                id="dashboard-focus-duration"
                style={{
                  padding: '8px 10px', background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
                  color: 'var(--text-primary)', fontSize: '13px',
                }}
                defaultValue="60"
              >
                <option value="25">25 min</option>
                <option value="45">45 min</option>
                <option value="60">1 hour</option>
                <option value="90">90 min</option>
                <option value="120">2 hours</option>
              </select>
            </div>

            {/* Start button */}
            <button
              onClick={() => {
                const targetEl = document.getElementById('dashboard-focus-target') as HTMLSelectElement;
                const durationEl = document.getElementById('dashboard-focus-duration') as HTMLSelectElement;
                const selected = targetEl?.value || '';
                const selectedOption = targetEl?.options[targetEl.selectedIndex];
                const mins = parseInt(durationEl?.value || '60');
                let goalId: number | null = null, goalTitle: string | null = null, taskTitle: string | null = null;
                const label = selectedOption?.dataset?.title || selectedOption?.textContent?.replace(/^[🎯📋]\s*/, '') || null;
                if (selected.startsWith('goal-')) {
                  goalId = parseInt(selected.split('-')[1]);
                  goalTitle = label;
                } else if (selected.startsWith('task-')) {
                  taskTitle = label;
                }
                startFocus(goalId, goalTitle, taskTitle, mins);
              }}
              style={{
                padding: '8px 24px',
                background: 'linear-gradient(135deg, #9d4edd, #667eea)',
                border: 'none', borderRadius: '8px',
                color: 'white', fontWeight: 600, fontSize: '13px',
                cursor: 'pointer', whiteSpace: 'nowrap',
                transition: 'all 0.15s',
              }}
            >▶ Start Focus</button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Good {getTimeOfDay()}, Rohan 👋</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* Notification Bell */}
          <div className="relative">
            <button
              onClick={() => setShowAlerts(!showAlerts)}
              className="w-10 h-10 rounded-xl flex items-center justify-center transition-all"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
            >
              🔔
              {alerts.length > 0 && (
                <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold"
                  style={{ background: 'var(--accent-red)', color: 'white', fontSize: '0.65rem' }}>
                  {alerts.length}
                </span>
              )}
            </button>
            {showAlerts && (
              <div className="absolute right-0 top-12 w-80 max-h-96 overflow-y-auto card z-50 shadow-2xl" style={{ padding: '0' }}>
                <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                  <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Notifications</span>
                  {alerts.length > 0 && <button onClick={markAllRead} className="text-xs" style={{ color: 'var(--accent-blue)' }}>Mark all read</button>}
                </div>
                {alerts.length > 0 ? alerts.slice(0, 10).map(a => (
                  <div key={a.id} className="px-3 py-2 border-b text-sm" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex items-start gap-2">
                      <span>{a.severity === 'urgent' ? '🚨' : a.severity === 'warning' ? '⚠️' : 'ℹ️'}</span>
                      <div>
                        <p style={{ color: 'var(--text-primary)', fontSize: '0.8rem' }}>{a.message}</p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {new Date(a.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  </div>
                )) : (
                  <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>No new notifications ✨</p>
                )}
              </div>
            )}
          </div>
          <div className="text-center">
            <div className="streak-fire">{today.streak > 0 ? '🔥' : '💤'}</div>
            <p className="text-sm font-bold">{today.streak} day streak</p>
          </div>
        </div>
      </div>

      {/* Top Row: Score + Level + Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Accountability Score */}
        <div className="stat-card purple flex items-center gap-5">
          <ScoreRing score={today.score} size={100} />
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Accountability</p>
            <p className="text-2xl font-bold">{today.score}/100</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {today.score >= 80 ? 'Outstanding!' : today.score >= 60 ? 'Good going' : 'Room to improve'}
            </p>
          </div>
        </div>

        {/* Level */}
        <div className="stat-card blue">
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Level</p>
          <div className="flex items-baseline gap-2 mb-3">
            <span className="text-3xl font-bold">{today.level.level}</span>
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>{today.totalXp} XP total</span>
          </div>
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${today.level.progress}%` }} />
          </div>
          <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
            {today.level.currentXp}/{today.level.nextLevelXp} XP to next level
          </p>
        </div>

        {/* Tasks */}
        <div className="stat-card green">
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Tasks Today</p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{today.tasks.completed_today}</span>
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
              / {today.tasks.completed_today + today.tasks.active_today} completed
            </span>
          </div>
          {today.tasks.in_progress > 0 && (
            <p className="text-xs mt-2 badge badge-blue">{today.tasks.in_progress} in progress</p>
          )}
        </div>

        {/* Habits */}
        <div className="stat-card orange">
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>Habits Today</p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold">{today.habits.completed_today}</span>
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
              / {today.habits.total_habits} checked
            </span>
          </div>
          <div className="progress-bar mt-3">
            <div className="progress-bar-fill" style={{
              width: `${today.habits.total_habits > 0 ? (today.habits.completed_today / today.habits.total_habits) * 100 : 0}%`,
              background: 'var(--gradient-fire)'
            }} />
          </div>
        </div>
      </div>

      {/* Middle Row: Time Breakdown + Top Domains + GitHub */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Time Breakdown Donut */}
        <div className="card flex items-center gap-6">
          <DonutChart
            productive={today.productive_minutes || 0}
            distraction={today.distraction_minutes || 0}
            neutral={today.neutral_minutes || 0}
          />
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ background: 'var(--accent-green)' }} />
              <span className="text-sm">Productive: <strong>{formatTime(today.productive_minutes || 0)}</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ background: 'var(--accent-red)' }} />
              <span className="text-sm">Distraction: <strong>{formatTime(today.distraction_minutes || 0)}</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ background: 'var(--accent-yellow)' }} />
              <span className="text-sm">Neutral: <strong>{formatTime(today.neutral_minutes || 0)}</strong></span>
            </div>
          </div>
        </div>

        {/* Top Domains */}
        <div className="card">
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>Top Sites Today</h3>
          <div className="space-y-2">
            {today.topDomains.length > 0 ? today.topDomains.map((d, i) => (
              <div key={i} className="flex items-center justify-between py-1.5">
                <div className="flex items-center gap-2">
                  <div className={`timeline-dot ${d.category}`} />
                  <span className="text-sm truncate max-w-[150px]">{d.domain}</span>
                </div>
                <span className="text-sm font-mono" style={{ color: 'var(--text-muted)' }}>{formatTime(d.minutes)}</span>
              </div>
            )) : (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No activity tracked yet today</p>
            )}
          </div>
        </div>

        {/* GitHub & Quick Stats */}
        <div className="card">
          <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--text-secondary)' }}>Quick Stats</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between py-1.5">
              <span className="text-sm">💻 GitHub Commits</span>
              <span className="text-lg font-bold">{today.githubCommits}</span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-sm">🌐 Sites Visited</span>
              <span className="text-lg font-bold">{today.total_activities}</span>
            </div>
            <div className="flex items-center justify-between py-1.5">
              <span className="text-sm">⏱️ Total Screen</span>
              <span className="text-lg font-bold">{formatTime(today.total_minutes || 0)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Morning Brief */}
      {today.morningBrief && (
        <div className="card" style={{ borderColor: 'rgba(102, 126, 234, 0.3)' }}>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <span>🌅</span> AI Morning Brief
          </h3>
          <div className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
            {today.morningBrief}
          </div>
        </div>
      )}

      {/* Intelligence Row: What to Work On + Goal Progress + Brain Health */}
      {data?.intelligence && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Daily Plan */}
          <div className="card" style={{ borderColor: 'rgba(102, 126, 234, 0.4)', background: 'linear-gradient(to bottom, rgba(102,126,234,0.05), transparent)' }}>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <span>📋</span> Daily Plan (AI Curated)
            </h3>
            <div className="space-y-2">
              {data.intelligence.recommendedTasks.length > 0 ? data.intelligence.recommendedTasks.slice(0, 3).map((t, i) => (
                <div key={t.id} className="flex items-start gap-3 py-2 group">
                  <button
                    onClick={() => {
                      // Optimistic remove
                      setData(prev => {
                        if (!prev || !prev.intelligence) return prev;
                        return {
                          ...prev,
                          intelligence: {
                            ...prev.intelligence,
                            recommendedTasks: prev.intelligence.recommendedTasks.filter(rt => rt.id !== t.id)
                          }
                        };
                      });
                      // API Call
                      fetch('/api/tasks/' + t.id, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ status: 'done' })
                      }).catch(() => { });
                    }}
                    title="Mark task as done"
                    className="w-5 h-5 rounded-full mt-0.5 border-2 flex-shrink-0 border-slate-500 hover:border-green-500 hover:bg-green-500/10 transition-colors"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{t.title}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t.reason}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="badge text-xs flex-shrink-0" style={{
                      background: t.priority === 'critical' ? 'rgba(255,85,85,0.15)' : t.priority === 'high' ? 'rgba(255,165,0,0.15)' : 'rgba(102,126,234,0.15)',
                      color: t.priority === 'critical' ? 'var(--accent-red)' : t.priority === 'high' ? 'var(--accent-orange)' : 'var(--accent-blue)',
                    }}>{t.priority}</span>
                    <button
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-2 py-0.5 rounded cursor-pointer"
                      style={{ background: 'var(--accent-purple)', color: 'white' }}
                      onClick={() => startFocus(null, null, t.title)}
                      disabled={session.active}
                    >
                      ⏱️ Focus
                    </button>
                  </div>
                </div>
              )) : (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No active tasks. Add some! 📝</p>
              )}
            </div>
            {data.intelligence.efficacyMode.isRecoveryMode && (
              <div className="mt-3 p-2 rounded-lg text-xs" style={{ background: 'rgba(255,165,0,0.1)', color: 'var(--accent-orange)' }}>
                💡 Recovery Mode: {data.intelligence.efficacyMode.suggestedActions[0]}
              </div>
            )}
          </div>

          {/* Goal Progress */}
          <div className="card">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <span>🎯</span> Goal Progress
            </h3>
            <div className="space-y-3">
              {data.intelligence.topGoals.length > 0 ? data.intelligence.topGoals.map(g => (
                <div key={g.id}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm truncate mr-2">{g.title}</span>
                    <span className="text-xs font-bold tabular-nums" style={{
                      color: g.progress >= 80 ? 'var(--accent-green)' : g.progress >= 50 ? 'var(--accent-yellow)' : 'var(--accent-orange)'
                    }}>{g.progress}%</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                    <div className="h-full rounded-full transition-all" style={{
                      width: `${g.progress}%`,
                      background: g.progress >= 80 ? 'var(--accent-green)' : g.progress >= 50 ? 'var(--accent-yellow)' : 'var(--accent-orange)'
                    }} />
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {g.done_tasks}/{g.total_tasks} tasks {g.deadline && `· due ${new Date(g.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                  </p>
                </div>
              )) : (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No active goals. Set one! 🎯</p>
              )}
            </div>
          </div>

          {/* Brain Health */}
          <div className="card">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <span>🧩</span> Brain Health
            </h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">Mental Bandwidth</span>
                <span className="text-sm font-bold" style={{
                  color: data.intelligence.cognitiveLoad.status === 'clear' ? 'var(--accent-green)'
                    : data.intelligence.cognitiveLoad.status === 'moderate' ? 'var(--accent-yellow)'
                      : 'var(--accent-red)'
                }}>
                  {data.intelligence.cognitiveLoad.mentalBandwidth}%
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                <div className="h-full rounded-full" style={{
                  width: `${data.intelligence.cognitiveLoad.mentalBandwidth}%`,
                  background: data.intelligence.cognitiveLoad.status === 'clear' ? 'var(--accent-green)'
                    : data.intelligence.cognitiveLoad.status === 'moderate' ? 'var(--accent-yellow)'
                      : 'var(--accent-red)'
                }} />
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {data.intelligence.cognitiveLoad.openTaskCount} open tasks · {data.intelligence.cognitiveLoad.status === 'overloaded' ? 'Consider deferring some' : data.intelligence.cognitiveLoad.status === 'moderate' ? 'Manageable load' : 'Clear headspace'}
              </p>
              <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <span className="text-sm">Self-Efficacy</span>
                <span className="text-sm font-bold" style={{
                  color: data.intelligence.efficacyMode.rate >= 70 ? 'var(--accent-green)'
                    : data.intelligence.efficacyMode.rate >= 40 ? 'var(--accent-yellow)'
                      : 'var(--accent-red)'
                }}>{data.intelligence.efficacyMode.rate}%</span>
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{data.intelligence.efficacyMode.message}</p>
              {data.intelligence.goalConflicts.length > 0 && (
                <div className="mt-2 p-2 rounded-lg text-xs" style={{ background: 'rgba(255,85,85,0.1)', color: 'var(--accent-red)' }}>
                  ⚠️ {data.intelligence.goalConflicts[0].message}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Focus Session History */}
      {focusSessions.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>🎯 Recent Focus Sessions</h3>
          </div>
          <div className="space-y-3">
            {focusSessions.slice(0, 5).map((s: any, i: number) => {
              const duration = s.actual_duration_seconds ? Math.round(s.actual_duration_seconds / 60) : (s.duration_minutes || 0);
              const prodMin = s.productive_seconds ? Math.round(s.productive_seconds / 60) : 0;
              const distMin = s.distraction_seconds ? Math.round(s.distraction_seconds / 60) : 0;
              const neutMin = s.neutral_seconds ? Math.round(s.neutral_seconds / 60) : 0;
              const totalSecs = (s.productive_seconds || 0) + (s.distraction_seconds || 0) + (s.neutral_seconds || 0);
              const prodPct = totalSecs > 0 ? Math.round((s.productive_seconds / totalSecs) * 100) : 0;
              const distPct = totalSecs > 0 ? Math.round((s.distraction_seconds / totalSecs) * 100) : 0;
              const neutPct = totalSecs > 0 ? Math.round((s.neutral_seconds / totalSecs) * 100) : 0;
              const score = s.ai_report ? (() => { try { return JSON.parse(s.ai_report)?.score; } catch { return null; } })() : null;
              const startTime = s.started_at ? new Date(s.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
              const endTime = s.ended_at ? new Date(s.ended_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
              const dateStr = s.started_at ? new Date(s.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
              const topDomains = s.top_domains ? (() => { try { return JSON.parse(s.top_domains); } catch { return []; } })() : [];

              return (
                <div key={i} style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  borderRadius: '10px',
                  padding: '12px',
                }}>
                  {/* Header: Title + Score + Status */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">
                        {s.task_title || s.goal_title || s.primary_domain || 'Focus Session'}
                      </p>
                      <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {dateStr}{startTime && ` · ${startTime}`}{endTime && ` → ${endTime}`} · {formatTime(duration)}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0 ml-3">
                      {score ? (
                        <span className="badge text-xs" style={{
                          background: score >= 70 ? 'rgba(34,197,94,0.15)' : score >= 40 ? 'rgba(234,179,8,0.15)' : 'rgba(239,68,68,0.15)',
                          color: score >= 70 ? 'var(--accent-green)' : score >= 40 ? 'var(--accent-yellow)' : 'var(--accent-red)',
                        }}>{score}/100</span>
                      ) : (
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {s.status === 'completed' ? '✅' : s.status === 'abandoned' ? '⏹️' : '🔄'}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Time Breakdown Bar */}
                  {totalSecs > 0 && (
                    <div style={{ marginBottom: '8px' }}>
                      <div style={{ display: 'flex', height: '6px', borderRadius: '3px', overflow: 'hidden', background: 'rgba(255,255,255,0.05)' }}>
                        {prodPct > 0 && <div style={{ width: `${prodPct}%`, background: '#22c55e' }} />}
                        {neutPct > 0 && <div style={{ width: `${neutPct}%`, background: '#eab308' }} />}
                        {distPct > 0 && <div style={{ width: `${distPct}%`, background: '#ef4444' }} />}
                      </div>
                      <div className="flex gap-3 mt-1" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        <span>🟢 {prodMin}m productive</span>
                        <span>🟡 {neutMin}m neutral</span>
                        <span>🔴 {distMin}m distracted</span>
                      </div>
                    </div>
                  )}

                  {/* Stats Row */}
                  <div className="flex gap-4" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    {(s.tabs_blocked > 0 || s.tabs_overridden > 0) && (
                      <>
                        {s.tabs_blocked > 0 && <span>🛑 {s.tabs_blocked} blocked</span>}
                        {s.tabs_overridden > 0 && <span>⚠️ {s.tabs_overridden} overrides</span>}
                      </>
                    )}
                    {topDomains.length > 0 && (
                      <span className="truncate">
                        🌐 {topDomains.slice(0, 3).map((d: any) => typeof d === 'string' ? d : d.domain).join(', ')}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent Activity Feed */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Recent Activity</h3>
          <a href="/activity" className="text-xs" style={{ color: 'var(--accent-blue)' }}>View all →</a>
        </div>
        <div className="space-y-1">
          {today.recentActivities.length > 0 ? today.recentActivities.map(act => (
            <div key={act.id} className="timeline-item">
              <div className={`timeline-dot ${act.category}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{act.title || act.domain}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{act.domain}</p>
                  {act.device_name && act.device_name !== 'Unknown Device' && (
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)', opacity: 0.7 }}>
                      💻 {act.device_name}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <span className={`badge ${act.category === 'productive' ? 'badge-green' : act.category === 'distraction' ? 'badge-red' : 'badge-yellow'}`}>
                  {act.subcategory}
                </span>
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                  {act.duration_seconds > 0 ? formatTime(Math.round(act.duration_seconds / 60)) : '—'}
                </p>
              </div>
            </div>
          )) : (
            <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
              No activity tracked yet. Install the browser extension to get started! 🚀
            </p>
          )}
        </div>
      </div>
      <AICoach />
    </div>
  );
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}
