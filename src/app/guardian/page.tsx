'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import GuardianDashboard from '@/components/GuardianDashboard';
import { useGuardianSession } from '@/hooks/useGuardianSession';
import { scoreColor } from '@/lib/score-classify';

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
  personalization?: GuardianInsights['personalization'];
  adaptiveTasks?: GuardianInsights['recommendedTasks'];
}

interface GuardianInsights {
  personalization?: {
    mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
    guidance: string;
    recommendedSessionMinutes: number;
    energy: 'high' | 'medium' | 'low';
    mood: 'high' | 'medium' | 'low' | null;
    standupGoal: string | null;
    alertFatigueLevel: 'low' | 'medium' | 'high';
    recentAlerts: number;
    nextBestFocusWindow: string;
    plannedFocus?: {
      plannedToday: number;
      completedToday: number;
      skippedToday: number;
      nextTitle: string | null;
      nextMinutes: number | null;
      recentFollowThroughRate: number | null;
    };
  };
  recommendedTasks?: Array<{
    id: number;
    title: string;
    priority: string;
    score: number;
    reason: string;
    momentFit: 'high' | 'medium' | 'low';
    estimatedMinutes: number | null;
    energyRequired: 'low' | 'medium' | 'high' | null;
  }>;
}

interface GuardianCandidateTask {
  id: number;
  title: string;
  priority: string;
  status: string;
  task_type: string;
  course: string | null;
  goal_title: string | null;
  energy_required: string;
  estimated_minutes: number;
  credited_minutes: number;
  remaining_minutes: number;
  score: number;
  reason: string;
}

interface GuardianPlannedSession {
  id: string;
  task_id: number | null;
  title: string;
  planned_start: string;
  planned_end: string;
  duration_minutes: number;
  session_type: string;
  rule_json: string;
  reward_xp: number;
  reward_coins: number;
  calendar_status: 'not_configured' | 'created' | 'synced' | 'failed' | 'deleted';
  status: 'planned' | 'started' | 'completed' | 'skipped' | 'cancelled';
}

interface GuardianNextDayPlan {
  success: boolean;
  plan: {
    id: number;
    plan_date: string;
    sleep_time: string | null;
    wake_estimate: string | null;
    mood: string | null;
    energy: string | null;
    evening_notes: string | null;
    tomorrow_intention: string | null;
    generated_summary: string | null;
    status: 'draft' | 'active' | 'archived';
  } | null;
  sessions: GuardianPlannedSession[];
  candidateTasks: GuardianCandidateTask[];
  personalization: {
    mode: string;
    energy: 'high' | 'medium' | 'low';
    mood: 'high' | 'medium' | 'low' | null;
    learnedSprintMinutes: number;
    bestFocusWindow: string;
  };
  suggestedInputs: {
    sleepTime: string;
    wakeEstimate: string;
    mood: 'high' | 'medium' | 'low';
    energy: 'high' | 'medium' | 'low';
    source: 'existing_plan' | 'latest_evening_checkin' | 'sleep_history' | 'adaptive_baseline';
    reason: string;
  };
  calendarConfigured: boolean;
}

interface SessionRulePreview {
  mode?: string;
  guidance?: string;
  tools?: string[];
  breakMinutes?: number;
  rewardReason?: string;
}

interface PendingReviewSession {
  session_id: string;
  task_title: string | null;
  target_title: string | null;
  elapsed_minutes: number | null;
  average_focus_score: number | null;
  mood: string | null;
}

const QUALITY_COLOR: Record<string, string> = {
  excellent: '#22c55e',
  good: '#3b82f6',
  neutral: '#8888a0',
  poor: '#ef4444',
};

const MODE_LABEL: Record<NonNullable<GuardianInsights['personalization']>['mode'], string> = {
  protect_focus: 'Protect focus',
  deadline_pressure: 'Deadline pressure',
  recovery: 'Recovery',
  planning: 'Planning',
  normal: 'Balanced',
};

function formatDuration(mins: number) {
  const rounded = Math.max(0, Math.round(mins));
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function tomorrowIso() {
  const d = new Date(Date.now() + 19800000);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function formatPlanClock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function parseSessionRule(ruleJson: string): SessionRulePreview {
  try {
    const parsed = JSON.parse(ruleJson);
    return typeof parsed === 'object' && parsed ? parsed as SessionRulePreview : {};
  } catch {
    return {};
  }
}

type AdaptiveTask = NonNullable<GuardianInsights['recommendedTasks']>[number];

interface DurationOption {
  minutes: number;
  label: string;
}

function addDurationOption(options: DurationOption[], minutes: number | null | undefined, label: string) {
  if (!minutes || minutes <= 0) return;
  const rounded = Math.max(5, Math.round(minutes / 5) * 5);
  if (options.some(option => option.minutes === rounded)) return;
  options.push({ minutes: rounded, label });
}

function formatPlannedFocusLabel(plannedFocus: NonNullable<GuardianInsights['personalization']>['plannedFocus']) {
  if (!plannedFocus?.nextTitle) return null;
  return `${plannedFocus.nextTitle}${plannedFocus.nextMinutes ? ` (${formatDuration(plannedFocus.nextMinutes)})` : ''}`;
}

function buildGuardianDurationOptions(input: {
  adaptiveDuration: number;
  personalization?: GuardianInsights['personalization'];
  selectedTask?: AdaptiveTask | null;
  topTask?: AdaptiveTask | null;
}): DurationOption[] {
  const options: DurationOption[] = [];
  const mode = input.personalization?.mode ?? 'normal';
  const base = Math.round(input.adaptiveDuration);

  addDurationOption(options, input.selectedTask?.estimatedMinutes, 'This task');
  addDurationOption(options, input.personalization?.plannedFocus?.nextMinutes, 'Next planned');
  addDurationOption(options, base, mode === 'recovery' ? 'Recovery default' : mode === 'deadline_pressure' ? 'Pressure default' : 'Today default');

  if (mode === 'recovery' || input.personalization?.energy === 'low' || input.personalization?.mood === 'low') {
    addDurationOption(options, Math.min(base, 20), 'Small start');
    addDurationOption(options, Math.min(Math.max(base, 25), 35), 'Manageable');
  } else if (mode === 'deadline_pressure') {
    addDurationOption(options, Math.max(base, 45), 'Serious sprint');
    addDurationOption(options, Math.max(base, 75), 'Deep push');
  } else if (mode === 'planning') {
    addDurationOption(options, Math.min(base, 30), 'Planning pass');
    addDurationOption(options, Math.max(base, 45), 'Setup block');
  } else {
    addDurationOption(options, Math.max(25, base - 15), 'Shorter');
    addDurationOption(options, Math.min(120, base + 15), 'Deeper');
  }

  addDurationOption(options, input.topTask?.estimatedMinutes, 'Top recommendation');
  return options.slice(0, 5);
}

function guardianTopicPlaceholder(personalization?: GuardianInsights['personalization']) {
  if (!personalization) return 'What are you working on?';
  const planned = formatPlannedFocusLabel(personalization.plannedFocus);
  if (planned) {
    return `Start planned focus: ${planned}`;
  }
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'What is the smallest useful session?';
  }
  if (personalization.mode === 'deadline_pressure') {
    return 'What deadline are we relieving right now?';
  }
  if (personalization.mode === 'planning') {
    return 'What should be set up or reviewed?';
  }
  if (personalization.mode === 'protect_focus') {
    return 'What focus thread are we protecting?';
  }
  return 'What should move forward now?';
}

function guardianSessionContextPlaceholder(personalization?: GuardianInsights['personalization']) {
  if (!personalization) {
    return 'Add useful context: allowed tabs, resources, constraints, or what switching is intentional.';
  }

  const plannedTitle = personalization.plannedFocus?.nextTitle;
  if (plannedTitle) {
    return `Context for ${plannedTitle}: resources you expect to use, acceptable tab switches, blockers, or what done means.`;
  }
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'Low-energy context: smallest acceptable outcome, friction to avoid, and anything that should not trigger a warning.';
  }
  if (personalization.mode === 'deadline_pressure') {
    return 'Deadline context: deliverable, allowed research paths, risky distractions, and the next proof of progress.';
  }
  if (personalization.mode === 'planning') {
    return 'Planning context: tomorrow constraints, calendar anchors, dependencies, and where the first block should begin.';
  }
  if (personalization.mode === 'protect_focus') {
    return 'Focus context: current thread, allowed tools, and what would count as drift.';
  }
  if (personalization.nextBestFocusWindow) {
    return `Context for your ${personalization.nextBestFocusWindow} focus window: materials, constraints, and success criteria.`;
  }
  return 'Add useful context: allowed tabs, resources, constraints, or what switching is intentional.';
}

function buildGuardianOpeningMessage(input: {
  active: boolean;
  briefing?: DayBriefing | null;
  personalization?: GuardianInsights['personalization'];
}) {
  if (input.active) return 'Session Active';
  if (input.briefing?.openingMessage) return input.briefing.openingMessage;

  const personalization = input.personalization;
  const planned = formatPlannedFocusLabel(personalization?.plannedFocus);
  if (planned) return `Next planned focus: ${planned}`;
  if (!personalization) return 'Learning your day before suggesting the next move.';
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return `Low-energy day. Start with ${formatDuration(personalization.recommendedSessionMinutes)} of useful progress.`;
  }
  if (personalization.mode === 'deadline_pressure') {
    return `Deadline pressure. Use ${personalization.nextBestFocusWindow} for the highest-relief block.`;
  }
  if (personalization.mode === 'planning') {
    return 'Planning mode. Shape tomorrow before adding more pressure.';
  }
  if (personalization.mode === 'protect_focus') {
    return `Protect focus around ${personalization.nextBestFocusWindow}.`;
  }
  return `Best next focus window: ${personalization.nextBestFocusWindow}.`;
}

function formatNextDayMode(mode?: string) {
  if (mode === 'recovery') return 'recovery mode';
  if (mode === 'deadline_pressure') return 'deadline-pressure mode';
  if (mode === 'planning') return 'planning mode';
  if (mode === 'protect_focus') return 'focus-protection mode';
  return 'balanced mode';
}

function buildNextDayPlanEmptyMessage(plan: GuardianNextDayPlan | null): string {
  if (!plan) return 'Loading tomorrow context from check-ins, sleep history, and learned focus windows.';

  const sourceLabel = plan.suggestedInputs.source.replace(/_/g, ' ');
  const mode = formatNextDayMode(plan.personalization.mode);
  const sleepWindow = `${plan.suggestedInputs.sleepTime}-${plan.suggestedInputs.wakeEstimate}`;

  if (plan.personalization.mode === 'recovery' || plan.personalization.energy === 'low' || plan.personalization.mood === 'low') {
    return `No plan yet. ${sourceLabel} suggests ${sleepWindow}; add tomorrow's must-do so sessions start lighter in ${mode}.`;
  }

  if (plan.personalization.mode === 'deadline_pressure') {
    return `No plan yet. Add tomorrow's deadline target and regenerate so the first blocks protect the highest-pressure work.`;
  }

  return `No plan yet. ${plan.suggestedInputs.reason} Add tomorrow's intention and regenerate adaptive focus sessions.`;
}

function buildNoSessionsMessage(plan: GuardianNextDayPlan): string {
  if (plan.plan?.tomorrow_intention) {
    return `Plan captured "${plan.plan.tomorrow_intention}", but no focus blocks were scheduled. Add duration or task detail, then regenerate.`;
  }

  if (!plan.calendarConfigured) {
    return 'Plan exists, but no focus blocks were scheduled. Connect calendar or add fixed constraints before regenerating.';
  }

  return `Plan exists, but no focus blocks were scheduled. Add what matters tomorrow; ${formatNextDayMode(plan.personalization.mode)} needs clearer targets.`;
}

function buildSessionFeedbackPlaceholder(
  session: PendingReviewSession,
  personalization?: GuardianInsights['personalization'],
) {
  const score = session.average_focus_score;
  const duration = session.elapsed_minutes;

  if (score !== null && score !== undefined && score < 55) {
    return 'What pulled focus down: wrong time, wrong length, low energy, unclear task, or distracting tools?';
  }

  if (score !== null && score !== undefined && score >= 80) {
    return 'What made this work well: time of day, session length, task type, mood, or environment?';
  }

  if (personalization?.mode === 'recovery' || personalization?.energy === 'low' || personalization?.mood === 'low' || session.mood === 'low') {
    return 'Was this too much for your energy today, or did the smaller version fit?';
  }

  if (personalization?.mode === 'deadline_pressure') {
    return 'Did this reduce deadline pressure? What exact next block should follow?';
  }

  if (personalization?.mode === 'planning') {
    return 'Did this make tomorrow clearer? What should the next planned block inherit?';
  }

  if (duration !== null && duration !== undefined && personalization?.recommendedSessionMinutes) {
    return `Did ${duration}m feel better or worse than your ${personalization.recommendedSessionMinutes}m learned default?`;
  }

  return 'How did the session feel? Mention energy, distractions, length, and what should change next time.';
}

function buildCalibrationEmptyMessage(personalization?: GuardianInsights['personalization']) {
  if (!personalization) return 'No calibration yet. Submit session feedback to tune timing, energy, and intervention strength.';
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'No calibration yet. The next useful feedback is whether session length matched today’s lower energy.';
  }
  if (personalization.mode === 'deadline_pressure') {
    return 'No calibration yet. The next useful feedback is whether a session reduced deadline pressure.';
  }
  if (personalization.mode === 'planning') {
    return 'No calibration yet. The next useful feedback is what tomorrow’s plan should inherit or avoid.';
  }
  if (personalization.plannedFocus?.nextTitle) {
    return `No calibration yet. After "${personalization.plannedFocus.nextTitle}", report length, energy, and follow-through.`;
  }
  return 'No calibration yet. Submit session feedback to tune timing, energy, and intervention strength.';
}

function buildOptimizerEmptyMessage(personalization?: GuardianInsights['personalization']) {
  if (!personalization) return 'No active policy yet. Run the optimizer after a few reviewed sessions to generate a baseline.';
  if (personalization.mode === 'recovery' || personalization.energy === 'low' || personalization.mood === 'low') {
    return 'No active policy yet. Generate a baseline that stays gentle on low-capacity days.';
  }
  if (personalization.mode === 'deadline_pressure') {
    return 'No active policy yet. Generate a baseline that escalates only when deadline work is at risk.';
  }
  if (personalization.mode === 'protect_focus') {
    return 'No active policy yet. Generate a baseline that protects strong focus and quiets low-value nudges.';
  }
  if (personalization.alertFatigueLevel === 'high') {
    return 'No active policy yet. Generate a baseline with stricter alert fatigue limits.';
  }
  return `No active policy yet. Generate a ${MODE_LABEL[personalization.mode].toLowerCase()} baseline from recent sessions.`;
}

export default function GuardianPage() {
  const { session: activeSession, adaptiveDefaults, start: startGuardianSession, end: endGuardianSession } = useGuardianSession();
  const [briefing, setBriefing] = useState<DayBriefing | null>(null);
  const [insights, setInsights] = useState<GuardianInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [topic, setTopic] = useState('');
  const [duration, setDuration] = useState(() => adaptiveDefaults.recommendedSessionMinutes);
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<number | null>(null);
  const [mood, setMood] = useState<'high' | 'medium' | 'low' | ''>('');
  const [sessionContext, setSessionContext] = useState('');
  const [showContext, setShowContext] = useState(false);
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
    pendingCompletions: Array<{
      id: number; session_id: string; task_id: number | null;
      task_title: string | null; target_title: string | null;
      average_focus_score: number | null; elapsed_minutes: number | null;
      mood: string | null; session_completed_at: string | null;
    }>;
  } | null>(null);
  const [suggestedTasks, setSuggestedTasks] = useState<Array<{
    id: number; title: string; status: string; priority: string;
    energy_required: string; goal_title: string | null; goal_health: string | null;
    score: number; reason: string;
  }>>([]);
  const [weakConcepts, setWeakConcepts] = useState<Array<{
    id: number; title: string; mastery: number; goalTitle: string | null;
  }>>([]);
  const [nextDayPlan, setNextDayPlan] = useState<GuardianNextDayPlan | null>(null);
  const [nextDayPlanLoading, setNextDayPlanLoading] = useState(false);
  const [feedbackText, setFeedbackText] = useState<Record<string, string>>({});
  const [feedbackSubmitting, setFeedbackSubmitting] = useState<Record<string, boolean>>({});
  const [feedbackDone, setFeedbackDone] = useState<Record<string, boolean>>({});
  const [completionActionNotice, setCompletionActionNotice] = useState<Record<number, string>>({});
  const [calibrationStatus, setCalibrationStatus] = useState<{
    accuracy: number | null;
    sessions_count: number;
    recent_adjustments: Array<{
      component: string;
      previous_value: number;
      new_value: number;
      reason: string;
      applied_at: string;
    }>;
  } | null>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const adaptivePersonalization = insights?.personalization ?? briefing?.personalization;
  const plannedFocus = adaptivePersonalization?.plannedFocus;
  const plannedFocusLabel = formatPlannedFocusLabel(plannedFocus);
  const adaptiveDuration = plannedFocus?.nextMinutes ?? adaptivePersonalization?.recommendedSessionMinutes ?? adaptiveDefaults.recommendedSessionMinutes;
  const adaptiveTasks = insights?.recommendedTasks ?? briefing?.adaptiveTasks ?? [];
  const selectedAdaptiveTask = selectedRecommendationId
    ? adaptiveTasks.find(task => task.id === selectedRecommendationId) ?? null
    : null;
  const durationOptions = buildGuardianDurationOptions({
    adaptiveDuration,
    personalization: adaptivePersonalization,
    selectedTask: selectedAdaptiveTask,
    topTask: adaptiveTasks[0] ?? null,
  });
  const guardianOpeningMessage = buildGuardianOpeningMessage({
    active: activeSession.active,
    briefing,
    personalization: adaptivePersonalization,
  });

  const fetchBriefing = useCallback(async () => {
    try {
      const res = await fetch('/api/guardian/day-briefing');
      if (res.ok) {
        const data = await res.json();
        setBriefing(data.briefing ?? data);
      }
    } catch { }
  }, []);

  const fetchInsights = useCallback(async () => {
    try {
      const res = await fetch('/api/guardian/insights');
      if (res.ok) {
        const data = await res.json() as GuardianInsights;
        setInsights(data);
        const nextDuration = data.personalization?.plannedFocus?.nextMinutes ?? data.personalization?.recommendedSessionMinutes;
        if (!activeSession.active && nextDuration) {
          setDuration(Math.round(nextDuration));
        }
      }
    } catch { }
  }, [activeSession.active]);

  const fetchSuggestedTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/guardian/standup');
      if (res.ok) {
        const data = await res.json();
        setSuggestedTasks(data.suggestedTasks ?? []);
        setWeakConcepts(data.weakConcepts ?? []);
      }
    } catch { }
  }, []);

  const fetchCalibrationStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/guardian/session/feedback');
      if (res.ok) {
        const data = await res.json();
        setCalibrationStatus(data);
      }
    } catch { }
  }, []);

  const fetchNextDayPlan = useCallback(async () => {
    try {
      const res = await fetch(`/api/next-day-plan?date=${tomorrowIso()}`);
      if (res.ok) {
        const data = await res.json() as GuardianNextDayPlan;
        setNextDayPlan(data);
      }
    } catch { }
  }, []);

  const regenerateNextDayPlan = async () => {
    setNextDayPlanLoading(true);
    try {
      const res = await fetch('/api/next-day-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planDate: tomorrowIso(), syncCalendar: true, regenerate: true }),
      });
      if (res.ok) {
        const data = await res.json() as GuardianNextDayPlan;
        setNextDayPlan(data);
      }
    } catch { }
    setNextDayPlanLoading(false);
  };

  const fetchHistoryData = useCallback(async () => {
    try {
      const res = await fetch('/api/guardian/history');
      if (res.ok) {
        const data = await res.json();
        setHistoryData({
          overrides: data.overrides ?? [],
          sessions: data.sessions ?? [],
          pendingCompletions: data.pendingCompletions ?? [],
        });
      }
    } catch { }
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
    } catch { }
  }, []);

  useEffect(() => {
    Promise.all([fetchBriefing(), fetchInsights(), fetchOptimizerData(), fetchHistoryData(), fetchSuggestedTasks(), fetchNextDayPlan(), fetchCalibrationStatus()]).finally(() => setLoading(false));
    const briefingInterval = setInterval(fetchBriefing, 60_000);
    const insightsInterval = setInterval(fetchInsights, 60_000);
    return () => {
      clearInterval(briefingInterval);
      clearInterval(insightsInterval);
    };
  }, [fetchBriefing, fetchInsights, fetchOptimizerData, fetchHistoryData, fetchSuggestedTasks, fetchNextDayPlan, fetchCalibrationStatus]);

  useEffect(() => {
    if (!activeSession.active && !adaptivePersonalization?.recommendedSessionMinutes) {
      setDuration(Math.round(adaptiveDefaults.recommendedSessionMinutes));
    }
  }, [activeSession.active, adaptiveDefaults.recommendedSessionMinutes, adaptivePersonalization?.recommendedSessionMinutes]);

  // Pre-fill topic from the highest-signal planned focus before falling back to briefing.
  useEffect(() => {
    if (plannedFocus?.nextTitle && !topic) {
      setTopic(plannedFocus.nextTitle);
      return;
    }
    if (briefing?.upcomingFocusTarget && !topic) {
      setTopic(briefing.upcomingFocusTarget);
    }
  }, [briefing, plannedFocus?.nextTitle, topic]);

  const sendRecommendationFeedback = async (
    taskId: number,
    feedback: 'helpful' | 'not_now' | 'wrong' | 'started' | 'completed' | 'dismissed',
    reason?: string,
  ) => {
    await fetch('/api/dashboard/recommendation-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, feedback, reason, surface: 'guardian_page' }),
    }).catch(() => { });
  };

  const acceptAdaptiveTask = (task: NonNullable<GuardianInsights['recommendedTasks']>[number]) => {
    setTopic(task.title);
    setSelectedRecommendationId(task.id);
    setDuration(Math.round(task.estimatedMinutes || adaptiveDuration));
    sendRecommendationFeedback(task.id, 'helpful', 'accepted on guardian page');
  };

  const dismissAdaptiveTask = (taskId: number) => {
    sendRecommendationFeedback(taskId, 'not_now', 'dismissed on guardian page');
    setInsights(prev => prev ? {
      ...prev,
      recommendedTasks: prev.recommendedTasks?.filter(task => task.id !== taskId),
    } : prev);
    if (selectedRecommendationId === taskId) setSelectedRecommendationId(null);
  };

  const startSession = async () => {
    if (!topic.trim()) { topicRef.current?.focus(); return; }
    setStarting(true);
    const id = await startGuardianSession({
      conceptNodeName: topic.trim(),
      durationMinutes: duration,
      mood: mood || null,
      source: 'dashboard',
      sessionContext: sessionContext.trim() || undefined,
    });
    if (id && selectedRecommendationId) {
      sendRecommendationFeedback(selectedRecommendationId, 'started', 'started session from guardian page');
    }
    if (id) { setTopic(''); setSessionContext(''); setShowContext(false); }
    setStarting(false);
  };

  const endSession = async () => {
    if (!activeSession.active) return;
    await endGuardianSession();
    await fetchBriefing();
  };

  const dismissCommitment = async (id: string) => {
    try {
      await fetch(`/api/guardian/soft-watch?id=${id}`, { method: 'DELETE' });
      await fetchBriefing();
    } catch { }
  };

  const actionCompletion = async (id: number, action: 'done' | 'blocked' | 'skipped', markTaskDone = false) => {
    try {
      setCompletionActionNotice(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      const res = await fetch('/api/guardian/session/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, mark_task_done: markTaskDone }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        setCompletionActionNotice(prev => ({
          ...prev,
          [id]: payload?.message || 'This task still needs linked focus time before it can complete.',
        }));
        return;
      }
      await fetchHistoryData();
    } catch {
      setCompletionActionNotice(prev => ({ ...prev, [id]: 'Could not update this review right now.' }));
    }
  };

  const submitFeedback = async (sessionId: string) => {
    const text = feedbackText[sessionId]?.trim();
    if (!text) return;
    setFeedbackSubmitting(prev => ({ ...prev, [sessionId]: true }));
    try {
      await fetch('/api/guardian/session/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, feedback: text }),
      });
      setFeedbackDone(prev => ({ ...prev, [sessionId]: true }));
    } catch { }
    setFeedbackSubmitting(prev => ({ ...prev, [sessionId]: false }));
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
      if (selectedRecommendationId) {
        sendRecommendationFeedback(selectedRecommendationId, 'helpful', 'scheduled from guardian page');
      }
      setScheduleMode(false);
      setScheduleTime('');
      await fetchBriefing();
    } catch { }
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
          {guardianOpeningMessage}
        </h1>
      </div>

      {/* Live Session — shown when active */}
      {activeSession.active ? (
        <div style={{ marginBottom: '28px' }}>
          <GuardianDashboard
            sessionId={activeSession.sessionId!}
            plannedMinutes={activeSession.durationMinutes}
            targetTitle={activeSession.targetTitle ?? 'Focus Session'}
            startedAt={activeSession.startedAt ?? undefined}
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
          {adaptivePersonalization && (
            <div style={{
              background: 'linear-gradient(135deg, rgba(99,102,241,0.1), rgba(34,197,94,0.04))',
              border: '1px solid rgba(99,102,241,0.25)',
              borderRadius: '10px',
              padding: '12px',
              marginBottom: '12px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '6px' }}>
                <div style={{ fontSize: '11px', color: '#a5b4fc', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                  {MODE_LABEL[adaptivePersonalization.mode]}
                </div>
                <div style={{ fontSize: '11px', color: '#8888a0' }}>
                  {adaptivePersonalization.energy} energy · {formatDuration(adaptiveDuration)}
                </div>
              </div>
              <div style={{ fontSize: '12px', color: '#c8c8df', lineHeight: 1.45 }}>
                {adaptivePersonalization.guidance}
              </div>
            </div>
          )}
          {adaptiveTasks.length > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '10px', color: '#555570', marginBottom: '6px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Adaptive picks for this moment
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {adaptiveTasks.slice(0, 3).map(task => (
                  <div key={task.id} style={{
                    background: selectedRecommendationId === task.id ? '#6366f122' : '#1a1a2e',
                    border: `1px solid ${selectedRecommendationId === task.id ? '#6366f155' : '#2a2a40'}`,
                    borderRadius: '10px',
                    padding: '8px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={() => acceptAdaptiveTask(task)}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          background: 'none',
                          border: 'none',
                          color: selectedRecommendationId === task.id ? '#a5b4fc' : '#f0f0f5',
                          fontSize: '12px',
                          fontWeight: 700,
                          cursor: 'pointer',
                          textAlign: 'left',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          padding: 0,
                        }}
                      >
                        {task.title}
                      </button>
                      <span style={{
                        fontSize: '9px',
                        color: task.momentFit === 'high' ? '#22c55e' : task.momentFit === 'low' ? '#f59e0b' : '#a5b4fc',
                        flexShrink: 0,
                      }}>
                        {task.momentFit} fit
                      </span>
                      <button
                        onClick={() => dismissAdaptiveTask(task.id)}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          color: '#555570',
                          cursor: 'pointer',
                          fontSize: '12px',
                          padding: '0 2px',
                        }}
                        title="Not now"
                      >
                        ×
                      </button>
                    </div>
                    <div style={{ fontSize: '10px', color: '#8888a0', marginTop: '4px', lineHeight: 1.35 }}>
                      {task.reason}
                      {task.estimatedMinutes ? ` · ${task.estimatedMinutes}m` : ''}
                      {task.energyRequired ? ` · ${task.energyRequired} energy` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {suggestedTasks.length > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '10px', color: '#555570', marginBottom: '6px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Other goal-linked options
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {suggestedTasks.slice(0, 4).map(t => (
                  <button
                    key={t.id}
                    onClick={() => { setTopic(t.title); setSelectedRecommendationId(null); }}
                    style={{
                      padding: '4px 10px', borderRadius: '20px', border: 'none', cursor: 'pointer',
                      fontSize: '12px', fontWeight: 500,
                      background: topic === t.title ? '#6366f133' : '#1a1a2e',
                      color: topic === t.title ? '#a5b4fc' : '#8888a0',
                      borderWidth: '1px', borderStyle: 'solid',
                      borderColor: topic === t.title ? '#6366f155' : '#2a2a40',
                    }}
                  >
                    {t.title}
                    {t.goal_health === 'at_risk' && <span style={{ color: '#f59e0b', marginLeft: '4px' }}>!</span>}
                    {t.goal_health === 'off_track' && <span style={{ color: '#ef4444', marginLeft: '4px' }}>!!</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {weakConcepts.length > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <div style={{ fontSize: '10px', color: '#555570', marginBottom: '6px', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                Weak concepts to review
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {weakConcepts.slice(0, 3).map(c => (
                  <button
                    key={c.id}
                    onClick={() => { setTopic(c.title); setSelectedRecommendationId(null); }}
                    style={{
                      padding: '4px 10px', borderRadius: '20px', border: 'none', cursor: 'pointer',
                      fontSize: '12px', fontWeight: 500,
                      background: topic === c.title ? '#f59e0b22' : '#1a1a2e',
                      color: topic === c.title ? '#f59e0b' : '#888899',
                      borderWidth: '1px', borderStyle: 'solid',
                      borderColor: topic === c.title ? '#f59e0b44' : '#2a2a40',
                    }}
                    title={c.goalTitle ?? undefined}
                  >
                    {c.title} <span style={{ color: '#555570' }}>{c.mastery}%</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <input
            ref={topicRef}
            type="text"
            placeholder={guardianTopicPlaceholder(adaptivePersonalization)}
            value={topic}
            onChange={e => { setTopic(e.target.value); setSelectedRecommendationId(null); }}
            onKeyDown={e => e.key === 'Enter' && !scheduleMode && !showContext && void startSession()}
            style={{
              width: '100%', padding: '10px 12px', background: '#0a0a12', border: '1px solid #2a2a40',
              borderRadius: '8px', color: '#f0f0f5', fontSize: '14px', marginBottom: '6px', boxSizing: 'border-box',
            }}
          />
          {plannedFocusLabel && (
            <div style={{
              fontSize: '11px',
              color: '#93c5fd',
              background: 'rgba(59,130,246,0.08)',
              border: '1px solid rgba(59,130,246,0.18)',
              borderRadius: '8px',
              padding: '7px 9px',
              marginBottom: '8px',
            }}>
              Next planned focus: {plannedFocusLabel}
            </div>
          )}
          <button
            onClick={() => setShowContext(v => !v)}
            style={{
              background: 'none', border: 'none', color: showContext ? '#6366f1' : '#555570',
              fontSize: '12px', cursor: 'pointer', padding: '0 2px', marginBottom: '8px',
              textAlign: 'left', display: 'block',
            }}
          >
            {showContext ? '▾ Hide context' : '▸ Add context (optional)'}
          </button>
          {showContext && (
            <textarea
              placeholder={guardianSessionContextPlaceholder(adaptivePersonalization)}
              value={sessionContext}
              onChange={e => setSessionContext(e.target.value)}
              rows={3}
              style={{
                width: '100%', padding: '10px 12px', background: '#0a0a12', border: '1px solid #2a2a40',
                borderRadius: '8px', color: '#f0f0f5', fontSize: '13px', marginBottom: '10px',
                boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit', lineHeight: '1.5',
              }}
            />
          )}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <select
              value={duration}
              onChange={e => setDuration(Number(e.target.value))}
              style={{
                flex: 1, padding: '9px', background: '#0a0a12', border: '1px solid #2a2a40',
                borderRadius: '8px', color: '#f0f0f5', fontSize: '13px', cursor: 'pointer',
              }}
            >
              {durationOptions.map(m => (
                <option key={`${m.minutes}-${m.label}`} value={m.minutes}>
                  {m.label} ({formatDuration(m.minutes)})
                </option>
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
                { label: 'Mode', value: adaptivePersonalization ? MODE_LABEL[adaptivePersonalization.mode] : '—', sub: adaptivePersonalization?.alertFatigueLevel ? `alerts ${adaptivePersonalization.alertFatigueLevel}` : 'learning' },
                { label: 'Sprint', value: formatDuration(adaptiveDuration), sub: adaptivePersonalization?.energy ? `${adaptivePersonalization.energy} energy` : briefing.coachingStyle + ' coaching' },
                { label: 'Best Start', value: formatHour(briefing.bestStartHour), sub: adaptivePersonalization?.nextBestFocusWindow || 'based on history' },
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
              No upcoming sessions.<br />Use &quot;Schedule&quot; to plan ahead.
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

      {/* Next-Day Plan */}
      <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px', marginBottom: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <div>
            <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Tomorrow Plan
            </div>
            {nextDayPlan && (
              <div style={{ fontSize: '10px', color: '#444460', marginTop: '2px' }}>
                {nextDayPlan.plan?.generated_summary ?? nextDayPlan.suggestedInputs.reason}
              </div>
            )}
          </div>
          <button
            onClick={regenerateNextDayPlan}
            disabled={nextDayPlanLoading}
            style={{
              padding: '6px 13px', borderRadius: '7px', border: '1px solid #2a2a40',
              background: '#0a0a12', color: nextDayPlanLoading ? '#444460' : '#8888a0',
              fontSize: '11px', cursor: nextDayPlanLoading ? 'default' : 'pointer', fontWeight: 600,
            }}
          >
            {nextDayPlanLoading ? 'Generating...' : 'Regenerate'}
          </button>
        </div>

        {!nextDayPlan?.plan ? (
          <div style={{ fontSize: '12px', color: '#555570', textAlign: 'center', padding: '20px 0' }}>
            {buildNextDayPlanEmptyMessage(nextDayPlan)}
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '14px' }}>
              {[
                ['Date', nextDayPlan.plan.plan_date],
                ['Sleep', nextDayPlan.plan.sleep_time ?? nextDayPlan.suggestedInputs.sleepTime],
                ['Wake', nextDayPlan.plan.wake_estimate ?? nextDayPlan.suggestedInputs.wakeEstimate],
                ['Energy', nextDayPlan.plan.energy ?? nextDayPlan.personalization.energy],
                ['Mood', nextDayPlan.plan.mood ?? nextDayPlan.personalization.mood ?? 'unknown'],
                ['Best window', nextDayPlan.personalization.bestFocusWindow],
                ['Sprint', formatDuration(nextDayPlan.personalization.learnedSprintMinutes)],
                ['Calendar', nextDayPlan.calendarConfigured ? 'connected' : 'not connected'],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    background: '#0a0a12',
                    border: '1px solid #1a1a2e',
                    borderRadius: '8px',
                    padding: '8px 10px',
                  }}
                >
                  <div style={{ fontSize: '9px', color: '#555570', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
                    {label}
                  </div>
                  <div style={{ fontSize: '12px', color: '#d4d4e8', marginTop: '4px', overflowWrap: 'anywhere' }}>
                    {value}
                  </div>
                </div>
              ))}
            </div>

            {nextDayPlan.sessions.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#555570', textAlign: 'center', padding: '16px 0' }}>
                {buildNoSessionsMessage(nextDayPlan)}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {nextDayPlan.sessions.map(session => {
                  const rule = parseSessionRule(session.rule_json);
                  const calendarColor = session.calendar_status === 'failed' ? '#ef4444' : session.calendar_status === 'not_configured' ? '#8888a0' : '#22c55e';
                  const statusColor = session.status === 'completed' ? '#22c55e' : session.status === 'skipped' || session.status === 'cancelled' ? '#ef4444' : '#a5b4fc';
                  const timeRange = `${formatPlanClock(session.planned_start)}-${formatPlanClock(session.planned_end)}`;
                  return (
                    <div
                      key={session.id}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '92px minmax(0, 1fr) auto',
                        gap: '10px',
                        alignItems: 'center',
                        background: '#0a0a12',
                        border: '1px solid #1a1a2e',
                        borderRadius: '9px',
                        padding: '10px',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '13px', color: '#e5e7eb', fontWeight: 800 }}>{timeRange}</div>
                        <div style={{ fontSize: '10px', color: '#555570', marginTop: '3px' }}>{formatDuration(session.duration_minutes)}</div>
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <button
                          onClick={() => setTopic(session.title)}
                          style={{
                            border: 0,
                            background: 'transparent',
                            color: '#d4d4e8',
                            padding: 0,
                            fontSize: '13px',
                            fontWeight: 700,
                            cursor: 'pointer',
                            textAlign: 'left',
                            overflowWrap: 'anywhere',
                          }}
                        >
                          {session.title}
                        </button>
                        <div style={{ fontSize: '10px', color: '#666680', marginTop: '4px', lineHeight: 1.4 }}>
                          {rule.guidance ?? `${session.session_type.replaceAll('_', ' ')} session`}
                          {rule.breakMinutes ? ` · ${rule.breakMinutes}m break planned` : ''}
                          {rule.tools?.length ? ` · ${rule.tools.slice(0, 3).join(', ')}` : ''}
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-end' }}>
                        <div style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 700 }}>
                          {session.reward_xp} XP · {session.reward_coins}c
                        </div>
                        <div style={{ fontSize: '9px', color: statusColor, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>
                          {session.status}
                        </div>
                        <div style={{ fontSize: '9px', color: calendarColor }}>
                          {session.calendar_status.replaceAll('_', ' ')}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {nextDayPlan.candidateTasks.length > 0 && (
              <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #1a1a2e' }}>
                <div style={{ fontSize: '9px', color: '#555570', fontWeight: 700, marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  Candidate Pool
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                  {nextDayPlan.candidateTasks.slice(0, 6).map(task => (
                    <button
                      key={task.id}
                      onClick={() => setTopic(task.title)}
                      title={`${task.reason} · ${task.remaining_minutes}m remaining`}
                      style={{
                        border: '1px solid #1a1a2e',
                        background: '#0a0a12',
                        color: '#8888a0',
                        borderRadius: '7px',
                        padding: '5px 8px',
                        fontSize: '10px',
                        cursor: 'pointer',
                      }}
                    >
                      {task.title} · {formatDuration(task.remaining_minutes)}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

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

      {/* Post-Session Review Queue */}
      {historyData && historyData.pendingCompletions.length > 0 && (
        <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px', marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Review — {historyData.pendingCompletions.length} session{historyData.pendingCompletions.length > 1 ? 's' : ''} pending
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {historyData.pendingCompletions.map(c => (
              <div key={c.id} style={{
                background: '#0a0a12', borderRadius: '10px', padding: '12px 14px',
                borderLeft: '3px solid #f59e0b',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', marginBottom: '10px' }}>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: 700, color: '#e0e0f0' }}>
                      {c.task_title ?? c.target_title ?? 'Session'}
                    </div>
                    <div style={{ fontSize: '11px', color: '#555570', marginTop: '2px' }}>
                      {c.elapsed_minutes != null && `${c.elapsed_minutes}m`}
                      {c.average_focus_score != null && ` · focus ${Math.round(c.average_focus_score)}`}
                      {c.mood && ` · ${c.mood} energy`}
                    </div>
                  </div>
                  {c.average_focus_score != null && (
                    <div style={{
                      fontSize: '18px', fontWeight: 800,
                      color: scoreColor(c.average_focus_score),
                    }}>
                      {Math.round(c.average_focus_score)}
                    </div>
                  )}
                </div>
                {/* Feedback textarea */}
                {!feedbackDone[c.session_id] ? (
                  <div style={{ marginBottom: '10px' }}>
                    <textarea
                      rows={2}
                      placeholder={buildSessionFeedbackPlaceholder(c, adaptivePersonalization)}
                      value={feedbackText[c.session_id] ?? ''}
                      onChange={e => setFeedbackText(prev => ({ ...prev, [c.session_id]: e.target.value }))}
                      style={{
                        width: '100%', padding: '7px 10px', background: '#0d0d1a',
                        border: '1px solid #2a2a40', borderRadius: '7px',
                        color: '#c0c0d5', fontSize: '12px', resize: 'vertical',
                        boxSizing: 'border-box', fontFamily: 'inherit', lineHeight: 1.4,
                        marginBottom: '6px',
                      }}
                    />
                    <button
                      onClick={() => void submitFeedback(c.session_id)}
                      disabled={!feedbackText[c.session_id]?.trim() || feedbackSubmitting[c.session_id]}
                      style={{
                        padding: '4px 10px', borderRadius: '6px', border: 'none',
                        cursor: feedbackText[c.session_id]?.trim() ? 'pointer' : 'default',
                        fontSize: '11px', fontWeight: 600,
                        background: feedbackText[c.session_id]?.trim() ? '#6366f133' : '#1a1a2e',
                        color: feedbackText[c.session_id]?.trim() ? '#a5b4fc' : '#444460',
                      }}
                    >
                      {feedbackSubmitting[c.session_id] ? 'Saving…' : 'Submit Feedback'}
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: '11px', color: '#22c55e', marginBottom: '10px' }}>
                    Feedback saved — weights updated.
                  </div>
                )}

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => actionCompletion(c.id, 'done', !!c.task_id)}
                    style={{ padding: '5px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600, background: '#22c55e22', color: '#22c55e' }}
                  >
                    Done
                  </button>
                  <button
                    onClick={() => actionCompletion(c.id, 'blocked')}
                    style={{ padding: '5px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600, background: '#ef444422', color: '#ef4444' }}
                  >
                    Blocked
                  </button>
                  <button
                    onClick={() => actionCompletion(c.id, 'skipped')}
                    style={{ padding: '5px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 600, background: '#33334a', color: '#8888a0' }}
                  >
                    Skip
                  </button>
                </div>
                {completionActionNotice[c.id] && (
                  <div style={{
                    marginTop: '8px',
                    fontSize: '11px',
                    color: '#f59e0b',
                    background: 'rgba(245,158,11,0.08)',
                    border: '1px solid rgba(245,158,11,0.16)',
                    borderRadius: '6px',
                    padding: '6px 8px',
                  }}>
                    {completionActionNotice[c.id]}
                  </div>
                )}
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
                    color: scoreColor(s.average_focus_score),
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
              try { displayUrl = new URL(o.url).hostname.replace(/^www\./, ''); } catch { }
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

      {/* Calibration */}
      {calibrationStatus && (
        <div style={{ background: '#111118', border: '1px solid #2a2a40', borderRadius: '14px', padding: '18px', marginBottom: '28px' }}>
          <div style={{ fontSize: '11px', color: '#8888a0', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '14px' }}>
            Model Calibration
          </div>

          {/* Accuracy meter */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '14px' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontSize: '11px', color: '#8888a0' }}>Prediction accuracy</span>
                <span style={{ fontSize: '13px', fontWeight: 700, color: calibrationStatus.accuracy === null ? '#555570' : calibrationStatus.accuracy >= 0.7 ? '#22c55e' : calibrationStatus.accuracy >= 0.5 ? '#f59e0b' : '#ef4444' }}>
                  {calibrationStatus.accuracy === null ? '—' : `${Math.round(calibrationStatus.accuracy * 100)}%`}
                </span>
              </div>
              {calibrationStatus.accuracy !== null && (
                <div style={{ height: '4px', background: '#1a1a2e', borderRadius: '2px' }}>
                  <div style={{
                    height: '100%', borderRadius: '2px',
                    width: `${Math.round(calibrationStatus.accuracy * 100)}%`,
                    background: calibrationStatus.accuracy >= 0.7 ? '#22c55e' : calibrationStatus.accuracy >= 0.5 ? '#f59e0b' : '#ef4444',
                  }} />
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: '14px', fontWeight: 700, color: '#f0f0f5' }}>{calibrationStatus.sessions_count}</div>
              <div style={{ fontSize: '10px', color: '#555570' }}>sessions</div>
            </div>
          </div>

          {/* Recent adjustments */}
          {calibrationStatus.recent_adjustments.length > 0 ? (
            <div>
              <div style={{ fontSize: '10px', color: '#555570', fontWeight: 600, marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Recent Weight Adjustments
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {calibrationStatus.recent_adjustments.slice(0, 6).map((a, i) => {
                  const delta = a.new_value - a.previous_value;
                  const label = a.component.replace(/^(energy|focus)_weight_/, '').replace(/_/g, ' ');
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', background: '#0a0a12', borderRadius: '5px' }}>
                      <span style={{ fontSize: '10px', color: '#666680', flex: 1 }}>{label}</span>
                      <span style={{ fontSize: '10px', fontWeight: 700, color: delta > 0 ? '#22c55e' : '#ef4444', minWidth: '42px', textAlign: 'right' }}>
                        {delta > 0 ? '+' : ''}{(delta * 100).toFixed(1)}%
                      </span>
                      <span style={{ fontSize: '10px', color: '#444460', maxWidth: '160px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.reason}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: '12px', color: '#555570' }}>
              {buildCalibrationEmptyMessage(adaptivePersonalization)}
            </div>
          )}
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
            <div style={{ fontSize: '12px', color: '#555570' }}>{buildOptimizerEmptyMessage(adaptivePersonalization)}</div>
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
