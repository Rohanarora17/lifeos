import { getDb, getSetting } from './db';
import { getIntelligenceContext, getIntelligenceProfile } from './intelligence';
import { getMemoryContext } from './memory';
import { getAdaptiveBands } from './adaptive-bands';
import {
  computeCognitiveTraits,
  formatCognitiveTraitsForPrompt,
  type CognitiveTraitBundle,
} from './cognitive-traits';
import {
  formatExperimentForPrompt,
  getCognitiveExperimentState,
  type CognitiveExperimentState,
} from './cognitive-experiments';
import {
  formatActiveCoachForPrompt,
  getActiveCoachPolicy,
  type ActiveCoachPolicy,
} from './cognitive-active-coach';
import {
  getCognitiveTrajectory,
  type CognitiveTrajectory,
} from './cognitive-self-answer';
import { getCoachingState, type CoverageState, type EngagementState } from './coaching-state';
import { getDailyActivityStats } from './scoring';

export type PersonalizationSurface =
  | 'agent'
  | 'chat'
  | 'guidance'
  | 'notification'
  | 'scheduler'
  | 'settings'
  | 'voice'
  | 'dashboard'
  | 'screen_vision'
  | 'study_plan'
  | 'summary'
  | 'telegram'
  | 'nudge'
  | 'tasks'
  | 'habits'
  | 'intervention'
  | 'scoring'
  | 'rewards'
  | 'achievements'
  | 'analytics'
  | 'self_model'
  | 'checkin';

export interface PersonalizationSnapshot {
  surface: PersonalizationSurface;
  generatedAt: string;
  today: {
    date: string;
    hour: number;
    dayPhase: 'early' | 'morning' | 'afternoon' | 'evening' | 'night';
    openTasks: number;
    overdueTasks: number;
    doingTasks: string[];
    uncheckedHabits: string[];
    calendarEvents: string[];
    recentDistractionMinutes: number;
    activitySignal: {
      productiveMinutes: number;
      distractionMinutes: number;
      neutralMinutes: number;
      totalMinutes: number;
    };
    plannedFocus: {
      plannedToday: number;
      completedToday: number;
      skippedToday: number;
      nextTitle: string | null;
      nextMinutes: number | null;
      nextSessionId: string | null;
      nextTaskId: number | null;
      nextStart: string | null;
      recentFollowThroughRate: number | null;
    };
  };
  userState: {
    narrative: string;
    standupGoal: string | null;
    mood: 'high' | 'medium' | 'low' | null;
    energy: 'high' | 'medium' | 'low';
    moodSource: 'explicit_checkin' | 'unknown';
    energySource: 'explicit_checkin' | 'baseline';
    stateUpdatedAt: string | null;
    coachingStyle: 'direct' | 'balanced' | 'gentle';
    focusTrend: 'improving' | 'declining' | 'stable';
    peakFocusHours: number[];
    nextBestFocusWindow: string;
  };
  activeSession: {
    sessionId: string;
    targetTitle: string;
    focusScore: number | null;
    elapsedMinutes: number;
  } | null;
  feedback: {
    alertFatigueLevel: 'low' | 'medium' | 'high';
    recentAlerts: number;
    helpfulRate: number | null;
    corrections30d: number;
  };
  coaching: {
    engagement: EngagementState;
    coverage: CoverageState;
    reason: string;
    evidence: string[];
  };
  moment: {
    mode: 'protect_focus' | 'deadline_pressure' | 'recovery' | 'planning' | 'normal';
    guidance: string;
  };
  /**
   * First-class Cognitive Self-Map — shared with every surface that builds a snapshot.
   * Deterministic traits + coach + trajectory; not a UI-only silo.
   */
  cognitive: {
    traits: CognitiveTraitBundle;
    activeCoach: ActiveCoachPolicy;
    trajectory: CognitiveTrajectory;
    experiments: CognitiveExperimentState;
    /** Compact prompt-ready block (same data as structured fields) */
    contextBlock: string;
  };
  intelligenceContext: string;
  memoryContext: string;
}

export interface PersonalizationActiveSessionInput {
  sessionId: string;
  targetTitle: string;
  focusScore: number | null;
  elapsedMinutes: number;
}

const IST_OFFSET_MS = 19_800_000;

function getIstNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function dayPhase(hour: number): PersonalizationSnapshot['today']['dayPhase'] {
  if (hour < 6) return 'early';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 22) return 'evening';
  return 'night';
}

function getCount(sql: string, args: unknown[] = []): number {
  try {
    const row = getDb().prepare(sql).get(...args) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  } catch {
    return 0;
  }
}

function getStrings(sql: string, args: unknown[] = [], field = 'title'): string[] {
  try {
    return (getDb().prepare(sql).all(...args) as Array<Record<string, unknown>>)
      .map(row => String(row[field] ?? '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getRecentDistractionMinutes(): number {
  try {
    const row = getDb().prepare(`
      SELECT COALESCE(SUM(duration_seconds), 0) as seconds
      FROM effective_activities
      WHERE started_at >= datetime('now', '-2 hours')
        AND category = 'distraction'
    `).get() as { seconds: number } | undefined;
    return Math.round(Number(row?.seconds ?? 0) / 60);
  } catch {
    return 0;
  }
}

function getPlannedFocusContext(date: string): PersonalizationSnapshot['today']['plannedFocus'] {
  try {
    const today = getDb().prepare(`
      SELECT
        COUNT(*) as plannedToday,
        SUM(CASE WHEN pfs.status = 'completed' THEN 1 ELSE 0 END) as completedToday,
        SUM(CASE WHEN pfs.status = 'skipped' THEN 1 ELSE 0 END) as skippedToday
      FROM planned_focus_sessions pfs
      JOIN daily_plans dp ON dp.id = pfs.plan_id
      WHERE dp.plan_date = ?
    `).get(date) as {
      plannedToday: number | null;
      completedToday: number | null;
      skippedToday: number | null;
    } | undefined;

    const next = getDb().prepare(`
      SELECT
        pfs.id as sessionId,
        pfs.task_id as taskId,
        t.title,
        pfs.planned_start as plannedStart,
        pfs.duration_minutes as durationMinutes
      FROM planned_focus_sessions pfs
      JOIN daily_plans dp ON dp.id = pfs.plan_id
      JOIN tasks t ON t.id = pfs.task_id
      WHERE dp.plan_date = ?
        AND pfs.status IN ('planned', 'started')
        AND pfs.invalidated_reason IS NULL
        AND (pfs.status = 'started' OR julianday(pfs.planned_end) > julianday('now'))
      ORDER BY pfs.planned_start ASC
      LIMIT 1
    `).get(date) as {
      sessionId: string;
      taskId: number;
      title: string;
      plannedStart: string;
      durationMinutes: number;
    } | undefined;

    const recent = getDb().prepare(`
      SELECT
        SUM(CASE WHEN pfs.status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN pfs.status IN ('completed', 'skipped') THEN 1 ELSE 0 END) as resolved
      FROM planned_focus_sessions pfs
      JOIN daily_plans dp ON dp.id = pfs.plan_id
      WHERE dp.plan_date >= date(?, '-14 days')
        AND dp.plan_date < ?
    `).get(date, date) as { completed: number | null; resolved: number | null } | undefined;

    const resolved = Number(recent?.resolved ?? 0);
    return {
      plannedToday: Number(today?.plannedToday ?? 0),
      completedToday: Number(today?.completedToday ?? 0),
      skippedToday: Number(today?.skippedToday ?? 0),
      nextTitle: next?.title ?? null,
      nextMinutes: next?.durationMinutes ?? null,
      nextSessionId: next?.sessionId ?? null,
      nextTaskId: next?.taskId ?? null,
      nextStart: next?.plannedStart ?? null,
      recentFollowThroughRate: resolved > 0 ? Number(recent?.completed ?? 0) / resolved : null,
    };
  } catch {
    return {
      plannedToday: 0,
      completedToday: 0,
      skippedToday: 0,
      nextTitle: null,
      nextMinutes: null,
      nextSessionId: null,
      nextTaskId: null,
      nextStart: null,
      recentFollowThroughRate: null,
    };
  }
}

function getHelpfulRate(): number | null {
  try {
    const rows = getDb().prepare(`
      SELECT helpful FROM agent_action_outcomes
      WHERE helpful IS NOT NULL
        AND created_at >= datetime('now', '-30 days')
    `).all() as Array<{ helpful: number }>;
    if (rows.length === 0) return null;
    return rows.reduce((sum, row) => sum + (row.helpful ? 1 : 0), 0) / rows.length;
  } catch {
    return null;
  }
}

type CapacityState = 'high' | 'medium' | 'low';

function asCapacityState(value: string | null): CapacityState | null {
  return value === 'high' || value === 'medium' || value === 'low' ? value : null;
}

function getExplicitTodayState(date: string): {
  mood: CapacityState | null;
  energy: CapacityState | null;
  updatedAt: string | null;
} {
  try {
    const rows = getDb().prepare(`
      SELECT mood, energy, received_at
      FROM daily_checkins
      WHERE checkin_date = ?
        AND (mood IN ('high', 'medium', 'low') OR energy IN ('high', 'medium', 'low'))
      ORDER BY received_at DESC, id DESC
    `).all(date) as Array<{ mood: string | null; energy: string | null; received_at: string | null }>;

    let mood: CapacityState | null = null;
    let energy: CapacityState | null = null;
    let updatedAt: string | null = null;
    for (const row of rows) {
      mood ||= asCapacityState(row.mood);
      energy ||= asCapacityState(row.energy);
      updatedAt ||= row.received_at;
      if (mood && energy) break;
    }
    return { mood, energy, updatedAt };
  } catch {
    return { mood: null, energy: null, updatedAt: null };
  }
}

function getTodayStandupGoal(date: string): string | null {
  try {
    return getSetting('standup_goal_date') === date
      ? (getSetting('standup_goal_today')?.trim() || null)
      : null;
  } catch {
    return null;
  }
}

function deriveMoment(input: {
  hour: number;
  openTasks: number;
  overdueTasks: number;
  uncheckedHabits: number;
  energy: 'high' | 'medium' | 'low';
  mood: 'high' | 'medium' | 'low' | null;
  focusScore: number | null;
  focusGood: number;
  peakFocusHours: number[];
  engagement: EngagementState;
}): PersonalizationSnapshot['moment'] {
  if (input.engagement === 'disengaged' || input.engagement === 'reconnecting' || input.engagement === 'paused') {
    return {
      mode: 'recovery',
      guidance: `The coaching state is ${input.engagement}. Coordinate around one restart and suppress routine pressure.`,
    };
  }
  if (input.focusScore !== null && input.focusScore >= input.focusGood && input.peakFocusHours.includes(input.hour)) {
    return {
      mode: 'protect_focus',
      guidance: 'Protect the current focus block. Avoid low-urgency nudges and keep help brief.',
    };
  }

  if (input.overdueTasks > 0) {
    return {
      mode: 'deadline_pressure',
      guidance: 'Prioritize concrete deadline relief. Suggest the smallest useful next action.',
    };
  }

  if (input.energy === 'low' || input.mood === 'low') {
    return {
      mode: 'recovery',
      guidance: 'Use low-friction recommendations. Convert goals into minimum viable actions.',
    };
  }

  if (input.hour >= 20 || (input.openTasks === 0 && input.uncheckedHabits === 0)) {
    return {
      mode: 'planning',
      guidance: 'Favor reflection, planning, cleanup, and setting up tomorrow.',
    };
  }

  return {
    mode: 'normal',
    guidance: 'Balance momentum, commitments, energy, and long-term goals.',
  };
}

export function buildPersonalizationSnapshot(opts?: {
  surface?: PersonalizationSurface;
  maxInsights?: number;
  includeThresholds?: boolean;
  includeMemoryFacts?: number;
  activeSession?: PersonalizationActiveSessionInput | null;
}): PersonalizationSnapshot {
  const surface = opts?.surface ?? 'agent';
  const now = getIstNow();
  const date = now.toISOString().slice(0, 10);
  const hour = now.getUTCHours();
  const profile = getIntelligenceProfile();
  const bands = getAdaptiveBands();
  const active = opts?.activeSession ?? null;
  const focusScore = active?.focusScore ?? null;

  const openTasks = getCount("SELECT COUNT(*) as c FROM tasks WHERE status IN ('todo','doing')");
  const overdueTasks = getCount(`
    SELECT COUNT(*) as c FROM tasks
    WHERE status NOT IN ('done','cancelled') AND due_date < date('now')
  `);
  const doingTasks = getStrings(`
    SELECT title FROM tasks
    WHERE status = 'doing'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 3
  `);
  const uncheckedHabits = getStrings(`
    SELECT COALESCE(icon || ' ' || name, name) as label FROM habits h
    WHERE h.archived = 0
      AND h.id NOT IN (
        SELECT habit_id FROM habit_checkins WHERE date = ? AND completed = 1
      )
    ORDER BY h.id ASC
    LIMIT 5
  `, [date], 'label');
  const calendarEvents = getStrings(`
    SELECT title FROM calendar_events
    WHERE date(start_time, 'localtime') = ?
    ORDER BY start_time ASC
    LIMIT 5
  `, [date]);
  const recentAlerts = getCount(`
    SELECT COUNT(*) as c FROM alerts
    WHERE created_at >= datetime('now', '-2 hours')
  `);
  const corrections30d = getCount(`
    SELECT COUNT(*) as c FROM agent_action_outcomes
    WHERE was_corrected = 1
      AND created_at >= datetime('now', '-30 days')
  `);
  const helpfulRate = getHelpfulRate();
  const plannedFocus = getPlannedFocusContext(date);
  const activityStats = getDailyActivityStats(getDb(), date);
  const explicitState = getExplicitTodayState(date);
  const standupGoalToday = getTodayStandupGoal(date);
  const coaching = getCoachingState();
  const energy = explicitState.energy ?? 'medium';
  const mood = explicitState.mood;

  const moment = deriveMoment({
    hour,
    openTasks,
    overdueTasks,
    uncheckedHabits: uncheckedHabits.length,
    energy,
    mood,
    focusScore,
    focusGood: bands.focusGood,
    peakFocusHours: profile.peakFocusHours,
    engagement: coaching.engagement,
  });

  const generatedAt = now.toISOString();
  const partialForCoach: PersonalizationSnapshot = {
    surface,
    generatedAt,
    today: {
      date,
      hour,
      dayPhase: dayPhase(hour),
      openTasks,
      overdueTasks,
      doingTasks,
      uncheckedHabits,
      calendarEvents,
      recentDistractionMinutes: getRecentDistractionMinutes(),
      activitySignal: {
        productiveMinutes: activityStats.productive_minutes,
        distractionMinutes: activityStats.distraction_minutes,
        neutralMinutes: activityStats.neutral_minutes,
        totalMinutes: activityStats.total_minutes,
      },
      plannedFocus,
    },
    userState: {
      narrative: profile.currentNarrative,
      standupGoal: standupGoalToday,
      mood,
      energy,
      moodSource: mood ? 'explicit_checkin' : 'unknown',
      energySource: explicitState.energy ? 'explicit_checkin' : 'baseline',
      stateUpdatedAt: explicitState.updatedAt,
      coachingStyle: profile.preferredCoachingStyle,
      focusTrend: profile.focusTrend,
      peakFocusHours: profile.peakFocusHours,
      nextBestFocusWindow: profile.nextBestFocusWindow,
    },
    activeSession: active ? {
      sessionId: active.sessionId,
      targetTitle: active.targetTitle,
      focusScore,
      elapsedMinutes: active.elapsedMinutes,
    } : null,
    feedback: {
      alertFatigueLevel: recentAlerts >= 5 ? 'high' : recentAlerts >= 3 ? 'medium' : 'low',
      recentAlerts,
      helpfulRate,
      corrections30d,
    },
    coaching: {
      engagement: coaching.engagement,
      coverage: coaching.coverage,
      reason: coaching.reason,
      evidence: coaching.evidence,
    },
    moment,
    // filled below after coach/traits — placeholder satisfies type during construction
    cognitive: null as unknown as PersonalizationSnapshot['cognitive'],
    intelligenceContext: '',
    memoryContext: '',
  };

  const traits = computeCognitiveTraits({ windowDays: 45 });
  const experiments = getCognitiveExperimentState();
  const activeCoach = getActiveCoachPolicy({ traits, snapshot: partialForCoach });
  const trajectory = getCognitiveTrajectory({ historyLimit: 90 });
  const contextBlock = [
    formatCognitiveTraitsForPrompt(traits),
    formatExperimentForPrompt(experiments),
    formatActiveCoachForPrompt(activeCoach),
  ].filter(Boolean).join('\n');

  return {
    ...partialForCoach,
    cognitive: {
      traits,
      activeCoach,
      trajectory,
      experiments,
      contextBlock,
    },
    intelligenceContext: getIntelligenceContext({
      maxInsights: opts?.maxInsights ?? 3,
      includeToday: true,
      includeThresholds: opts?.includeThresholds ?? false,
    }),
    memoryContext: getMemoryContext(opts?.includeMemoryFacts ?? 6),
  };
}

/**
 * Recompute coach policy after moment/energy overrides (e.g. next-day planning).
 * Keeps traits/trajectory; refreshes activeCoach for the new moment.
 */
export function refreshCognitiveOnSnapshot(snapshot: PersonalizationSnapshot): PersonalizationSnapshot {
  if (!snapshot.cognitive) return snapshot;
  const activeCoach = getActiveCoachPolicy({
    traits: snapshot.cognitive.traits,
    snapshot,
  });
  const experiments = snapshot.cognitive.experiments ?? getCognitiveExperimentState();
  const contextBlock = [
    formatCognitiveTraitsForPrompt(snapshot.cognitive.traits),
    formatExperimentForPrompt(experiments),
    formatActiveCoachForPrompt(activeCoach),
  ].filter(Boolean).join('\n');
  return {
    ...snapshot,
    cognitive: {
      ...snapshot.cognitive,
      activeCoach,
      experiments,
      contextBlock,
    },
  };
}

function joinList(items: string[], fallback = 'none'): string {
  return items.length ? items.join(' | ') : fallback;
}

export function formatPersonalizationContext(snapshot: PersonalizationSnapshot): string {
  const helpful = snapshot.feedback.helpfulRate === null
    ? 'not enough feedback yet'
    : `${Math.round(snapshot.feedback.helpfulRate * 100)}% helpful`;

  return [
    '=== PERSONALIZATION DIRECTIVE ===',
    'Not every day is the same. Adapt tone, timing, suggestions, and intervention strength to this exact day.',
    `Surface: ${snapshot.surface}`,
    `Moment mode: ${snapshot.moment.mode} - ${snapshot.moment.guidance}`,
    '',
    '=== TODAY ===',
    `Date/hour: ${snapshot.today.date} ${snapshot.today.hour}:00 (${snapshot.today.dayPhase})`,
    `Open tasks: ${snapshot.today.openTasks}; overdue: ${snapshot.today.overdueTasks}`,
    `Doing now: ${joinList(snapshot.today.doingTasks)}`,
    `Unchecked habits: ${joinList(snapshot.today.uncheckedHabits)}`,
    `Calendar: ${joinList(snapshot.today.calendarEvents)}`,
    `Recent distraction: ${snapshot.today.recentDistractionMinutes} min in last 2h`,
    `Verified activity signal today: ${snapshot.today.activitySignal.productiveMinutes}m productive, ${snapshot.today.activitySignal.distractionMinutes}m distraction, ${snapshot.today.activitySignal.neutralMinutes}m neutral (${snapshot.today.activitySignal.totalMinutes}m total). Treat neutral as unknown context, not failure.`,
    `Planned focus: ${snapshot.today.plannedFocus.completedToday}/${snapshot.today.plannedFocus.plannedToday} completed today; ${snapshot.today.plannedFocus.skippedToday} skipped; next ${snapshot.today.plannedFocus.nextTitle ? `${snapshot.today.plannedFocus.nextTitle} (${snapshot.today.plannedFocus.nextMinutes}m)` : 'none'}`,
    snapshot.today.plannedFocus.recentFollowThroughRate === null
      ? 'Planned focus follow-through: not enough resolved blocks yet'
      : `Planned focus follow-through: ${Math.round(snapshot.today.plannedFocus.recentFollowThroughRate * 100)}% over recent resolved blocks`,
    '',
    '=== USER STATE ===',
    snapshot.userState.narrative ? `Narrative: ${snapshot.userState.narrative}` : 'Narrative: none yet',
    snapshot.userState.standupGoal ? `Today stated goal: ${snapshot.userState.standupGoal}` : 'Today stated goal: none',
    `Energy/mood: ${snapshot.userState.energy}/${snapshot.userState.mood ?? 'unknown'}`,
    `Coaching style: ${snapshot.userState.coachingStyle}; focus trend: ${snapshot.userState.focusTrend}`,
    `Peak focus hours: ${joinList(snapshot.userState.peakFocusHours.map(String))}`,
    snapshot.userState.nextBestFocusWindow ? `Next best focus window: ${snapshot.userState.nextBestFocusWindow}` : '',
    snapshot.activeSession
      ? `Active session: ${snapshot.activeSession.targetTitle} (${snapshot.activeSession.elapsedMinutes}m, focus ${snapshot.activeSession.focusScore ?? 'unknown'})`
      : 'Active session: none',
    '',
    '=== FEEDBACK LOOP ===',
    `Alert fatigue: ${snapshot.feedback.alertFatigueLevel} (${snapshot.feedback.recentAlerts} alerts in 2h)`,
    `Agent helpful rate: ${helpful}; corrections in 30d: ${snapshot.feedback.corrections30d}`,
    `Coaching state: ${snapshot.coaching.engagement}; evidence coverage: ${snapshot.coaching.coverage}`,
    `Coaching reason: ${snapshot.coaching.reason}`,
    '',
    // Prefer structured snapshot.cognitive (single source of truth) — never invent a second map
    snapshot.cognitive?.contextBlock
      || [
        formatCognitiveTraitsForPrompt(computeCognitiveTraits({ windowDays: 45 })),
        formatExperimentForPrompt(getCognitiveExperimentState()),
        formatActiveCoachForPrompt(getActiveCoachPolicy({ snapshot })),
      ].filter(Boolean).join('\n'),
    '',
    snapshot.intelligenceContext,
    snapshot.memoryContext,
  ].filter(Boolean).join('\n');
}
