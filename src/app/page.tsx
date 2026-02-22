'use client';

import { useEffect, useState } from 'react';
import ScoreRing from '@/components/ScoreRing';
import DonutChart from '@/components/DonutChart';

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
    }[];
  };
  weekTrend: {
    date: string; xp_earned: number; productive_minutes: number;
    distraction_minutes: number; tasks_completed: number;
  }[];
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

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
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Good {getTimeOfDay()}, Rohan 👋</h1>
          <p style={{ color: 'var(--text-secondary)' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <div className="flex items-center gap-4">
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
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{act.domain}</p>
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
    </div>
  );
}

function getTimeOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}
