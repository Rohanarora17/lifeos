'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import ScoreRing from '@/components/ScoreRing';
import DonutChart from '@/components/DonutChart';
import AICoach from '@/components/AICoach';
import { useGuardianSession } from '@/hooks/useGuardianSession';
import { scoreColor, scoreBadgeBg, scoreBadgeBorder, scoreBadgeText, classifyScore, cognitiveLoadColor, progressColor } from '@/lib/score-classify';

type PersonalizationMode = 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';

interface DashboardPersonalization {
  mode: PersonalizationMode;
  guidance: string;
  recommendedSessionMinutes: number;
  openTasks: number;
  overdueTasks: number;
  doingTasks: string[];
  uncheckedHabits: string[];
  calendarEvents: string[];
  recentDistractionMinutes: number;
  plannedFocus: {
    plannedToday: number;
    completedToday: number;
    skippedToday: number;
    nextTitle: string | null;
    nextMinutes: number | null;
    recentFollowThroughRate: number | null;
  };
  standupGoal: string | null;
  narrative: string;
  energy: 'high' | 'medium' | 'low';
  mood: 'high' | 'medium' | 'low' | null;
  energySource: 'explicit_checkin' | 'baseline';
  moodSource: 'explicit_checkin' | 'unknown';
  stateUpdatedAt: string | null;
  coachingStyle: 'direct' | 'balanced' | 'gentle';
  focusTrend: 'improving' | 'declining' | 'stable';
  nextBestFocusWindow: string;
  alertFatigueLevel: 'low' | 'medium' | 'high';
  recentAlerts: number;
  helpfulRate: number | null;
  corrections30d: number;
  activeSessionTarget: string | null;
  /** True when history epoch is early and <2 post-epoch sessions — show defaults not "learned" claims */
  learningPhase?: boolean;
  learningPhaseLabel?: string;
  learningPhaseReason?: string;
}

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
    cognitiveLoad: { openTaskCount: number; mentalBandwidth: number; status: string; quickWins: unknown[] };
    recommendedTasks: {
      id: number;
      title: string;
      priority: string;
      goalTitle: string | null;
      score: number;
      reason: string;
      momentFit?: 'high' | 'medium' | 'low';
      estimatedMinutes?: number | null;
      energyRequired?: 'low' | 'medium' | 'high' | null;
      feedbackHint?: string | null;
      timeProgress?: {
        targetMinutes: number | null;
        creditedMinutes: number;
        remainingMinutes: number | null;
        percent: number | null;
        linkedSessions: number;
      };
    }[];
    efficacyMode: { rate: number; isRecoveryMode: boolean; message: string; suggestedActions: string[] };
    goalConflicts: { goalA: string; goalB: string; message: string }[];
    topGoals: { id: number; title: string; deadline: string | null; category: string; total_tasks: number; done_tasks: number; progress: number }[];
    unreadAlerts: number;
    dashboardPolicy: {
      mode: PersonalizationMode;
      headline: string;
      primaryAction: 'continue_focus' | 'start_recommended_task' | 'clear_deadline' | 'minimum_habit' | 'plan_tomorrow' | 'recover' | 'review_day';
      primaryLabel: string;
      primaryReason: string;
      focusTarget: {
        type: 'task' | 'session' | 'habit' | 'planning' | 'review';
        id: number | null;
        title: string;
      };
      sessionMinutes: number;
      sessionReason: string;
      notificationPosture: 'normal' | 'quiet' | 'urgent_only';
      notificationReason: string;
      dashboardEmphasis: Array<'tasks' | 'habits' | 'calendar' | 'recovery' | 'reflection' | 'activity'>;
    };
  };
  personalization?: DashboardPersonalization;
}

type DashboardPolicy = NonNullable<DashboardData['intelligence']>['dashboardPolicy'];

interface InsightsData {
  profile: {
    coachingInsights: string[];
    nextBestFocusWindow: string | null;
    focusTrend: string;
    preferredCoachingStyle: string | null;
    weeklyProgressSummary: string | null;
  };
  habits: { completionRate: number | null };
}

interface FocusSessionHistory {
  actual_duration_seconds?: number | null;
  duration_minutes?: number | null;
  productive_seconds?: number | null;
  distraction_seconds?: number | null;
  neutral_seconds?: number | null;
  ai_report?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  top_domains?: string | null;
  task_title?: string | null;
  goal_title?: string | null;
  primary_domain?: string | null;
  status?: string | null;
  tabs_blocked?: number | null;
  tabs_overridden?: number | null;
}

interface AlertCenterPolicy {
  posture: 'normal' | 'quiet' | 'urgent_only';
  reason: string;
  emptyState: string;
  visibleSeverities: string[];
  quietedCount: number;
  learnedQuietedCount: number;
  summary: string;
  rawUnreadCount: number;
  mode: PersonalizationMode;
  alertFatigueLevel: 'low' | 'medium' | 'high';
}

interface SessionDomainSummary {
  domain?: string;
}

const modeLabels: Record<PersonalizationMode, string> = {
  protect_focus: 'Protect focus',
  deadline_pressure: 'Deadline pressure',
  recovery: 'Recovery',
  planning: 'Planning',
  normal: 'Balanced',
};

const modeAccents: Record<PersonalizationMode, string> = {
  protect_focus: '#22c55e',
  deadline_pressure: '#ef4444',
  recovery: '#f59e0b',
  planning: '#38bdf8',
  normal: '#a78bfa',
};

function formatHelpfulRate(rate: number | null) {
  return rate === null ? 'learning' : `${Math.round(rate * 100)}% helpful`;
}

function formatDurationLabel(mins: number) {
  const rounded = Math.max(0, Math.round(mins));
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatAdaptiveSignal(personalization: DashboardPersonalization) {
  if (personalization.overdueTasks > 0) {
    return `${personalization.overdueTasks} overdue task${personalization.overdueTasks === 1 ? '' : 's'} need concrete relief.`;
  }
  if (personalization.mode === 'protect_focus') {
    return 'Focus looks worth protecting, so low-urgency nudges should stay quiet.';
  }
  if (personalization.mode === 'recovery') {
    return 'Energy is low, so suggestions should shrink to minimum viable actions.';
  }
  if (personalization.recentDistractionMinutes >= 20) {
    return `${personalization.recentDistractionMinutes} distraction minutes in the last 2 hours.`;
  }
  if (personalization.standupGoal) {
    return `Today is anchored on: ${personalization.standupGoal}`;
  }
  return personalization.guidance;
}

function formatNotificationEmpty(personalization?: DashboardPersonalization, alertPolicy?: AlertCenterPolicy | null) {
  if (alertPolicy) return alertPolicy.emptyState;
  if (!personalization) return 'No new notifications';
  if (personalization.plannedFocus.nextTitle) {
    return `No new notifications. Keep space for ${personalization.plannedFocus.nextTitle}${personalization.plannedFocus.nextMinutes ? ` (${personalization.plannedFocus.nextMinutes}m)` : ''}.`;
  }
  if (personalization.standupGoal) return `No new notifications. Today's anchor is: ${personalization.standupGoal}`;
  if (personalization.alertFatigueLevel === 'high') return 'Quieting non-urgent notifications for now';
  if (personalization.mode === 'protect_focus') return 'No routine notifications during this focus window';
  if (personalization.mode === 'recovery') return 'Only important nudges right now';
  if (personalization.nextBestFocusWindow) return `No new notifications. Best learned window: ${personalization.nextBestFocusWindow}.`;
  return `No new notifications. ${personalization.guidance}`;
}

function formatActivityEmpty(personalization?: DashboardPersonalization, surface: 'domains' | 'timeline' = 'domains') {
  if (!personalization) {
    return surface === 'timeline'
      ? 'No activity tracked yet. Start a session or enable activity capture.'
      : 'No activity tracked yet today.';
  }

  if (personalization.plannedFocus.nextTitle) {
    return `No activity captured yet. Start "${personalization.plannedFocus.nextTitle}" so planned focus can be compared with actual work.`;
  }

  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'No activity captured yet. Even a small recovery-safe block helps calibrate today.';
  }

  if (personalization.mode === 'deadline_pressure') {
    return 'No activity captured yet. Track the first deadline-relief block before optional work.';
  }

  if (personalization.mode === 'planning') {
    return 'No activity captured yet. Generate or start a tomorrow setup block to seed the plan.';
  }

  if (personalization.mode === 'protect_focus') {
    return 'No activity captured yet. Start the protected focus thread so interruptions can be measured.';
  }

  return surface === 'timeline'
    ? `No activity captured yet. Your learned default is ${formatDurationLabel(personalization.recommendedSessionMinutes)}.`
    : 'No activity captured yet. Start the next useful block to seed today.';
}

function focusTargetLabel(personalization?: DashboardPersonalization, policy?: DashboardPolicy) {
  if (policy?.focusTarget.title) return `Next: ${policy.focusTarget.title}`;
  if (!personalization) return 'What are you working on?';
  if (personalization.plannedFocus.nextTitle) return `Planned next: ${personalization.plannedFocus.nextTitle}`;
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'Smallest useful focus now';
  }
  if (personalization.mode === 'deadline_pressure') return 'Deadline relief target';
  if (personalization.mode === 'planning') return 'Tomorrow setup target';
  return 'What should move forward now?';
}

function generalFocusOptionLabel(personalization?: DashboardPersonalization, policy?: DashboardPolicy) {
  if (policy?.focusTarget.type === 'planning') return 'Planning block';
  if (policy?.focusTarget.type === 'review') return 'Review block';
  if (policy?.focusTarget.type === 'habit') return 'Minimum habit block';
  if (!personalization) return 'General focus session';
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') return 'Small recovery-safe session';
  if (personalization.mode === 'deadline_pressure') return 'Deadline relief session';
  if (personalization.mode === 'protect_focus') return 'Protect current focus thread';
  if (personalization.mode === 'planning') return 'Tomorrow planning session';
  return 'General focus session';
}

function dashboardTasksEmpty(personalization?: DashboardPersonalization, policy?: DashboardPolicy) {
  if (policy?.focusTarget.title) return `No ranked tasks here. Start with "${policy.focusTarget.title}" from today's policy.`;
  if (!personalization) return 'No active tasks yet. Add a time target so sessions can complete it.';
  if (personalization.plannedFocus.plannedToday > personalization.plannedFocus.completedToday) {
    return `No ranked tasks here. Protect the ${personalization.plannedFocus.plannedToday - personalization.plannedFocus.completedToday} planned focus block(s) still open.`;
  }
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'No active tasks here. Add one small recovery-safe time target if today still needs a win.';
  }
  if (personalization.mode === 'deadline_pressure') return 'No active tasks here. Add the nearest deadline-relief target before optional work.';
  if (personalization.mode === 'planning') return 'No active tasks here. Turn tomorrow\'s intention into scheduled time blocks.';
  if (personalization.standupGoal) return `No active tasks here. Add one measurable block for: ${personalization.standupGoal}`;
  return 'No active tasks here. Add the next concrete time target.';
}

function dashboardGoalsEmpty(personalization?: DashboardPersonalization, policy?: DashboardPolicy) {
  if (policy?.focusTarget.type === 'planning') return 'No active goals here. Use planning mode to choose what tomorrow should optimize for.';
  if (!personalization) return 'No active goals yet. Add the goal that should anchor tasks, sessions, and rewards.';
  if (personalization.mode === 'deadline_pressure') return 'No active goals here. Add the deadline goal so ranking can protect it.';
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'No active goals here. Add only goals that can shrink on rough days.';
  }
  if (personalization.standupGoal) return `No active goals here. Anchor today's stated goal: ${personalization.standupGoal}`;
  return 'No active goals here. Add one goal so the agent has a durable anchor.';
}

function taskFitColor(fit?: 'high' | 'medium' | 'low') {
  if (fit === 'high') return '#22c55e';
  if (fit === 'low') return '#f59e0b';
  return '#667eea';
}

function taskFitBg(fit?: 'high' | 'medium' | 'low') {
  if (fit === 'high') return 'rgba(34,197,94,0.08)';
  if (fit === 'low') return 'rgba(245,158,11,0.08)';
  return 'rgba(102,126,234,0.1)';
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [alerts, setAlerts] = useState<{
    id: number;
    type: string;
    message: string;
    severity: string;
    created_at: string;
    feedback?: 'helpful' | 'not_helpful' | 'dismissed' | null;
    adaptive_reason?: string | null;
  }[]>([]);
  const [alertPolicy, setAlertPolicy] = useState<AlertCenterPolicy | null>(null);
  const [showAlerts, setShowAlerts] = useState(false);
  const [insights, setInsights] = useState<InsightsData | null>(null);
  const { session, start: startSession, end: endSession } = useGuardianSession();
  const focusSessions: FocusSessionHistory[] = []; // Legacy section hidden — guardian history is at /guardian
  const [liveFocusStats] = useState({ productiveSeconds: 0, distractionSeconds: 0 });
  const [taskCompletionNotice, setTaskCompletionNotice] = useState<string | null>(null);
  const [stateSaving, setStateSaving] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then(async response => {
        if (response.status === 401) {
          router.replace('/login?returnTo=/');
          return null;
        }
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(
            payload?.error === 'security_not_configured'
              ? 'LifeOS authentication is not configured on this server.'
              : 'LifeOS could not load your dashboard.',
          );
        }
        return response.json();
      })
      .then(d => {
        if (d) setData(d);
      })
      .catch(error => {
        setDashboardError(
          error instanceof Error ? error.message : 'LifeOS could not load your dashboard.',
        );
      })
      .finally(() => setLoading(false));
    fetch('/api/alerts')
      .then(r => r.json())
      .then(d => {
        setAlerts(d.alerts || []);
        setAlertPolicy(d.alertPolicy || null);
      })
      .catch(() => { });
    fetch('/api/guardian/insights')
      .then(r => r.json())
      .then(d => { if (!d.error) setInsights(d as InsightsData); })
      .catch(() => { });
  }, [router]);

  // Auto-end session when timer hits zero
  useEffect(() => {
    if (session.active && session.timeLeftSeconds === 0) {
      endSession().then(() => fetch('/api/dashboard').then(r => r.json()).then(d => setData(d)).catch(() => {}));
    }
  }, [session.active, session.timeLeftSeconds, endSession]);

  const startFocus = async (goalId: number | null, goalTitle: string | null, taskTitle: string | null, mins?: number) => {
    const durationMinutes = mins ?? data?.personalization?.recommendedSessionMinutes;
    await startSession({
      goalId: goalId ? String(goalId) : null,
      goalTitle,
      conceptNodeName: taskTitle || goalTitle || 'Focus Session',
      durationMinutes,
    });
  };

  const runDashboardPolicyAction = async () => {
    const policy = data?.intelligence?.dashboardPolicy;
    if (!policy) return;

    if (policy.focusTarget.type === 'task') {
      if (policy.focusTarget.id) {
        sendRecommendationFeedback(policy.focusTarget.id, 'started', `started from dashboard policy: ${policy.primaryAction}`);
      }
      await startFocus(null, null, policy.focusTarget.title, policy.sessionMinutes);
      return;
    }

    if (policy.focusTarget.type === 'planning') {
      router.push('/planner');
      return;
    }

    if (policy.focusTarget.type === 'habit') {
      router.push('/habits');
      return;
    }

    if (policy.focusTarget.type === 'review') {
      router.push('/guardian');
    }
  };

  const cancelFocus = async () => {
    await endSession();
    fetch('/api/dashboard').then(r => r.json()).then(d => setData(d)).catch(() => {});
  };

  const updateCapacityState = async (patch: Partial<Pick<DashboardPersonalization, 'energy' | 'mood'>>) => {
    setStateSaving(true);
    try {
      const res = await fetch('/api/dashboard/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return;
      const refreshed = await fetch('/api/dashboard').then(r => r.json());
      setData(refreshed);
    } finally {
      setStateSaving(false);
    }
  };

  const markAllRead = async () => {
    await fetch('/api/alerts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setAlerts([]);
    setShowAlerts(false);
  };

  const sendAlertFeedback = async (id: number, feedback: 'helpful' | 'not_helpful' | 'dismissed') => {
    setAlerts(prev => prev.map(alert => alert.id === id ? { ...alert, feedback } : alert));
    await fetch('/api/alerts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, feedback }),
    }).catch(() => {
      setAlerts(prev => prev.map(alert => alert.id === id ? { ...alert, feedback: null } : alert));
    });
  };

  const sendRecommendationFeedback = async (
    taskId: number,
    feedback: 'helpful' | 'not_now' | 'wrong' | 'started' | 'completed' | 'dismissed',
    reason?: string,
  ) => {
    await fetch('/api/dashboard/recommendation-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, feedback, reason, surface: 'dashboard' }),
    }).catch(() => { });
  };

  const completeRecommendedTask = async (taskId: number) => {
    setTaskCompletionNotice(null);
    const res = await fetch('/api/tasks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: taskId, status: 'done' })
    }).catch(() => null);
    if (!res?.ok) {
      const payload = await res?.json().catch(() => null);
      setTaskCompletionNotice(payload?.message || 'Task still needs linked focus time before it can complete.');
      return;
    }

    setData(prev => {
      if (!prev || !prev.intelligence) return prev;
      return {
        ...prev,
        intelligence: {
          ...prev.intelligence,
          recommendedTasks: prev.intelligence.recommendedTasks.filter(rt => rt.id !== taskId)
        }
      };
    });
    sendRecommendationFeedback(taskId, 'completed', 'completed from daily plan');
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
        <h2 className="text-2xl font-bold mb-2">
          {dashboardError ? 'Dashboard unavailable' : 'No day data available'}
        </h2>
        <p style={{ color: 'var(--text-secondary)' }}>
          {dashboardError || 'LifeOS returned no dashboard snapshot for today.'}
        </p>
      </div>
    );
  }

  const formatTime = (mins: number) => {
    const rounded = Math.max(0, Math.round(mins));
    if (rounded < 60) return `${rounded}m`;
    const hours = Math.floor(rounded / 60);
    const minutes = rounded % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  };
  const personalization = data?.personalization;
  const dashboardPolicy = data?.intelligence?.dashboardPolicy;
  const adaptiveFocusMinutes = dashboardPolicy?.sessionMinutes ?? personalization?.recommendedSessionMinutes ?? null;
  const adaptiveFocusMinutesRounded = adaptiveFocusMinutes ? Math.max(5, Math.round(adaptiveFocusMinutes)) : null;
  const focusTargetPrompt = focusTargetLabel(personalization, dashboardPolicy);
  const generalFocusLabel = generalFocusOptionLabel(personalization, dashboardPolicy);
  const emptyTasksText = dashboardTasksEmpty(personalization, dashboardPolicy);
  const emptyGoalsText = dashboardGoalsEmpty(personalization, dashboardPolicy);
  const selectedPolicyTarget = dashboardPolicy?.focusTarget.type === 'task' && dashboardPolicy.focusTarget.id
    ? `task-${dashboardPolicy.focusTarget.id}`
    : '';
  const durationOptions = adaptiveFocusMinutes
    ? Array.from(new Set(
      [
        adaptiveFocusMinutesRounded,
        adaptiveFocusMinutes,
        adaptiveFocusMinutes * 0.65,
        adaptiveFocusMinutes * 1.35,
        adaptiveFocusMinutes * 1.8,
      ]
        .filter((mins): mins is number => typeof mins === 'number' && mins > 0)
        .map(mins => Math.max(5, Math.round(mins / 5) * 5))
    )).sort((a, b) => a - b)
    : [];

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
              <label className="text-[11px]" style={{ color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>{focusTargetPrompt}</label>
	              <select
	                id="dashboard-focus-target"
	                defaultValue={selectedPolicyTarget}
	                style={{
                  width: '100%', padding: '8px 10px', background: 'rgba(255,255,255,0.04)',
                  border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px',
                  color: 'var(--text-primary)', fontSize: '13px',
                }}
              >
                <option value="">{generalFocusLabel}</option>
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
	                defaultValue={adaptiveFocusMinutesRounded ? String(adaptiveFocusMinutesRounded) : ''}
              >
                {!adaptiveFocusMinutesRounded && (
                  <option value="">Learning duration...</option>
                )}
                {durationOptions.map(mins => (
	                  <option key={mins} value={mins}>
	                    {mins === adaptiveFocusMinutesRounded ? `Adaptive (${formatTime(mins)})` : formatTime(mins)}
	                  </option>
	                ))}
              </select>
            </div>

            {/* Start button */}
            <button
              disabled={!adaptiveFocusMinutesRounded}
              onClick={() => {
                const targetEl = document.getElementById('dashboard-focus-target') as HTMLSelectElement;
                const durationEl = document.getElementById('dashboard-focus-duration') as HTMLSelectElement;
                const selected = targetEl?.value || '';
                const selectedOption = targetEl?.options[targetEl.selectedIndex];
                const mins = parseInt(durationEl?.value || '');
                if (!Number.isFinite(mins) || mins <= 0) {
                  alert('LifeOS is still learning a session length for this moment.');
                  return;
                }
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
                cursor: adaptiveFocusMinutesRounded ? 'pointer' : 'not-allowed',
                opacity: adaptiveFocusMinutesRounded ? 1 : 0.55,
                whiteSpace: 'nowrap',
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
              title={alertPolicy?.reason ?? 'Notifications'}
            >
              🔔
              {(alerts.length > 0 || (alertPolicy?.quietedCount ?? 0) > 0) && (
                <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full text-xs flex items-center justify-center font-bold"
                  style={{
                    background: alerts.length > 0 ? 'var(--accent-red)' : 'var(--text-muted)',
                    color: 'white',
                    fontSize: '0.65rem',
                  }}>
                  {alerts.length || alertPolicy?.quietedCount}
                </span>
              )}
            </button>
            {showAlerts && (
              <div className="absolute right-0 top-12 w-80 max-h-96 overflow-y-auto card z-50 shadow-2xl" style={{ padding: '0' }}>
                <div className="flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border)' }}>
                  <div>
                    <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Notifications</span>
                    {alertPolicy && (
                      <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {alertPolicy.summary}
                      </p>
                    )}
                  </div>
                  {alerts.length > 0 && <button onClick={markAllRead} className="text-xs" style={{ color: 'var(--accent-blue)' }}>Mark all read</button>}
                </div>
                {alertPolicy && alertPolicy.quietedCount > 0 && (
                  <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--border)', background: 'rgba(255,255,255,0.03)' }}>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {alertPolicy.learnedQuietedCount > 0
                        ? `${alertPolicy.learnedQuietedCount} alert${alertPolicy.learnedQuietedCount === 1 ? '' : 's'} hidden because your feedback said this kind is not useful right now.`
                        : `${alertPolicy.quietedCount} lower-priority alert${alertPolicy.quietedCount === 1 ? '' : 's'} quieted.`}
                      {' '}
                      {alertPolicy.reason}
                    </p>
                  </div>
                )}
                {alerts.length > 0 ? alerts.slice(0, 10).map(a => (
                  <div key={a.id} className="px-3 py-2 border-b text-sm" style={{ borderColor: 'var(--border)' }}>
                    <div className="flex items-start gap-2">
                      <span>{a.severity === 'urgent' ? '🚨' : a.severity === 'warning' ? '⚠️' : 'ℹ️'}</span>
                      <div>
                        <p style={{ color: 'var(--text-primary)', fontSize: '0.8rem' }}>{a.message}</p>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          {new Date(a.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                        </p>
                        {a.adaptive_reason && (
                          <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)', lineHeight: 1.35 }}>
                            Why now: {a.adaptive_reason}
                          </p>
                        )}
                        <div className="flex items-center gap-1 mt-2">
                          {a.feedback ? (
                            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                              learned: {a.feedback.replace('_', ' ')}
                            </span>
                          ) : (
                            <>
                              <button
                                onClick={() => sendAlertFeedback(a.id, 'helpful')}
                                className="text-[10px] px-2 py-0.5 rounded"
                                style={{ background: 'rgba(34,197,94,0.12)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.2)' }}
                              >
                                useful
                              </button>
                              <button
                                onClick={() => sendAlertFeedback(a.id, 'not_helpful')}
                                className="text-[10px] px-2 py-0.5 rounded"
                                style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.18)' }}
                              >
                                off
                              </button>
                              <button
                                onClick={() => sendAlertFeedback(a.id, 'dismissed')}
                                className="text-[10px] px-2 py-0.5 rounded"
                                style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)', border: '1px solid rgba(255,255,255,0.08)' }}
                              >
                                later
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )) : (
                  <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>
                    {formatNotificationEmpty(personalization, alertPolicy)}
                  </p>
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

	      {personalization && (
	        <div className="card" style={{
	          borderColor: `${modeAccents[personalization.mode]}55`,
	          background: `linear-gradient(135deg, ${modeAccents[personalization.mode]}12, rgba(255,255,255,0.015))`,
	        }}>
	          <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr_1fr] gap-4">
	            <div>
	              <p className="text-xs font-semibold mb-2" style={{
                color: modeAccents[personalization.mode],
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
	              }}>Today Mode</p>
	              <div className="flex items-center gap-3 flex-wrap">
	                <h2 className="text-xl font-bold">{dashboardPolicy?.headline ?? modeLabels[personalization.mode]}</h2>
	                <span className="text-xs px-2 py-1 rounded-md" style={{
	                  background: `${modeAccents[personalization.mode]}1f`,
                  color: modeAccents[personalization.mode],
                  border: `1px solid ${modeAccents[personalization.mode]}44`,
	                }}>{personalization.energy} energy{personalization.mood ? ` · ${personalization.mood} mood` : ''}</span>
	              </div>
	              <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {personalization.energySource === 'explicit_checkin' ? 'Energy logged by you' : 'Energy baseline'} · {personalization.moodSource === 'explicit_checkin' ? 'Mood logged by you' : 'Mood not logged'}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Set now:</span>
                  {(['low', 'medium', 'high'] as const).map(value => (
                    <button
                      key={`energy-${value}`}
                      type="button"
                      className="btn btn-sm"
                      disabled={stateSaving || (personalization.energy === value && personalization.energySource === 'explicit_checkin')}
                      onClick={() => updateCapacityState({ energy: value })}
                      style={{ fontSize: 11, padding: '3px 8px' }}
                    >
                      {value} energy
                    </button>
                  ))}
                  {(['low', 'medium', 'high'] as const).map(value => (
                    <button
                      key={`mood-${value}`}
                      type="button"
                      className="btn btn-sm"
                      disabled={stateSaving || (personalization.mood === value && personalization.moodSource === 'explicit_checkin')}
                      onClick={() => updateCapacityState({ mood: value })}
                      style={{ fontSize: 11, padding: '3px 8px' }}
                    >
                      {value} mood
                    </button>
                  ))}
	              </div>
	              <p className="text-sm mt-2 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
	                {dashboardPolicy?.primaryReason ?? formatAdaptiveSignal(personalization)}
	              </p>
	              {dashboardPolicy && !session.active && (
	                <div className="flex items-center gap-2 mt-3 flex-wrap">
	                  <button
	                    onClick={runDashboardPolicyAction}
	                    className="btn btn-sm btn-primary"
	                    style={{ background: modeAccents[dashboardPolicy.mode], borderColor: `${modeAccents[dashboardPolicy.mode]}66` }}
	                  >
	                    {dashboardPolicy.primaryLabel}
	                  </button>
	                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
	                    {dashboardPolicy.sessionReason}
	                  </span>
	                </div>
	              )}
	              {personalization.narrative && (
	                <p className="text-xs mt-2 line-clamp-2" style={{ color: 'var(--text-muted)' }}>
                  {personalization.narrative}
                </p>
              )}
            </div>

	            <div>
	              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>
                  Adaptive Defaults
                  {personalization.learningPhase && (
                    <span className="ml-2 font-normal" style={{ color: 'var(--text-muted)' }}>(learning)</span>
                  )}
                </p>
	              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
	                  <span style={{ color: 'var(--text-muted)' }}>Focus sprint</span>
	                  <strong>
                      {formatDurationLabel(dashboardPolicy?.sessionMinutes ?? personalization.recommendedSessionMinutes)}
                      {personalization.learningPhase ? (
                        <span className="font-normal ml-1" style={{ color: 'var(--text-muted)' }}>default</span>
                      ) : null}
                    </strong>
	                </div>
                <div className="flex items-center justify-between gap-3">
                  <span style={{ color: 'var(--text-muted)' }}>Best window</span>
                  <strong className="text-right">
                    {personalization.learningPhase || !personalization.nextBestFocusWindow
                      ? 'learning — no session data yet'
                      : personalization.nextBestFocusWindow}
                  </strong>
                </div>
                <div className="flex items-center justify-between gap-3">
	                  <span style={{ color: 'var(--text-muted)' }}>Coaching</span>
	                  <strong>
                      {personalization.learningPhase
                        ? 'balanced (learning)'
                        : personalization.coachingStyle}
                    </strong>
	                </div>
	                {dashboardPolicy && (
	                  <div className="flex items-center justify-between gap-3">
	                    <span style={{ color: 'var(--text-muted)' }}>Notifications</span>
	                    <strong>{dashboardPolicy.notificationPosture.replace('_', ' ')}</strong>
	                  </div>
	                )}
	              </div>
                {personalization.learningPhase && personalization.learningPhaseReason && (
                  <p className="text-[11px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    {personalization.learningPhaseReason}
                  </p>
                )}
	            </div>

            <div>
              <p className="text-xs font-semibold mb-2" style={{ color: 'var(--text-secondary)' }}>What It Knows Now</p>
              <div className="flex flex-wrap gap-2">
                <span className="badge badge-blue">{personalization.openTasks} open</span>
                {personalization.overdueTasks > 0 && <span className="badge badge-red">{personalization.overdueTasks} overdue</span>}
                {personalization.uncheckedHabits.length > 0 && <span className="badge badge-yellow">{personalization.uncheckedHabits.length} habits left</span>}
                {personalization.calendarEvents.length > 0 && <span className="badge badge-green">{personalization.calendarEvents.length} calendar</span>}
                {personalization.plannedFocus.plannedToday > 0 && (
                  <span className="badge badge-blue">
                    focus {personalization.plannedFocus.completedToday}/{personalization.plannedFocus.plannedToday}
                  </span>
                )}
                <span className="badge" style={{
                  background: personalization.alertFatigueLevel === 'high' ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.05)',
                  color: personalization.alertFatigueLevel === 'high' ? '#ef4444' : 'var(--text-secondary)',
                }}>alerts {personalization.alertFatigueLevel}</span>
              </div>
	              <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
	                {personalization.plannedFocus.nextTitle
                    ? `Next planned focus: ${personalization.plannedFocus.nextTitle}${personalization.plannedFocus.nextMinutes ? ` (${personalization.plannedFocus.nextMinutes}m)` : ''}. ${dashboardPolicy?.notificationReason ?? `Feedback loop: ${formatHelpfulRate(personalization.helpfulRate)} · ${personalization.corrections30d} corrections in 30d`}`
                    : dashboardPolicy?.notificationReason ?? `Feedback loop: ${formatHelpfulRate(personalization.helpfulRate)} · ${personalization.corrections30d} corrections in 30d`}
	              </p>
	            </div>
          </div>
        </div>
      )}

      {/* Top Row: Score + Level + Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Accountability Score */}
        <div className="stat-card purple flex items-center gap-5">
          <ScoreRing score={today.score} size={100} />
          <div>
            <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>Accountability</p>
            <p className="text-2xl font-bold">{today.score}/100</p>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {(() => { const t = classifyScore(today.score); return t === 'excellent' ? 'Outstanding!' : t === 'good' ? 'Good going' : t === 'neutral' ? 'Room to improve' : 'Needs attention'; })()}
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
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{formatActivityEmpty(personalization, 'domains')}</p>
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

      {/* UIL Coaching Card — live insights from the intelligence profile */}
      {insights && (insights.profile.coachingInsights.length > 0 || insights.profile.nextBestFocusWindow) && (
        <div className="card" style={{
          borderColor: 'rgba(245,158,11,0.25)',
          background: 'linear-gradient(135deg, rgba(245,158,11,0.04), rgba(234,179,8,0.02))',
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
            {/* Left: label + trend */}
            <div style={{ flexShrink: 0, paddingTop: '2px' }}>
              <p className="text-xs font-semibold" style={{
                color: 'rgba(245,158,11,0.8)', letterSpacing: '0.06em', textTransform: 'uppercase',
              }}>Intelligence</p>
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' }}>
                {insights.profile.focusTrend && (
                  <span style={{
                    fontSize: '10px', padding: '2px 8px', borderRadius: '12px',
                    background: 'rgba(245,158,11,0.1)', color: '#f59e0b',
                    border: '1px solid rgba(245,158,11,0.2)',
                  }}>Trend: {insights.profile.focusTrend}</span>
                )}
                {insights.profile.preferredCoachingStyle && (
                  <span style={{
                    fontSize: '10px', padding: '2px 8px', borderRadius: '12px',
                    background: 'rgba(245,158,11,0.08)', color: '#d97706',
                    border: '1px solid rgba(245,158,11,0.15)',
                  }}>{insights.profile.preferredCoachingStyle}</span>
                )}
                {insights.habits.completionRate !== null && (
                  <span style={{
                    fontSize: '10px', padding: '2px 8px', borderRadius: '12px',
                    background: scoreBadgeBg(insights.habits.completionRate),
                    color: scoreBadgeText(insights.habits.completionRate),
                    border: `1px solid ${scoreBadgeBorder(insights.habits.completionRate)}`,
                  }}>Habits {insights.habits.completionRate}%</span>
                )}
              </div>
            </div>

            {/* Divider */}
            <div style={{ width: '1px', alignSelf: 'stretch', background: 'rgba(245,158,11,0.15)', flexShrink: 0 }} />

            {/* Right: insights + window */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {insights.profile.coachingInsights.slice(0, 2).map((ins, i) => (
                <p key={i} className="text-sm" style={{
                  color: i === 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
                  marginBottom: i === 0 && insights.profile.coachingInsights.length > 1 ? '6px' : '0',
                  lineHeight: '1.5',
                }}>{ins}</p>
              ))}
              {!session.active && insights.profile.nextBestFocusWindow && (
                <p className="text-xs mt-2" style={{ color: 'rgba(245,158,11,0.7)' }}>
                  Best focus window today: <strong style={{ color: '#f59e0b' }}>{insights.profile.nextBestFocusWindow}</strong>
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {data?.intelligence && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Daily Plan */}
          <div className="card" style={{ borderColor: 'rgba(102, 126, 234, 0.4)', background: 'linear-gradient(to bottom, rgba(102,126,234,0.05), transparent)' }}>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <span>📋</span> Daily Plan (AI Curated)
            </h3>
            {taskCompletionNotice && (
              <div className="text-xs mb-2 px-2 py-1 rounded" style={{ color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.18)' }}>
                {taskCompletionNotice}
              </div>
            )}
            <div className="space-y-2">
              {data.intelligence.recommendedTasks.length > 0 ? data.intelligence.recommendedTasks.slice(0, 3).map(t => (
                <div key={t.id} className="flex items-start gap-3 py-2 group">
                  <button
                    onClick={() => void completeRecommendedTask(t.id)}
                    title={t.timeProgress?.targetMinutes
                      ? `Complete when linked focus reaches ${t.timeProgress.targetMinutes} minutes`
                      : 'Add a time target before this task can complete'}
                    className="w-5 h-5 rounded-full mt-0.5 border-2 flex-shrink-0 border-slate-500 hover:border-green-500 hover:bg-green-500/10 transition-colors"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <p className="text-sm font-medium truncate">{t.title}</p>
                      {t.momentFit && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0" style={{
                          color: taskFitColor(t.momentFit),
                          border: `1px solid ${taskFitColor(t.momentFit)}44`,
                          background: taskFitBg(t.momentFit),
                        }}>{t.momentFit} fit</span>
                      )}
                    </div>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{t.reason}</p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {t.timeProgress?.targetMinutes ? (
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                          {t.timeProgress.creditedMinutes}/{t.timeProgress.targetMinutes}m linked
                        </span>
                      ) : t.estimatedMinutes ? (
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{t.estimatedMinutes}m target</span>
                      ) : null}
                      {t.energyRequired ? (
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{t.energyRequired} energy</span>
                      ) : null}
                      {t.feedbackHint ? (
                        <span className="text-[10px]" style={{ color: 'var(--accent-orange)' }}>{t.feedbackHint}</span>
                      ) : null}
                    </div>
                    {t.timeProgress?.targetMinutes ? (
                      <div className="mt-2">
                        <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                          <div
                            className="h-full"
                            style={{
                              width: `${t.timeProgress.percent ?? 0}%`,
                              background: taskFitColor(t.momentFit ?? 'medium'),
                            }}
                          />
                        </div>
                        <p className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
                          {t.timeProgress.remainingMinutes === 0
                            ? 'Time target reached. Completing will tick it off.'
                            : `${t.timeProgress.remainingMinutes ?? t.timeProgress.targetMinutes}m more linked focus before it completes.`}
                        </p>
                      </div>
                    ) : null}
                    <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => sendRecommendationFeedback(t.id, 'helpful', 'user marked daily plan task as a good pick')}
                        className="text-[10px] px-2 py-0.5 rounded"
                        style={{ background: 'rgba(34,197,94,0.1)', color: '#22c55e', border: '1px solid rgba(34,197,94,0.18)' }}
                      >
                        good pick
                      </button>
                      <button
                        onClick={() => {
                          sendRecommendationFeedback(t.id, 'not_now', 'user rejected daily plan timing');
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
                        }}
                        className="text-[10px] px-2 py-0.5 rounded"
                        style={{ background: 'rgba(245,158,11,0.1)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.18)' }}
                      >
                        not now
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="badge text-xs flex-shrink-0" style={{
                      background: t.priority === 'critical' ? 'rgba(255,85,85,0.15)' : t.priority === 'high' ? 'rgba(255,165,0,0.15)' : 'rgba(102,126,234,0.15)',
                      color: t.priority === 'critical' ? 'var(--accent-red)' : t.priority === 'high' ? 'var(--accent-orange)' : 'var(--accent-blue)',
                    }}>{t.priority}</span>
                    <button
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-2 py-0.5 rounded cursor-pointer"
                      style={{ background: 'var(--accent-purple)', color: 'white' }}
                      onClick={() => {
                        sendRecommendationFeedback(t.id, 'started', 'started focus from daily plan');
                        startFocus(null, null, t.title);
                      }}
                      disabled={session.active}
                    >
                      ⏱️ Focus
                    </button>
                  </div>
                </div>
              )) : (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{emptyTasksText}</p>
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
                      color: progressColor(g.progress)
                    }}>{g.progress}%</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                    <div className="h-full rounded-full transition-all" style={{
                      width: `${g.progress}%`,
                      background: progressColor(g.progress)
                    }} />
                  </div>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {g.done_tasks}/{g.total_tasks} tasks {g.deadline && `· due ${new Date(g.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                  </p>
                </div>
              )) : (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>{emptyGoalsText}</p>
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
                  color: cognitiveLoadColor(data.intelligence.cognitiveLoad.status as 'clear' | 'moderate' | 'overloaded')
                }}>
                  {data.intelligence.cognitiveLoad.mentalBandwidth}%
                </span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-secondary)' }}>
                <div className="h-full rounded-full" style={{
                  width: `${data.intelligence.cognitiveLoad.mentalBandwidth}%`,
                  background: cognitiveLoadColor(data.intelligence.cognitiveLoad.status as 'clear' | 'moderate' | 'overloaded')
                }} />
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {data.intelligence.cognitiveLoad.openTaskCount} open tasks · {data.intelligence.cognitiveLoad.status === 'overloaded' ? 'Consider deferring some' : data.intelligence.cognitiveLoad.status === 'moderate' ? 'Manageable load' : 'Clear headspace'}
              </p>
              <div className="flex items-center justify-between pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
                <span className="text-sm">Self-Efficacy</span>
                <span className="text-sm font-bold" style={{
                  color: scoreColor(data.intelligence.efficacyMode.rate)
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
            {focusSessions.slice(0, 5).map((s, i) => {
              const duration = s.actual_duration_seconds ? Math.round(s.actual_duration_seconds / 60) : (s.duration_minutes || 0);
              const productiveSeconds = s.productive_seconds ?? 0;
              const distractionSeconds = s.distraction_seconds ?? 0;
              const neutralSeconds = s.neutral_seconds ?? 0;
              const tabsBlocked = s.tabs_blocked ?? 0;
              const tabsOverridden = s.tabs_overridden ?? 0;
              const prodMin = productiveSeconds ? Math.round(productiveSeconds / 60) : 0;
              const distMin = distractionSeconds ? Math.round(distractionSeconds / 60) : 0;
              const neutMin = neutralSeconds ? Math.round(neutralSeconds / 60) : 0;
              const totalSecs = productiveSeconds + distractionSeconds + neutralSeconds;
              const prodPct = totalSecs > 0 ? Math.round((productiveSeconds / totalSecs) * 100) : 0;
              const distPct = totalSecs > 0 ? Math.round((distractionSeconds / totalSecs) * 100) : 0;
              const neutPct = totalSecs > 0 ? Math.round((neutralSeconds / totalSecs) * 100) : 0;
              const score = s.ai_report ? (() => { try { return JSON.parse(s.ai_report)?.score; } catch { return null; } })() : null;
              const startTime = s.started_at ? new Date(s.started_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
              const endTime = s.ended_at ? new Date(s.ended_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
              const dateStr = s.started_at ? new Date(s.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
              const topDomains: Array<string | SessionDomainSummary> = s.top_domains ? (() => {
                try {
                  const parsed: unknown = JSON.parse(s.top_domains);
                  return Array.isArray(parsed) ? parsed as Array<string | SessionDomainSummary> : [];
                } catch {
                  return [];
                }
              })() : [];

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
                          background: scoreBadgeBg(score), color: scoreColor(score),
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
                    {(tabsBlocked > 0 || tabsOverridden > 0) && (
                      <>
                        {tabsBlocked > 0 && <span>🛑 {tabsBlocked} blocked</span>}
                        {tabsOverridden > 0 && <span>⚠️ {tabsOverridden} overrides</span>}
                      </>
                    )}
                    {topDomains.length > 0 && (
                      <span className="truncate">
                        🌐 {topDomains.slice(0, 3).map(d => typeof d === 'string' ? d : d.domain).filter(Boolean).join(', ')}
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
              {formatActivityEmpty(personalization, 'timeline')}
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
