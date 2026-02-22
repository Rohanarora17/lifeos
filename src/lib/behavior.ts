// LifeOS — Advanced Behavioral Intelligence Engine
// Research-grade algorithms for focus detection, context switching,
// consistency scoring, flow states, and goal alignment.
//
// Inspired by: RescueTime focus scoring, Forest app deep work detection,
// Gloria Mark's context-switching research (23-min refocus cost),
// Shannon entropy for attention scattering, and Atomic Habits consistency models.

import { getDb, getSetting } from './db';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ============================================================
//  1. FOCUS DEPTH SCORING
//     Classifies work sessions into deep/moderate/shallow/fragmented
//     based on duration, tab switches, and context switches.
// ============================================================

interface FocusSession {
  startTime: string;
  endTime: string;
  durationMinutes: number;
  tabSwitches: number;
  contextSwitches: number; // switches between productive ↔ distraction
  primaryDomain: string;
  primaryCategory: string;
  focusType: 'deep' | 'moderate' | 'shallow' | 'fragmented';
  flowStateDetected: boolean;
}

// Thresholds (based on Cal Newport's Deep Work + Gloria Mark's research)
const FOCUS_THRESHOLDS = {
  DEEP_MIN_MINUTES: 25,        // Pomodoro baseline
  DEEP_MAX_SWITCHES_PER_HOUR: 3,
  MODERATE_MIN_MINUTES: 15,
  MODERATE_MAX_SWITCHES_PER_HOUR: 8,
  SHALLOW_MAX_MINUTES: 15,
  FLOW_MIN_MINUTES: 45,        // Flow state requires 45+ min uninterrupted
  FLOW_MAX_SWITCHES: 2,        // Almost zero switching
  CONTEXT_SWITCH_COST_MINUTES: 23, // Gloria Mark's research: each switch costs ~23 min of refocus
};

/**
 * Compute focus sessions from raw activity data.
 * Groups consecutive productive activities into sessions, counts switches,
 * and classifies each session's depth level.
 */
export function computeFocusSessions(date: string): FocusSession[] {
  const db = getDb();

  // Get all activities for the day, ordered chronologically
  const activities = db.prepare(`
    SELECT id, domain, category, started_at, ended_at, duration_seconds
    FROM activities
    WHERE date(started_at) = ? AND duration_seconds > 0
    ORDER BY started_at ASC
  `).all(date) as {
    id: number; domain: string; category: string;
    started_at: string; ended_at: string; duration_seconds: number;
  }[];

  if (activities.length < 2) return [];

  const sessions: FocusSession[] = [];
  let sessionStart = activities[0].started_at;
  let sessionActivities: typeof activities = [activities[0]];
  let tabSwitches = 0;
  let contextSwitches = 0;

  for (let i = 1; i < activities.length; i++) {
    const prev = activities[i - 1];
    const curr = activities[i];

    // Gap detection: if more than 5 min gap, end session
    const gap = (new Date(curr.started_at).getTime() - new Date(prev.ended_at || prev.started_at).getTime()) / 60000;

    if (gap > 5) {
      // Finalize current session
      const session = finalizeSession(sessionStart, prev.ended_at || prev.started_at, sessionActivities, tabSwitches, contextSwitches);
      if (session.durationMinutes >= 2) sessions.push(session);

      // Start new session
      sessionStart = curr.started_at;
      sessionActivities = [curr];
      tabSwitches = 0;
      contextSwitches = 0;
    } else {
      // Same session — count switches
      if (curr.domain !== prev.domain) tabSwitches++;
      if (curr.category !== prev.category) contextSwitches++;
      sessionActivities.push(curr);
    }
  }

  // Finalize last session
  const lastAct = activities[activities.length - 1];
  const session = finalizeSession(sessionStart, lastAct.ended_at || lastAct.started_at, sessionActivities, tabSwitches, contextSwitches);
  if (session.durationMinutes >= 2) sessions.push(session);

  return sessions;
}

function finalizeSession(
  startTime: string, endTime: string,
  activities: { domain: string; category: string; duration_seconds: number }[],
  tabSwitches: number, contextSwitches: number
): FocusSession {
  const durationMinutes = Math.round(
    (new Date(endTime).getTime() - new Date(startTime).getTime()) / 60000
  );

  // Find primary domain (most time spent)
  const domainTime: Record<string, number> = {};
  const categoryTime: Record<string, number> = {};
  for (const a of activities) {
    domainTime[a.domain] = (domainTime[a.domain] || 0) + a.duration_seconds;
    categoryTime[a.category] = (categoryTime[a.category] || 0) + a.duration_seconds;
  }
  const primaryDomain = Object.entries(domainTime).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const primaryCategory = Object.entries(categoryTime).sort((a, b) => b[1] - a[1])[0]?.[0] || 'neutral';

  // Switches per hour
  const hoursInSession = Math.max(durationMinutes / 60, 0.1);
  const switchesPerHour = tabSwitches / hoursInSession;

  // Classify focus depth
  let focusType: FocusSession['focusType'] = 'shallow';
  let flowStateDetected = false;

  if (
    durationMinutes >= FOCUS_THRESHOLDS.FLOW_MIN_MINUTES &&
    tabSwitches <= FOCUS_THRESHOLDS.FLOW_MAX_SWITCHES &&
    primaryCategory === 'productive'
  ) {
    focusType = 'deep';
    flowStateDetected = true;
  } else if (
    durationMinutes >= FOCUS_THRESHOLDS.DEEP_MIN_MINUTES &&
    switchesPerHour <= FOCUS_THRESHOLDS.DEEP_MAX_SWITCHES_PER_HOUR &&
    primaryCategory === 'productive'
  ) {
    focusType = 'deep';
  } else if (
    durationMinutes >= FOCUS_THRESHOLDS.MODERATE_MIN_MINUTES &&
    switchesPerHour <= FOCUS_THRESHOLDS.MODERATE_MAX_SWITCHES_PER_HOUR
  ) {
    focusType = 'moderate';
  } else if (switchesPerHour > 20 || contextSwitches > tabSwitches * 0.5) {
    focusType = 'fragmented';
  }

  return {
    startTime, endTime, durationMinutes,
    tabSwitches, contextSwitches,
    primaryDomain, primaryCategory,
    focusType, flowStateDetected,
  };
}

/**
 * Compute daily focus score (0-100).
 * Weighted composite: deep work time, flow states, low context switches.
 */
export function computeFocusScore(sessions: FocusSession[]): {
  score: number;
  deepMinutes: number;
  flowMinutes: number;
  fragmentedMinutes: number;
  totalSwitches: number;
  contextSwitchCost: number; // estimated lost time from context switches
  focusRatio: number;
} {
  let deepMinutes = 0, moderateMinutes = 0, shallowMinutes = 0, fragmentedMinutes = 0;
  let flowMinutes = 0, totalSwitches = 0, totalContextSwitches = 0;
  let totalMinutes = 0;

  for (const s of sessions) {
    totalMinutes += s.durationMinutes;
    totalSwitches += s.tabSwitches;
    totalContextSwitches += s.contextSwitches;

    switch (s.focusType) {
      case 'deep': deepMinutes += s.durationMinutes; break;
      case 'moderate': moderateMinutes += s.durationMinutes; break;
      case 'shallow': shallowMinutes += s.durationMinutes; break;
      case 'fragmented': fragmentedMinutes += s.durationMinutes; break;
    }
    if (s.flowStateDetected) flowMinutes += s.durationMinutes;
  }

  // Context switch cost (Gloria Mark: each cross-category switch ≈ 23 min lost)
  const contextSwitchCost = totalContextSwitches * FOCUS_THRESHOLDS.CONTEXT_SWITCH_COST_MINUTES;

  // Focus ratio: deep+moderate vs total
  const focusRatio = totalMinutes > 0 ? (deepMinutes + moderateMinutes) / totalMinutes : 0;

  // Score calculation:
  // 40% deep work ratio, 20% flow bonuses, 20% low fragmentation, 20% low switch cost
  const deepScore = Math.min(1, (deepMinutes + moderateMinutes * 0.5) / Math.max(totalMinutes * 0.6, 1)) * 40;
  const flowScore = (flowMinutes > 0 ? Math.min(1, flowMinutes / 90) : 0) * 20;
  const fragScore = totalMinutes > 0 ? (1 - fragmentedMinutes / totalMinutes) * 20 : 20;
  const switchScore = Math.max(0, 1 - (contextSwitchCost / Math.max(totalMinutes, 60))) * 20;

  const score = Math.round(deepScore + flowScore + fragScore + switchScore);

  return {
    score: Math.min(100, Math.max(0, score)),
    deepMinutes, flowMinutes, fragmentedMinutes,
    totalSwitches, contextSwitchCost: Math.round(contextSwitchCost),
    focusRatio: Math.round(focusRatio * 100) / 100,
  };
}


// ============================================================
//  2. CONTEXT SWITCHING — SHANNON ENTROPY
//     Measures how scattered attention is across domains.
//     Low entropy = focused on few things. High = scattered.
// ============================================================

export interface EntropyResult {
  entropy: number;        // 0-∞, lower = more focused
  normalizedEntropy: number; // 0-1, scaled to max possible
  uniqueDomains: number;
  switchesPerHour: number;
  rapidBursts: number;    // switches < 30s apart (panic-switching)
  topSwitchPairs: { from: string; to: string; count: number }[];
  classification: 'laser-focused' | 'focused' | 'normal' | 'scattered' | 'chaotic';
}

/**
 * Shannon entropy of domain distribution.
 * H = -Σ p(x) * log2(p(x))
 * Used by information theory to measure "surprise" — higher = more random attention.
 */
export function computeAttentionEntropy(date: string): EntropyResult {
  const db = getDb();

  const activities = db.prepare(`
    SELECT domain, duration_seconds, started_at
    FROM activities
    WHERE date(started_at) = ? AND duration_seconds > 0
    ORDER BY started_at ASC
  `).all(date) as { domain: string; duration_seconds: number; started_at: string }[];

  if (activities.length === 0) {
    return {
      entropy: 0, normalizedEntropy: 0, uniqueDomains: 0,
      switchesPerHour: 0, rapidBursts: 0, topSwitchPairs: [],
      classification: 'laser-focused',
    };
  }

  // Domain time distribution for entropy
  const domainTime: Record<string, number> = {};
  let totalTime = 0;
  for (const a of activities) {
    domainTime[a.domain] = (domainTime[a.domain] || 0) + a.duration_seconds;
    totalTime += a.duration_seconds;
  }

  const uniqueDomains = Object.keys(domainTime).length;

  // Shannon entropy
  let entropy = 0;
  for (const time of Object.values(domainTime)) {
    const p = time / totalTime;
    if (p > 0) entropy -= p * Math.log2(p);
  }

  // Normalize: max entropy = log2(N) where N = unique domains
  const maxEntropy = uniqueDomains > 1 ? Math.log2(uniqueDomains) : 1;
  const normalizedEntropy = maxEntropy > 0 ? entropy / maxEntropy : 0;

  // Tab switch analysis
  let switches = 0;
  let rapidBursts = 0;
  const switchPairs: Record<string, number> = {};

  for (let i = 1; i < activities.length; i++) {
    if (activities[i].domain !== activities[i - 1].domain) {
      switches++;
      const pair = `${activities[i - 1].domain}→${activities[i].domain}`;
      switchPairs[pair] = (switchPairs[pair] || 0) + 1;

      // Rapid burst: switch happened < 30 seconds after previous activity started
      const timeSince = (
        new Date(activities[i].started_at).getTime() -
        new Date(activities[i - 1].started_at).getTime()
      ) / 1000;
      if (timeSince < 30) rapidBursts++;
    }
  }

  const totalHours = Math.max(totalTime / 3600, 0.1);
  const switchesPerHour = switches / totalHours;

  const topSwitchPairs = Object.entries(switchPairs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pair, count]) => {
      const [from, to] = pair.split('→');
      return { from, to, count };
    });

  // Classification
  let classification: EntropyResult['classification'] = 'normal';
  if (normalizedEntropy < 0.2 && switchesPerHour < 5) classification = 'laser-focused';
  else if (normalizedEntropy < 0.4 && switchesPerHour < 10) classification = 'focused';
  else if (normalizedEntropy > 0.8 || switchesPerHour > 30) classification = 'chaotic';
  else if (normalizedEntropy > 0.6 || switchesPerHour > 20) classification = 'scattered';

  return {
    entropy: Math.round(entropy * 100) / 100,
    normalizedEntropy: Math.round(normalizedEntropy * 100) / 100,
    uniqueDomains, switchesPerHour: Math.round(switchesPerHour * 10) / 10,
    rapidBursts, topSwitchPairs, classification,
  };
}


// ============================================================
//  3. UNIFIED CONSISTENCY INDEX (UCI)
//     Multi-dimensional consistency across work, habits, tasks, focus.
//     Uses Coefficient of Variation (CV) — lower CV = more consistent.
// ============================================================

export interface ConsistencyResult {
  overallScore: number;       // 0-100 composite
  dimensions: {
    work: { score: number; cv: number; trend: string; data: number[] };
    habits: { score: number; rate: number; streakCurrent: number; streakLongest: number };
    tasks: { score: number; completionRate: number; avgPerDay: number };
    focus: { score: number; avgDeepMinutes: number; cv: number };
    timing: { score: number; avgStartHour: number; cv: number };
  };
  streakDays: number;
  trend: 'improving' | 'declining' | 'stable';
  weekOverWeek: number; // % change vs last week
}

/**
 * Unified Consistency Index.
 * Measures regularity across 5 dimensions using CV (std_dev / mean).
 * Inspired by Atomic Habits' "don't break the chain" + statistical process control.
 */
export function computeConsistencyIndex(days: number = 30): ConsistencyResult {
  const db = getDb();

  // ── Work consistency (daily productive minutes) ──
  const dailyWork = db.prepare(`
    SELECT date(started_at) as d,
      SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) / 60 as productive_mins
    FROM activities
    WHERE started_at >= datetime('now', '-${days} days')
    GROUP BY d ORDER BY d
  `).all() as { d: string; productive_mins: number }[];

  const workValues = dailyWork.map(d => d.productive_mins);
  const workCV = coefficientOfVariation(workValues);
  const workScore = cvToScore(workCV);

  // Trend: EMA comparison (last 7 vs previous 7)
  const workTrend = computeTrend(workValues);

  // Week-over-week
  const thisWeek = workValues.slice(-7).reduce((a, b) => a + b, 0);
  const lastWeek = workValues.slice(-14, -7).reduce((a, b) => a + b, 0);
  const weekOverWeek = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : 0;

  // ── Habit consistency ──
  const habitCount = (db.prepare('SELECT COUNT(*) as c FROM habits WHERE archived = 0').get() as { c: number }).c;
  const habitCheckins = db.prepare(`
    SELECT date, COUNT(*) as completed
    FROM habit_checkins
    WHERE date >= date('now', '-${days} days') AND completed = 1
    GROUP BY date
  `).all() as { date: string; completed: number }[];

  const habitRates = habitCheckins.map(h => habitCount > 0 ? h.completed / habitCount : 0);
  const avgHabitRate = habitRates.length > 0 ? habitRates.reduce((a, b) => a + b, 0) / habitRates.length : 0;

  // Streaks
  const { current: streakCurrent, longest: streakLongest } = computeHabitStreak(days);
  const habitScore = Math.round(avgHabitRate * 60 + Math.min(streakCurrent / days, 1) * 40);

  // ── Task consistency ──
  const tasksByDay = db.prepare(`
    SELECT date(completed_at) as d, COUNT(*) as c
    FROM tasks
    WHERE completed_at IS NOT NULL AND completed_at >= datetime('now', '-${days} days')
    GROUP BY d
  `).all() as { d: string; c: number }[];

  const taskValues = tasksByDay.map(t => t.c);
  const taskTotal = (db.prepare(
    `SELECT COUNT(*) as c FROM tasks WHERE created_at >= datetime('now', '-${days} days')`
  ).get() as { c: number }).c;
  const taskCompleted = taskValues.reduce((a, b) => a + b, 0);
  const taskCompletionRate = taskTotal > 0 ? taskCompleted / taskTotal : 0;
  const taskScore = Math.round(taskCompletionRate * 70 + Math.min(cvToScore(coefficientOfVariation(taskValues)) * 0.3, 30));

  // ── Focus consistency (daily deep work minutes) ──
  const focusByDay = db.prepare(`
    SELECT session_date, SUM(duration_minutes) as deep_mins
    FROM focus_sessions
    WHERE session_date >= date('now', '-${days} days') AND focus_type IN ('deep', 'moderate')
    GROUP BY session_date
  `).all() as { session_date: string; deep_mins: number }[];

  const focusValues = focusByDay.map(f => f.deep_mins);
  const focusCV = coefficientOfVariation(focusValues);
  const avgDeepMinutes = focusValues.length > 0 ? Math.round(focusValues.reduce((a, b) => a + b, 0) / focusValues.length) : 0;
  const focusScore = cvToScore(focusCV);

  // ── Timing consistency (when do they start working each day?) ──
  const startTimes = db.prepare(`
    SELECT date(started_at) as d, MIN(CAST(strftime('%H', started_at) AS REAL) + CAST(strftime('%M', started_at) AS REAL) / 60) as start_hour
    FROM activities
    WHERE started_at >= datetime('now', '-${days} days') AND category = 'productive'
    GROUP BY d
  `).all() as { d: string; start_hour: number }[];

  const startHours = startTimes.map(s => s.start_hour);
  const timingCV = coefficientOfVariation(startHours);
  const avgStartHour = startHours.length > 0 ? startHours.reduce((a, b) => a + b, 0) / startHours.length : 9;
  const timingScore = cvToScore(timingCV);

  // ── Overall composite ──
  // Weights: work 30%, habits 25%, tasks 15%, focus 20%, timing 10%
  const overallScore = Math.round(
    workScore * 0.30 + habitScore * 0.25 + taskScore * 0.15 +
    focusScore * 0.20 + timingScore * 0.10
  );

  // Daily streak (days with productive activity)
  const activeDates = db.prepare(`
    SELECT DISTINCT date(started_at) as d
    FROM activities
    WHERE category = 'productive'
    ORDER BY d DESC
  `).all() as { d: string }[];

  let streakDays = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < activeDates.length; i++) {
    const expected = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    if (activeDates[i]?.d === expected) {
      streakDays++;
    } else {
      break;
    }
  }

  return {
    overallScore: Math.min(100, Math.max(0, overallScore)),
    dimensions: {
      work: { score: workScore, cv: workCV, trend: workTrend, data: workValues },
      habits: { score: habitScore, rate: Math.round(avgHabitRate * 100) / 100, streakCurrent, streakLongest },
      tasks: { score: taskScore, completionRate: Math.round(taskCompletionRate * 100) / 100, avgPerDay: taskValues.length > 0 ? Math.round(taskValues.reduce((a, b) => a + b, 0) / taskValues.length * 10) / 10 : 0 },
      focus: { score: focusScore, avgDeepMinutes, cv: focusCV },
      timing: { score: timingScore, avgStartHour: Math.round(avgStartHour * 10) / 10, cv: timingCV },
    },
    streakDays,
    trend: workTrend as 'improving' | 'declining' | 'stable',
    weekOverWeek,
  };
}


// ============================================================
//  4. GOAL ALIGNMENT ENGINE
//     Compares actual behavior against user-defined goals.
// ============================================================

export interface GoalProgress {
  id: number;
  title: string;
  type: string;
  metric: string;
  targetValue: number;
  currentValue: number;
  unit: string;
  progress: number; // 0-1
  onTrack: boolean;
  trend: string;
}

export function computeGoalAlignment(): {
  goals: GoalProgress[];
  alignmentScore: number; // 0-100
} {
  const db = getDb();
  const goals = db.prepare('SELECT * FROM goals WHERE active = 1').all() as {
    id: number; title: string; type: string; metric: string;
    target_value: number; unit: string; category: string;
  }[];

  if (goals.length === 0) {
    return { goals: [], alignmentScore: 50 }; // neutral if no goals set
  }

  const results: GoalProgress[] = [];

  for (const goal of goals) {
    const currentValue = measureGoalMetric(goal.metric, goal.type);
    const progress = Math.min(currentValue / Math.max(goal.target_value, 0.01), 1);
    const onTrack = progress >= 0.8;

    // Trend: compare current period vs previous period
    const prevValue = measureGoalMetric(goal.metric, goal.type, true);
    const trend = currentValue > prevValue * 1.05 ? 'improving' :
      currentValue < prevValue * 0.95 ? 'declining' : 'stable';

    results.push({
      id: goal.id,
      title: goal.title,
      type: goal.type,
      metric: goal.metric,
      targetValue: goal.target_value,
      currentValue: Math.round(currentValue * 10) / 10,
      unit: goal.unit,
      progress: Math.round(progress * 100) / 100,
      onTrack,
      trend,
    });
  }

  const alignmentScore = Math.round(
    results.reduce((sum, g) => sum + Math.min(g.progress, 1), 0) / results.length * 100
  );

  return { goals: results, alignmentScore };
}

function measureGoalMetric(metric: string, period: string, previous: boolean = false): number {
  const db = getDb();
  const offset = previous ? (period === 'daily' ? '-2 days' : period === 'weekly' ? '-14 days' : '-60 days') : '0 days';
  const range = period === 'daily' ? '-1 days' : period === 'weekly' ? '-7 days' : '-30 days';
  const baseOffset = previous ? (period === 'daily' ? '-1 days' : period === 'weekly' ? '-7 days' : '-30 days') : '0 days';

  const start = `datetime('now', '${range}', '${offset}')`;
  const end = `datetime('now', '${baseOffset}')`;

  switch (metric) {
    case 'productive_minutes': {
      const r = db.prepare(`
        SELECT COALESCE(SUM(duration_seconds), 0) / 60 as v
        FROM activities WHERE category = 'productive'
        AND started_at >= ${start} AND started_at < ${end}
      `).get() as { v: number };
      return r.v;
    }
    case 'deep_work_minutes': {
      const r = db.prepare(`
        SELECT COALESCE(SUM(duration_minutes), 0) as v
        FROM focus_sessions WHERE focus_type IN ('deep')
        AND session_date >= date('now', '${range}', '${offset}') AND session_date < date('now', '${baseOffset}')
      `).get() as { v: number };
      return r.v;
    }
    case 'tasks_completed': {
      const r = db.prepare(`
        SELECT COUNT(*) as v FROM tasks
        WHERE status = 'done' AND completed_at >= ${start} AND completed_at < ${end}
      `).get() as { v: number };
      return r.v;
    }
    case 'habits_completed': {
      const r = db.prepare(`
        SELECT COUNT(*) as v FROM habit_checkins
        WHERE completed = 1
        AND date >= date('now', '${range}', '${offset}') AND date < date('now', '${baseOffset}')
      `).get() as { v: number };
      return r.v;
    }
    case 'distraction_minutes': {
      const r = db.prepare(`
        SELECT COALESCE(SUM(duration_seconds), 0) / 60 as v
        FROM activities WHERE category = 'distraction'
        AND started_at >= ${start} AND started_at < ${end}
      `).get() as { v: number };
      return r.v;
    }
    case 'focus_score': {
      // Average focus score over the period
      return 50; // computed separately
    }
    case 'github_commits': {
      const r = db.prepare(`
        SELECT COUNT(*) as v FROM github_activity
        WHERE type = 'commit'
        AND created_at >= ${start} AND created_at < ${end}
      `).get() as { v: number };
      return r.v;
    }
    default:
      return 0;
  }
}


// ============================================================
//  5. BEHAVIORAL ARCHETYPE CLASSIFICATION
//     Classifies user's work style based on patterns.
// ============================================================

export interface Archetype {
  primary: string;
  description: string;
  chronotype: string;         // 'early-bird' | 'night-owl' | 'midday-peak'
  workStyle: string;          // 'deep-diver' | 'multitasker' | 'sprinter' | 'marathoner'
  consistencyType: string;    // 'clockwork' | 'burst-worker' | 'irregular'
  focusProfile: string;       // 'flow-chaser' | 'structured' | 'scattered'
  strengths: string[];
  challenges: string[];
}

export function classifyArchetype(days: number = 30): Archetype {
  const db = getDb();

  // Chronotype: when is peak productivity?
  const hourly = db.prepare(`
    SELECT CAST(strftime('%H', started_at) AS INTEGER) as h,
      SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) as prod
    FROM activities WHERE started_at >= datetime('now', '-${days} days')
    GROUP BY h
  `).all() as { h: number; prod: number }[];

  const morningProd = hourly.filter(h => h.h >= 6 && h.h < 12).reduce((s, h) => s + h.prod, 0);
  const afternoonProd = hourly.filter(h => h.h >= 12 && h.h < 18).reduce((s, h) => s + h.prod, 0);
  const eveningProd = hourly.filter(h => h.h >= 18 || h.h < 6).reduce((s, h) => s + h.prod, 0);

  let chronotype = 'midday-peak';
  if (morningProd > afternoonProd && morningProd > eveningProd) chronotype = 'early-bird';
  else if (eveningProd > morningProd && eveningProd > afternoonProd) chronotype = 'night-owl';

  // Work style: session duration distribution
  const sessionDurations = db.prepare(`
    SELECT duration_minutes, focus_type FROM focus_sessions
    WHERE session_date >= date('now', '-${days} days')
  `).all() as { duration_minutes: number; focus_type: string }[];

  const avgSessionDuration = sessionDurations.length > 0
    ? sessionDurations.reduce((s, d) => s + d.duration_minutes, 0) / sessionDurations.length
    : 15;

  const deepSessions = sessionDurations.filter(s => s.focus_type === 'deep').length;
  const fragmentedSessions = sessionDurations.filter(s => s.focus_type === 'fragmented').length;

  let workStyle = 'sprinter';
  if (avgSessionDuration > 45 && deepSessions > sessionDurations.length * 0.3) workStyle = 'deep-diver';
  else if (avgSessionDuration > 25) workStyle = 'marathoner';
  else if (fragmentedSessions > sessionDurations.length * 0.4) workStyle = 'multitasker';

  // Consistency type
  const dailyProd = db.prepare(`
    SELECT date(started_at) as d,
      SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) / 60 as mins
    FROM activities WHERE started_at >= datetime('now', '-${days} days')
    GROUP BY d
  `).all() as { d: string; mins: number }[];

  const cv = coefficientOfVariation(dailyProd.map(d => d.mins));
  let consistencyType = 'irregular';
  if (cv < 0.3) consistencyType = 'clockwork';
  else if (cv < 0.6) consistencyType = 'burst-worker';

  // Focus profile
  let focusProfile = 'structured';
  if (deepSessions > 0 && sessionDurations.some(s => s.duration_minutes > 60)) focusProfile = 'flow-chaser';
  else if (fragmentedSessions > deepSessions) focusProfile = 'scattered';

  // Build archetype
  const archetypeName = `${chronotype === 'early-bird' ? 'Morning' : chronotype === 'night-owl' ? 'Night' : 'Afternoon'} ${workStyle === 'deep-diver' ? 'Deep Diver' : workStyle === 'marathoner' ? 'Marathoner' : workStyle === 'multitasker' ? 'Multitasker' : 'Sprinter'}`;

  const strengths: string[] = [];
  const challenges: string[] = [];

  if (workStyle === 'deep-diver') strengths.push('Can sustain long, focused work sessions');
  if (workStyle === 'sprinter') { strengths.push('Quick bursts of intense focus'); challenges.push('May struggle with sustained deep work'); }
  if (consistencyType === 'clockwork') strengths.push('Very consistent daily routine');
  if (consistencyType === 'irregular') challenges.push('Work pattern is unpredictable — hard to build momentum');
  if (chronotype === 'early-bird') strengths.push('Peak productivity in the morning — leverage this window');
  if (chronotype === 'night-owl') { strengths.push('Strong late-night focus'); challenges.push('May miss morning productive windows'); }
  if (focusProfile === 'scattered') challenges.push('High tab-switching frequency breaks concentration');
  if (focusProfile === 'flow-chaser') strengths.push('Capable of achieving flow state regularly');

  return {
    primary: archetypeName,
    description: `You are a ${archetypeName.toLowerCase()} — a ${chronotype.replace('-', ' ')} who works in ${workStyle.replace('-', ' ')} mode with ${consistencyType} consistency.`,
    chronotype, workStyle, consistencyType, focusProfile,
    strengths, challenges,
  };
}


// ============================================================
//  6. PROFILE & CONTEXT BUILDER
// ============================================================

export function getProfile(): Record<string, unknown> {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM behavior_profile').all() as { key: string; value: string }[];
  const profile: Record<string, unknown> = {};
  for (const row of rows) {
    try { profile[row.key] = JSON.parse(row.value); }
    catch { profile[row.key] = row.value; }
  }
  return profile;
}

export function setProfileValue(key: string, value: unknown, confidence: number = 0.5) {
  const db = getDb();
  const strValue = typeof value === 'string' ? value : JSON.stringify(value);

  // Progressive confidence: if this key was seen before, blend old and new confidence
  const existing = db.prepare('SELECT confidence, update_count FROM behavior_profile WHERE key = ?').get(key) as { confidence: number; update_count: number } | undefined;

  let finalConfidence = confidence;
  if (existing) {
    // Bayesian-inspired confidence update: each observation increases confidence
    // confidence grows towards 1.0 as more observations confirm the same value
    const n = existing.update_count + 1;
    finalConfidence = Math.min(0.98, 1 - (1 / (n + 1)));
  }

  db.prepare(`
    INSERT INTO behavior_profile (key, value, confidence, last_updated, update_count)
    VALUES (?, ?, ?, datetime('now'), 1)
    ON CONFLICT(key) DO UPDATE SET
      value = ?, confidence = ?, last_updated = datetime('now'),
      update_count = update_count + 1
  `).run(key, strValue, finalConfidence, strValue, finalConfidence);
}


// ============================================================
//  BEHAVIORAL MEMORY SYSTEM — Progressive AI Learning
//  Memories accumulate, get reinforced, and gain confidence.
//  Unlike the profile (KV store), memories are durable learnings.
// ============================================================

export interface BehavioralMemory {
  id: number;
  memory_type: string;
  content: string;
  source: string;
  confidence: number;
  reinforcement_count: number;
  first_observed: string;
  last_reinforced: string;
}

/**
 * Record a new behavioral memory or reinforce an existing one.
 * If a similar memory already exists, it gets reinforced (confidence ↑).
 */
export function learnMemory(
  type: string,
  content: string,
  source: string = 'deep_analysis',
  initialConfidence: number = 0.5
): void {
  const db = getDb();

  // Check for similar existing memory (same type, fuzzy content match)
  const existing = db.prepare(
    'SELECT id, reinforcement_count, confidence FROM behavioral_memory WHERE memory_type = ? AND content = ? AND superseded = 0'
  ).get(type, content) as { id: number; reinforcement_count: number; confidence: number } | undefined;

  if (existing) {
    // Reinforce: confidence grows logarithmically
    const newCount = existing.reinforcement_count + 1;
    const newConfidence = Math.min(0.99, 1 - (1 / (newCount + 2)));
    db.prepare(
      "UPDATE behavioral_memory SET reinforcement_count = ?, confidence = ?, last_reinforced = datetime('now') WHERE id = ?"
    ).run(newCount, newConfidence, existing.id);
  } else {
    db.prepare(
      'INSERT INTO behavioral_memory (memory_type, content, source, confidence) VALUES (?, ?, ?, ?)'
    ).run(type, content, source, initialConfidence);
  }
}

/**
 * Recall memories by type, ordered by confidence desc.
 */
export function recallMemories(type?: string, limit: number = 20): BehavioralMemory[] {
  const db = getDb();
  if (type) {
    return db.prepare(
      'SELECT * FROM behavioral_memory WHERE memory_type = ? AND superseded = 0 ORDER BY confidence DESC, reinforcement_count DESC LIMIT ?'
    ).all(type, limit) as BehavioralMemory[];
  }
  return db.prepare(
    'SELECT * FROM behavioral_memory WHERE superseded = 0 ORDER BY confidence DESC, reinforcement_count DESC LIMIT ?'
  ).all(limit) as BehavioralMemory[];
}

/**
 * Get past insights for feeding back into analysis (prevents repetition, enables building on previous work).
 */
export function getRecentInsights(limit: number = 15): { category: string; insight: string; severity: string; feedback: string | null; created_at: string }[] {
  const db = getDb();
  return db.prepare(
    'SELECT category, insight, severity, feedback, created_at FROM behavior_insights ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as { category: string; insight: string; severity: string; feedback: string | null; created_at: string }[];
}

/**
 * Record user feedback on an insight (the AI learns which insights are useful).
 */
export function feedbackOnInsight(insightId: number, feedback: 'helpful' | 'not_helpful' | 'already_known'): void {
  const db = getDb();
  db.prepare('UPDATE behavior_insights SET feedback = ?, acknowledged = 1 WHERE id = ?').run(feedback, insightId);
}

/**
 * Get historical snapshots for trend comparison.
 * The AI uses this to say "compared to last week..." or "you've improved..."
 */
export function getHistoricalSnapshots(limit: number = 7): { snapshot_date: string; data: string }[] {
  const db = getDb();
  return db.prepare(
    "SELECT snapshot_date, data FROM behavior_snapshots WHERE type = 'deep_analysis' ORDER BY snapshot_date DESC LIMIT ?"
  ).all(limit) as { snapshot_date: string; data: string }[];
}


/**
 * Build rich behavioral context for AI prompts.
 * Every AI call gets this so responses are personalized.
 * Now includes: profile + past insights + durable memories + historical trends.
 */
export function buildBehaviorContext(): string {
  const profile = getProfile();
  const parts: string[] = [];

  // ── Section 1: Core Profile ──
  if (Object.keys(profile).length > 0) {
    parts.push('--- USER BEHAVIORAL PROFILE (learned over time) ---');
    if (profile.archetype) parts.push(`Archetype: ${JSON.stringify(profile.archetype)}`);
    if (profile.personality_summary) parts.push(`Personality: ${profile.personality_summary}`);
    if (profile.work_style) parts.push(`Work style: ${profile.work_style}`);
    if (profile.chronotype) parts.push(`Chronotype: ${profile.chronotype}`);
    if (profile.focus_profile) parts.push(`Focus profile: ${profile.focus_profile}`);
    if (profile.peak_productive_hours) parts.push(`Peak hours: ${profile.peak_productive_hours}`);
    if (profile.consistency_score !== undefined) parts.push(`Consistency: ${profile.consistency_score}/100 (${profile.productive_trend || 'stable'})`);
    if (profile.focus_score !== undefined) parts.push(`Focus depth score: ${profile.focus_score}/100`);
    if (profile.common_distraction_triggers) parts.push(`Distraction triggers: ${profile.common_distraction_triggers}`);
    if (profile.ai_tone) parts.push(`Preferred tone: ${profile.ai_tone}`);
    if (profile.motivation_style) parts.push(`Motivation style: ${profile.motivation_style}`);
    if (profile.goal_alignment !== undefined) parts.push(`Goal alignment: ${profile.goal_alignment}%`);
    if (profile.strengths) parts.push(`Strengths: ${JSON.stringify(profile.strengths)}`);
    if (profile.challenges) parts.push(`Challenges: ${JSON.stringify(profile.challenges)}`);
  }

  // ── Section 2: Durable Behavioral Memories (high-confidence learnings) ──
  try {
    const memories = recallMemories(undefined, 10).filter(m => m.confidence >= 0.5);
    if (memories.length > 0) {
      parts.push('');
      parts.push('--- LEARNED BEHAVIORAL PATTERNS (accumulated over time) ---');
      for (const m of memories) {
        const conf = m.confidence >= 0.8 ? '●●●' : m.confidence >= 0.6 ? '●●○' : '●○○';
        parts.push(`[${conf}] ${m.memory_type}: ${m.content}`);
      }
    }
  } catch { /* table may not exist yet */ }

  // ── Section 3: Recent Insights (what the AI previously told the user) ──
  try {
    const recentInsights = getRecentInsights(5);
    if (recentInsights.length > 0) {
      parts.push('');
      parts.push('--- RECENT AI INSIGHTS (avoid repeating these, build on them) ---');
      for (const ins of recentInsights) {
        const fb = ins.feedback ? ` [user said: ${ins.feedback}]` : '';
        parts.push(`- [${ins.severity}] ${ins.insight}${fb}`);
      }
    }
  } catch { /* table may not exist yet */ }

  // ── Section 4: Historical Trend ──
  try {
    const snapshots = getHistoricalSnapshots(3);
    if (snapshots.length >= 2) {
      parts.push('');
      parts.push('--- HISTORICAL COMPARISON (use this to note progress or regression) ---');
      for (const s of snapshots) {
        try {
          const d = JSON.parse(s.data);
          parts.push(`${s.snapshot_date}: focus=${d.focusScore?.score || '?'}, consistency=${d.consistency?.overallScore || '?'}, alignment=${d.goalAlignment?.alignmentScore || '?'}%`);
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* table may not exist yet */ }

  // ── Section 5: Today's Calendar Context ──
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const calEvents = db.prepare(`
      SELECT title, start_time, end_time, location FROM calendar_events
      WHERE DATE(start_time) = ? ORDER BY start_time
    `).all(today) as { title: string; start_time: string; end_time: string; location: string }[];

    if (calEvents.length > 0) {
      parts.push('');
      parts.push('--- TODAY\'S CALENDAR (factor meetings into productivity analysis) ---');
      let totalMeetingMin = 0;
      for (const ev of calEvents) {
        const start = new Date(ev.start_time);
        const end = new Date(ev.end_time);
        const dur = Math.round((end.getTime() - start.getTime()) / 60000);
        totalMeetingMin += dur;
        const timeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        parts.push(`- ${timeStr}: ${ev.title} (${dur}min)${ev.location ? ` @ ${ev.location}` : ''}`);
      }
      parts.push(`Total meeting load: ${calEvents.length} events, ${Math.round(totalMeetingMin / 60)}h ${totalMeetingMin % 60}m`);
      if (totalMeetingMin > 240) {
        parts.push('⚠️ Heavy meeting day — adjust expectations for deep work');
      } else if (totalMeetingMin === 0) {
        parts.push('✅ No meetings — prime day for deep focus work');
      }
    }
  } catch { /* calendar table may not exist */ }

  if (parts.length === 0) return '';

  parts.push('');
  parts.push('--- Personalize your response using this profile. Reference patterns, compare to baseline, and build on recent insights. If user marked an insight as not_helpful, avoid similar ones. Factor in today\'s calendar when judging productivity. ---');
  return parts.join('\n');
}

export function getSmartNudgeContext(): string {
  const profile = getProfile();
  const parts: string[] = [];

  const nudgeEff = profile.nudge_effectiveness as number | undefined;
  if (nudgeEff !== undefined) {
    if (nudgeEff < 0.3) parts.push('User rarely responds to nudges — be more impactful and direct.');
    else if (nudgeEff > 0.7) parts.push('User responds well to nudges — a gentle reminder works.');
  }

  if (profile.ai_tone === 'strict') parts.push('Use a direct, no-nonsense tone.');
  else if (profile.ai_tone === 'gentle') parts.push('Be encouraging and supportive.');

  if (profile.motivation_style) parts.push(`Motivated by: ${profile.motivation_style}`);
  if (profile.chronotype) parts.push(`Chronotype: ${profile.chronotype} — factor time of day into nudge urgency.`);

  // Add high-confidence memory nudges
  try {
    const distractionMemories = recallMemories('distraction_pattern', 3);
    for (const m of distractionMemories) {
      if (m.confidence >= 0.6) parts.push(`Known pattern: ${m.content}`);
    }
  } catch { /* ignore */ }

  return parts.join('\n');
}


// ============================================================
//  7. DEEP ANALYSIS — Full behavioral analysis + AI synthesis
// ============================================================

export async function runDeepAnalysis(): Promise<{
  summary: string;
  archetype: Archetype;
  focusScore: ReturnType<typeof computeFocusScore>;
  entropy: EntropyResult;
  consistency: ConsistencyResult;
  goalAlignment: ReturnType<typeof computeGoalAlignment>;
  insights: { category: string; insight: string; tip: string; severity: string }[];
}> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  // Run all analyses
  const sessions = computeFocusSessions(today);
  const focusScore = computeFocusScore(sessions);
  const entropy = computeAttentionEntropy(today);
  const consistency = computeConsistencyIndex(30);
  const archetype = classifyArchetype(30);
  const goalAlignment = computeGoalAlignment();

  // Time patterns
  const hourly = db.prepare(`
    SELECT CAST(strftime('%H', started_at) AS INTEGER) as h,
      SUM(CASE WHEN category = 'productive' THEN duration_seconds ELSE 0 END) / 3600.0 as productive_h
    FROM activities WHERE started_at >= datetime('now', '-30 days')
    GROUP BY h ORDER BY productive_h DESC LIMIT 4
  `).all() as { h: number; productive_h: number }[];

  const peakHours = hourly.map(h => h.h).sort((a, b) => a - b);

  // Browsing patterns
  const topProductive = db.prepare(`
    SELECT domain, SUM(duration_seconds)/60 as mins FROM activities
    WHERE category='productive' AND started_at >= datetime('now', '-30 days')
    GROUP BY domain ORDER BY mins DESC LIMIT 5
  `).all() as { domain: string; mins: number }[];

  const topDistraction = db.prepare(`
    SELECT domain, SUM(duration_seconds)/60 as mins FROM activities
    WHERE category='distraction' AND started_at >= datetime('now', '-30 days')
    GROUP BY domain ORDER BY mins DESC LIMIT 5
  `).all() as { domain: string; mins: number }[];

  // Nudge response rate
  const nudgeStats = db.prepare(`
    SELECT COUNT(*) as total, SUM(acknowledged) as ack FROM nudge_log
    WHERE created_at >= datetime('now', '-30 days')
  `).get() as { total: number; ack: number };
  const nudgeEffectiveness = nudgeStats.total > 0 ? (nudgeStats.ack || 0) / nudgeStats.total : 0.5;

  // Save focus sessions
  const insertSession = db.prepare(`
    INSERT INTO focus_sessions (session_date, start_time, end_time, duration_minutes, focus_type, primary_domain, primary_category, tab_switches, context_switches, flow_state_detected)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of sessions) {
    try {
      insertSession.run(today, s.startTime, s.endTime, s.durationMinutes, s.focusType, s.primaryDomain, s.primaryCategory, s.tabSwitches, s.contextSwitches, s.flowStateDetected ? 1 : 0);
    } catch { /* ignore duplicates */ }
  }

  // Save snapshot
  const analysisData = { focusScore, entropy, consistency, archetype, goalAlignment, peakHours };
  db.prepare("INSERT INTO behavior_snapshots (snapshot_date, type, data) VALUES (?, 'deep_analysis', ?)").run(today, JSON.stringify(analysisData));

  // ── Gather historical context for AI (the learning loop) ──
  const pastInsights = getRecentInsights(10);
  const historicalSnapshots = getHistoricalSnapshots(5);
  const existingMemories = recallMemories(undefined, 15);

  // Build historical comparison string
  let historicalComparison = '';
  if (historicalSnapshots.length >= 1) {
    historicalComparison = '\n\nHISTORICAL DATA (compare today vs past):\n';
    for (const snap of historicalSnapshots) {
      try {
        const d = JSON.parse(snap.data);
        historicalComparison += `  ${snap.snapshot_date}: focus=${d.focusScore?.score}, consistency=${d.consistency?.overallScore}, entropy=${d.entropy?.normalizedEntropy}, alignment=${d.goalAlignment?.alignmentScore}%\n`;
      } catch { /* skip */ }
    }
  }

  // Build past insights string (so AI doesn't repeat itself)
  let pastInsightsContext = '';
  if (pastInsights.length > 0) {
    pastInsightsContext = '\n\nPREVIOUS INSIGHTS (do NOT repeat these — build on them, note progress/regression):\n';
    for (const ins of pastInsights) {
      const fb = ins.feedback ? ` → user said: ${ins.feedback}` : '';
      pastInsightsContext += `  - [${ins.severity}] ${ins.insight}${fb}\n`;
    }
    const helpfulCount = pastInsights.filter(i => i.feedback === 'helpful').length;
    const notHelpfulCount = pastInsights.filter(i => i.feedback === 'not_helpful').length;
    if (helpfulCount + notHelpfulCount > 0) {
      pastInsightsContext += `  User found ${helpfulCount} insights helpful, ${notHelpfulCount} not helpful. Adjust your style accordingly.\n`;
    }
  }

  // Build existing memories context
  let memoriesContext = '';
  if (existingMemories.length > 0) {
    memoriesContext = '\n\nLEARNED BEHAVIORAL MEMORIES (high confidence = well-established patterns):\n';
    for (const m of existingMemories) {
      memoriesContext += `  [conf: ${(m.confidence * 100).toFixed(0)}%, seen ${m.reinforcement_count}x] ${m.memory_type}: ${m.content}\n`;
    }
  }

  // AI synthesis
  let insights: { category: string; insight: string; tip: string; severity: string }[] = [];
  let summary = archetype.description;

  const apiKey = getSetting('gemini_api_key');
  if (apiKey) {
    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      // Gather calendar data for AI context
      let calendarContext = '';
      try {
        const calEvents = db.prepare(`
          SELECT title, start_time, end_time FROM calendar_events
          WHERE DATE(start_time) = ? ORDER BY start_time
        `).all(today) as { title: string; start_time: string; end_time: string }[];

        if (calEvents.length > 0) {
          let totalMin = 0;
          const eventLines = calEvents.map(e => {
            const dur = Math.round((new Date(e.end_time).getTime() - new Date(e.start_time).getTime()) / 60000);
            totalMin += dur;
            return `  - ${e.title} (${dur}min)`;
          });
          calendarContext = `\n\nTODAY'S CALENDAR (${calEvents.length} events, ${Math.round(totalMin / 60)}h ${totalMin % 60}m of meetings):\n${eventLines.join('\n')}\n  → Consider meeting load when judging focus and productivity. Meeting-heavy days naturally have less deep work time.`;
        }

        // Weekly meeting pattern
        const weeklyMeetings = db.prepare(`
          SELECT DATE(start_time) as day, COUNT(*) as cnt,
            SUM(CAST((julianday(end_time) - julianday(start_time)) * 1440 AS INTEGER)) as total_min
          FROM calendar_events
          WHERE start_time >= datetime('now', '-7 days')
          GROUP BY day
        `).all() as { day: string; cnt: number; total_min: number }[];

        if (weeklyMeetings.length > 0) {
          const avgDailyMeetings = weeklyMeetings.reduce((a, d) => a + d.cnt, 0) / weeklyMeetings.length;
          const avgDailyMin = weeklyMeetings.reduce((a, d) => a + d.total_min, 0) / weeklyMeetings.length;
          calendarContext += `\n  Weekly avg: ${avgDailyMeetings.toFixed(1)} meetings/day, ${Math.round(avgDailyMin)}min/day in meetings.`;
        }
      } catch { /* calendar table may not exist */ }

      const prompt = `You are a behavioral scientist who has been studying this user over time. Generate NEW, personalized insights that BUILD ON your previous analysis.
Respond ONLY with valid JSON (no markdown).

TODAY'S ANALYSIS DATA:
- Archetype: ${archetype.primary} (${archetype.chronotype}, ${archetype.workStyle}, ${archetype.consistencyType})
- Focus Score: ${focusScore.score}/100 (deep: ${focusScore.deepMinutes}min, flow: ${focusScore.flowMinutes}min, fragmented: ${focusScore.fragmentedMinutes}min)
- Attention Entropy: ${entropy.normalizedEntropy} (${entropy.classification}), ${entropy.switchesPerHour} switches/hr, ${entropy.rapidBursts} rapid bursts
- Consistency: ${consistency.overallScore}/100 (work: ${consistency.dimensions.work.score}, habits: ${consistency.dimensions.habits.score}, tasks: ${consistency.dimensions.tasks.score}, focus: ${consistency.dimensions.focus.score})
- Streak: ${consistency.streakDays} days, week-over-week: ${consistency.weekOverWeek}%
- Goal Alignment: ${goalAlignment.alignmentScore}%
- Peak Hours: ${peakHours.join(', ')}
- Top Productive: ${topProductive.map(d => d.domain).join(', ')}
- Top Distraction: ${topDistraction.map(d => d.domain).join(', ')}
- Nudge Response: ${Math.round(nudgeEffectiveness * 100)}%
- Archetype Strengths: ${archetype.strengths.join('; ')}
- Archetype Challenges: ${archetype.challenges.join('; ')}
${calendarContext}${historicalComparison}${pastInsightsContext}${memoriesContext}

IMPORTANT RULES:
1. DO NOT repeat previous insights. Build on them — note changes, improvements, or regressions.
2. If user marked insights as "not_helpful", avoid that style. If "helpful", do more like those.
3. Compare today's data to historical data and highlight trends.
4. Include "behavioral_memories" — durable patterns you're confident about.

Respond with:
{
  "personality_summary": "2-3 sentence behavioral summary using 'you'. Compare to previous if history exists. Be specific with data.",
  "work_style": "${archetype.workStyle}",
  "common_distraction_triggers": "Based on distraction domains and rapid bursts, what triggers them?",
  "motivation_style": "challenge-driven|streak-motivated|improvement-focused|reward-driven",
  "ai_tone": "strict|balanced|gentle — based on nudge response rate and consistency",
  "insights": [
    {"category": "focus|consistency|browsing|habits|tasks|goals", "insight": "data-backed observation", "tip": "actionable advice", "severity": "positive|info|warning|critical"}
  ],
  "behavioral_memories": [
    {"type": "distraction_pattern|focus_pattern|productivity_habit|timing_pattern|strength|weakness", "content": "a durable learning about this user that should persist", "confidence": 0.5-0.9}
  ]
}

Generate 6-8 insights across ALL categories. Reference specific numbers. Be direct.
Generate 3-5 behavioral_memories — these are durable patterns you want to remember for future analysis.`;

      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        summary = parsed.personality_summary || summary;
        insights = parsed.insights || [];

        // ── Progressive profile evolution (confidence increases with each run) ──
        const profileUpdates: Record<string, unknown> = {
          personality_summary: parsed.personality_summary,
          work_style: parsed.work_style || archetype.workStyle,
          common_distraction_triggers: parsed.common_distraction_triggers,
          motivation_style: parsed.motivation_style,
          ai_tone: parsed.ai_tone,
          chronotype: archetype.chronotype,
          focus_profile: archetype.focusProfile,
          consistency_type: archetype.consistencyType,
          archetype: archetype.primary,
          peak_productive_hours: peakHours.join(', '),
          focus_score: focusScore.score,
          consistency_score: consistency.overallScore,
          goal_alignment: goalAlignment.alignmentScore,
          nudge_effectiveness: nudgeEffectiveness,
          strengths: archetype.strengths,
          challenges: archetype.challenges,
          top_productive_domains: topProductive.map(d => d.domain),
          top_distraction_domains: topDistraction.map(d => d.domain),
          productive_trend: consistency.trend,
          last_deep_analysis: new Date().toISOString(),
        };

        // setProfileValue now handles progressive confidence automatically
        for (const [key, value] of Object.entries(profileUpdates)) {
          setProfileValue(key, value);
        }

        // ── Save insights ──
        for (const insight of insights) {
          db.prepare('INSERT INTO behavior_insights (category, insight, actionable_tip, severity) VALUES (?, ?, ?, ?)')
            .run(insight.category, insight.insight, insight.tip, insight.severity);
        }

        // ── Save behavioral memories (the learning loop) ──
        if (parsed.behavioral_memories && Array.isArray(parsed.behavioral_memories)) {
          for (const mem of parsed.behavioral_memories) {
            learnMemory(mem.type, mem.content, 'deep_analysis', mem.confidence || 0.5);
          }
        }

        // ── Auto-learn some durable patterns from raw data ──
        // These are data-driven memories that don't need AI
        if (archetype.chronotype) {
          learnMemory('timing_pattern', `Peak productivity: ${archetype.chronotype}`, 'algorithm');
        }
        if (topDistraction.length > 0) {
          learnMemory('distraction_pattern', `Top distractions: ${topDistraction.slice(0, 3).map(d => d.domain).join(', ')}`, 'algorithm');
        }
        if (focusScore.flowMinutes > 0) {
          learnMemory('focus_pattern', `Achieved ${focusScore.flowMinutes}min of flow state today`, 'algorithm', 0.7);
        }
        if (entropy.rapidBursts > 5) {
          learnMemory('distraction_pattern', `Rapid burst switching detected (${entropy.rapidBursts} bursts) — possible anxiety/overwhelm trigger`, 'algorithm', 0.6);
        }
      }
    } catch (err) {
      console.error('AI deep analysis failed:', err);
    }
  }

  // ── Learn domain classifications from accumulated usage data ──
  try {
    const { learnDomainClassifications } = await import('./categories');
    learnDomainClassifications();
    console.log('[DeepAnalysis] Domain classification learning completed');
  } catch (err) {
    console.error('Domain classification learning failed:', err);
  }

  return { summary, archetype, focusScore, entropy, consistency, goalAlignment, insights };
}


// ============================================================
//  UTILITY FUNCTIONS
// ============================================================

/** Coefficient of variation: std_dev / mean. Lower = more consistent. */
function coefficientOfVariation(values: number[]): number {
  if (values.length < 2) return 1;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 1;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  return Math.sqrt(variance) / mean;
}

/** Convert CV (0-∞) to a 0-100 score. CV of 0 = 100, CV of 1 = ~20. */
function cvToScore(cv: number): number {
  return Math.round(Math.max(0, Math.min(100, 100 * Math.exp(-1.5 * cv))));
}

/** Compute trend using exponential moving average. */
function computeTrend(values: number[]): string {
  if (values.length < 6) return 'stable';
  const mid = Math.floor(values.length / 2);
  const firstHalf = ema(values.slice(0, mid));
  const secondHalf = ema(values.slice(mid));
  if (secondHalf > firstHalf * 1.1) return 'improving';
  if (secondHalf < firstHalf * 0.9) return 'declining';
  return 'stable';
}

/** Exponential moving average (final value). */
function ema(values: number[], alpha: number = 0.3): number {
  if (values.length === 0) return 0;
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = alpha * values[i] + (1 - alpha) * result;
  }
  return result;
}

/** Compute habit streak. */
function computeHabitStreak(days: number): { current: number; longest: number } {
  const db = getDb();
  const checkins = db.prepare(`
    SELECT DISTINCT date FROM habit_checkins
    WHERE completed = 1 AND date >= date('now', '-${days} days')
    ORDER BY date DESC
  `).all() as { date: string }[];

  let current = 0;
  for (let i = 0; i < checkins.length; i++) {
    const expected = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    if (checkins[i]?.date === expected) current++;
    else break;
  }

  let longest = 0, streak = 0;
  for (let i = 0; i < checkins.length; i++) {
    if (i === 0 || checkins[i].date === new Date(new Date(checkins[i - 1].date).getTime() - 86400000).toISOString().slice(0, 10)) {
      streak++;
    } else {
      longest = Math.max(longest, streak);
      streak = 1;
    }
  }
  longest = Math.max(longest, streak);

  return { current, longest };
}

/**
 * Builds a formatted string of the user's active goals and habits to feed to the AI context.
 */
export function buildGoalsContext(): string {
  try {
    const db = getDb();
    const activeGoals = db.prepare('SELECT title, type, target_value, unit FROM goals WHERE active = 1').all() as any[];
    const activeHabits = db.prepare('SELECT name, frequency FROM habits WHERE archived = 0').all() as any[];

    if (activeGoals.length === 0 && activeHabits.length === 0) return '';

    let context = 'USER LONG-TERM GOALS & HABITS:\n';
    if (activeGoals.length > 0) {
      context += 'Core Goals:\n' + activeGoals.map(g => `- ${g.title} (${g.target_value} ${g.unit} ${g.type})`).join('\n') + '\n';
    }
    if (activeHabits.length > 0) {
      context += 'Daily Habits:\n' + activeHabits.map(h => `- ${h.name} (${h.frequency})`).join('\n') + '\n';
    }

    context += '\nCRITICAL RULE: Always prioritize classifying websites that align with the user\'s listed Core Goals and Habits as "productive". Provide nudges against highly distracting pages that contradict these goals.\n';

    return context;
  } catch (err) {
    return '';
  }
}
