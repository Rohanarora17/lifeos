/**
 * Weekly Planner
 *
 * Generates a structured weekly plan: for each day Mon–Sun, assigns tasks
 * from the ranked task pool taking into account:
 *   - Per-day energy forecast (historical focus quality by day-of-week)
 *   - Goal velocity urgency (off_track goals get first pick)
 *   - Task priority, status, energy requirement
 *   - Learned daily capacity, calendar load, and next-day planned sessions
 *
 * The output is stored as plan_json in the weekly_plans table.
 */

import { getDb } from '@/lib/db';
import { classifyEnergy, getAdaptiveBands } from './adaptive-bands';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import { buildPersonalizationSnapshot, type PersonalizationSnapshot } from './personalization-context';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeeklyPlanTask {
  task_id: number;
  title: string;
  estimated_minutes: number;
  goal_id: number | null;
  goal_title: string | null;
  energy_required: string;
  reason: string;
}

export interface WeeklyPlanDay {
  date: string;           // ISO date YYYY-MM-DD
  day_name: string;       // Monday … Sunday
  energy_forecast: 'high' | 'medium' | 'low';
  tasks: WeeklyPlanTask[];
  total_minutes: number;
  capacity_minutes: number;
  capacity_reason: string;
}

export interface WeeklyPlan {
  week_start: string;
  days: WeeklyPlanDay[];
  unscheduled: Array<{ task_id: number; title: string; reason: string }>;
  summary: string;
  generated_at: string;
  personalization?: {
    mode: PersonalizationSnapshot['moment']['mode'];
    guidance: string;
    energy: PersonalizationSnapshot['userState']['energy'];
    mood: PersonalizationSnapshot['userState']['mood'];
    standupGoal: string | null;
    alertFatigueLevel: PersonalizationSnapshot['feedback']['alertFatigueLevel'];
    nextBestFocusWindow: string;
    learnedSprintMinutes: number;
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Monday of the week containing `date` (or current week if omitted). IST offset. */
function weekStart(fromDate?: Date): string {
  const d = fromDate ? new Date(fromDate) : new Date(Date.now() + 19800000);
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day); // shift to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/** Return YYYY-MM-DD for each day Mon–Sun starting from weekStartStr. */
function weekDates(weekStartStr: string): string[] {
  const dates: string[] = [];
  const base = new Date(weekStartStr + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/** day-of-week index (0=Sun) for a YYYY-MM-DD string. */
function dayOfWeek(dateStr: string): number {
  return new Date(dateStr + 'T00:00:00Z').getUTCDay();
}

function energyBand(score: number): 'high' | 'medium' | 'low' {
  return classifyEnergy(score * 100);
}

function todayIso(): string {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

function textMatches(text: string, query: string | null | undefined): boolean {
  if (!query) return false;
  const textLower = text.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(term => term.length >= 4);
  if (terms.length === 0) return false;
  return terms.some(term => textLower.includes(term));
}

/**
 * Compute per-day-of-week energy forecast from historical guardian_session_summaries.
 * Returns a map {0..6} → [0,1] representing avg focus score ratio.
 * Falls back to 0.5 for days with no history.
 */
function computeDayEnergyMap(): Record<number, number> {
  const map: Record<number, number> = { 0: 0.5, 1: 0.5, 2: 0.5, 3: 0.5, 4: 0.5, 5: 0.5, 6: 0.5 };
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT strftime('%w', started_at, 'localtime') as dow,
             AVG(average_focus_score / 100.0) as avg_focus
      FROM guardian_session_summaries
      WHERE started_at IS NOT NULL
      GROUP BY dow
    `).all() as Array<{ dow: string; avg_focus: number }>;
    for (const row of rows) {
      const d = parseInt(row.dow, 10);
      map[d] = row.avg_focus;
    }
  } catch { /* no history yet */ }
  return map;
}

function loadCalendarMinutesByDate(dates: string[]): Record<string, number> {
  const map = Object.fromEntries(dates.map(date => [date, 0])) as Record<string, number>;
  if (dates.length === 0) return map;

  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT date(start_time, 'localtime') as date,
             SUM(MAX(0, (julianday(end_time) - julianday(start_time)) * 24 * 60)) as minutes
      FROM calendar_events
      WHERE date(start_time, 'localtime') BETWEEN ? AND ?
      GROUP BY date(start_time, 'localtime')
    `).all(dates[0], dates[dates.length - 1]) as Array<{ date: string; minutes: number | null }>;
    for (const row of rows) {
      if (row.date in map) map[row.date] = Math.round(Number(row.minutes ?? 0));
    }
  } catch { /* calendar table may not exist */ }

  return map;
}

function loadPlannedCommitmentsByDate(dates: string[]): Record<string, { minutes: number; taskIds: Set<number> }> {
  const map = Object.fromEntries(dates.map(date => [date, { minutes: 0, taskIds: new Set<number>() }])) as Record<string, { minutes: number; taskIds: Set<number> }>;
  if (dates.length === 0) return map;

  try {
    const rows = getDb().prepare(`
      SELECT date(planned_start, 'localtime') as date,
             task_id,
             duration_minutes
      FROM planned_focus_sessions
      WHERE date(planned_start, 'localtime') BETWEEN ? AND ?
        AND status IN ('planned', 'started', 'completed')
    `).all(dates[0], dates[dates.length - 1]) as Array<{ date: string; task_id: number | null; duration_minutes: number | null }>;

    for (const row of rows) {
      if (!(row.date in map)) continue;
      map[row.date].minutes += Math.max(0, Math.round(Number(row.duration_minutes ?? 0)));
      if (row.task_id) map[row.date].taskIds.add(row.task_id);
    }
  } catch { /* next-day planner tables may not exist yet */ }

  return map;
}

function loadTaskFeedbackAdjustments(): Map<number, { score: number; reason: string | null }> {
  const map = new Map<number, { score: number; reason: string | null }>();
  try {
    const rows = getDb().prepare(`
      SELECT task_id, feedback, COUNT(*) as count
      FROM task_recommendation_feedback
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY task_id, feedback
    `).all() as Array<{ task_id: number; feedback: string; count: number }>;

    for (const row of rows) {
      const current = map.get(row.task_id) ?? { score: 0, reason: null };
      if (row.feedback === 'completed') current.score += row.count * 12;
      else if (row.feedback === 'started') current.score += row.count * 8;
      else if (row.feedback === 'helpful') current.score += row.count * 6;
      else if (row.feedback === 'not_now' || row.feedback === 'dismissed') current.score -= row.count * 8;
      else if (row.feedback === 'wrong') current.score -= row.count * 14;

      if (current.score > 0) current.reason = 'recently fit this moment';
      if (current.score < 0) current.reason = 'recently rejected';
      map.set(row.task_id, current);
    }
  } catch { /* feedback table may not exist yet */ }
  return map;
}

function computeDayCapacity(input: {
  date: string;
  energy: WeeklyPlanDay['energy_forecast'];
  baseCapacity: number;
  calendarMinutes: number;
  plannedMinutes: number;
  snapshot: PersonalizationSnapshot;
}): { capacity: number; reason: string } {
  const reasons: string[] = [];
  let capacity = input.baseCapacity;

  if (input.energy === 'high') {
    capacity *= 1.1;
    reasons.push('high-energy forecast');
  } else if (input.energy === 'low') {
    capacity *= 0.8;
    reasons.push('low-energy forecast');
  }

  if (input.date === todayIso()) {
    if (input.snapshot.moment.mode === 'recovery') {
      capacity *= 0.65;
      reasons.push('today is recovery mode');
    } else if (input.snapshot.moment.mode === 'deadline_pressure') {
      capacity *= 1.15;
      reasons.push('deadline pressure today');
    } else if (input.snapshot.moment.mode === 'planning') {
      capacity *= 0.75;
      reasons.push('planning/cleanup mode today');
    } else if (input.snapshot.moment.mode === 'protect_focus') {
      capacity *= 1.05;
      reasons.push('protecting active focus');
    }

    if (input.snapshot.feedback.alertFatigueLevel === 'high') {
      capacity *= 0.85;
      reasons.push('alert fatigue high');
    }
  }

  if (input.calendarMinutes > 0) {
    const calendarPenalty = Math.min(input.calendarMinutes * 0.45, input.baseCapacity * 0.4);
    capacity -= calendarPenalty;
    reasons.push(`${input.calendarMinutes}m calendar load`);
  }

  if (input.plannedMinutes > 0) {
    const plannedPenalty = Math.min(input.plannedMinutes, input.baseCapacity * 0.85);
    capacity -= plannedPenalty;
    reasons.push(`${input.plannedMinutes}m already owned by next-day plan`);
  }

  const rounded = Math.max(20, Math.round(capacity / 5) * 5);
  return {
    capacity: rounded,
    reason: reasons.join('; ') || 'adaptive baseline capacity',
  };
}

// ---------------------------------------------------------------------------
// Ranked candidate tasks (similar scoring logic to session-task-ranker)
// ---------------------------------------------------------------------------

interface CandidateTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  energy_required: string;
  estimated_minutes: number;
  goal_id: number | null;
  goal_title: string | null;
  goal_health: string | null;
  velocity_needed: number | null;
  actual_velocity: number | null;
  score: number;
  reason: string;
}

type CandidateTaskRow = Omit<CandidateTask, 'estimated_minutes' | 'score' | 'reason'> & {
  estimated_minutes: number | null;
};

const STATUS_WEIGHT: Record<string, number> = {
  doing:     5,
  today:     4,
  this_week: 3,
  next:      2,
  backlog:   1,
};

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high:     3,
  medium:   2,
  low:      1,
};

const ENERGY_MATCH: Record<string, Record<string, number>> = {
  high:   { high: 3, medium: 1, low: -1 },
  medium: { high: -1, medium: 3, low: 1 },
  low:    { high: -2, medium: 0, low: 3 },
};

function loadAndScoreCandidates(snapshot: PersonalizationSnapshot): CandidateTask[] {
  const db = getDb();
  const feedback = loadTaskFeedbackAdjustments();
  const learnedSprint = getAdaptiveSessionMinutes();
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority,
           COALESCE(t.energy_required, 'medium') as energy_required,
           t.estimated_minutes as estimated_minutes,
           t.goal_id,
           g.title as goal_title,
           g.health_status as goal_health,
           g.velocity_needed, g.actual_velocity
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.status NOT IN ('done', 'cancelled')
      AND t.blocked_since IS NULL
    ORDER BY t.position ASC, t.id DESC
    LIMIT 200
  `).all() as CandidateTaskRow[];

  return tasks.map(task => {
    let score = 0;
    const reasons: string[] = [];
    const estimatedMinutes = task.estimated_minutes && task.estimated_minutes > 0
      ? Math.round(task.estimated_minutes)
      : learnedSprint;

    if (!task.estimated_minutes || task.estimated_minutes <= 0) {
      reasons.push(`${learnedSprint}m learned estimate`);
    }

    score += (STATUS_WEIGHT[task.status] ?? 1) * 10;
    score += (PRIORITY_WEIGHT[task.priority] ?? 2) * 8;

    if (task.goal_health === 'off_track') { score += 30; reasons.push('goal off track'); }
    else if (task.goal_health === 'at_risk') { score += 15; reasons.push('goal at risk'); }
    else if (task.goal_health === 'on_track') { score += 5; }

    if (task.velocity_needed && task.actual_velocity !== null) {
      const gap = task.velocity_needed - task.actual_velocity;
      if (gap > 0) { score += Math.min(15, gap * 3); reasons.push('velocity gap'); }
    }

    if (snapshot.userState.standupGoal && textMatches(task.title, snapshot.userState.standupGoal)) {
      score += 25;
      reasons.push('matches today standup goal');
    }

    if (snapshot.today.doingTasks.some(title => textMatches(task.title, title) || textMatches(title, task.title))) {
      score += 18;
      reasons.push('already in progress');
    }

    if (snapshot.moment.mode === 'recovery') {
      if (task.energy_required === 'low') { score += 12; reasons.push('low-energy fit'); }
      if (task.energy_required === 'high') { score -= 12; reasons.push('deferred high-energy work'); }
      if (estimatedMinutes > learnedSprint) { score -= 8; reasons.push(`larger than ${learnedSprint}m sprint`); }
    }

    if (snapshot.moment.mode === 'deadline_pressure' && ['critical', 'high'].includes(task.priority)) {
      score += 12;
      reasons.push('deadline-pressure priority');
    }

    const feedbackSignal = feedback.get(task.id);
    if (feedbackSignal) {
      score += feedbackSignal.score;
      if (feedbackSignal.reason) reasons.push(feedbackSignal.reason);
    }

    const reason = reasons.length > 0 ? reasons.join(', ') : task.status;
    return { ...task, estimated_minutes: estimatedMinutes, score, reason };
  }).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Greedy assignment
// ---------------------------------------------------------------------------

function assignTasksToDay(
  day: WeeklyPlanDay,
  candidates: CandidateTask[],
  assignedIds: Set<number>
): void {
  const band = day.energy_forecast;
  const capacity = day.capacity_minutes;
  let remaining = capacity - day.total_minutes;

  for (const task of candidates) {
    if (remaining <= 0) break;
    if (assignedIds.has(task.id)) continue;

    const energyBonus = ENERGY_MATCH[band]?.[task.energy_required] ?? 0;
    // Skip tasks that are a poor energy fit on this day only if there are other days
    if (energyBonus < -1) continue;

    const mins = Math.min(task.estimated_minutes, remaining);
    day.tasks.push({
      task_id: task.id,
      title: task.title,
      estimated_minutes: mins,
      goal_id: task.goal_id,
      goal_title: task.goal_title,
      energy_required: task.energy_required,
      reason: task.reason,
    });
    day.total_minutes += mins;
    remaining -= mins;
    assignedIds.add(task.id);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a weekly plan for the week containing `fromDate` (default: now).
 * Does NOT persist to DB — caller stores the result.
 */
export function generateWeeklyPlan(fromDate?: Date): WeeklyPlan {
  const weekStartStr = weekStart(fromDate);
  const dates = weekDates(weekStartStr);
  const personalization = buildPersonalizationSnapshot({
    surface: 'scheduler',
    maxInsights: 2,
    includeMemoryFacts: 4,
  });
  const bands = getAdaptiveBands();
  const dayEnergyMap = computeDayEnergyMap();
  const calendarMinutes = loadCalendarMinutesByDate(dates);
  const plannedCommitments = loadPlannedCommitmentsByDate(dates);
  const candidates = loadAndScoreCandidates(personalization);

  const days: WeeklyPlanDay[] = dates.map(date => {
    const forecast = date === todayIso()
      ? personalization.userState.energy
      : energyBand(dayEnergyMap[dayOfWeek(date)] ?? 0.5);
    const capacity = computeDayCapacity({
      date,
      energy: forecast,
      baseCapacity: bands.dailyCapacityMinutes,
      calendarMinutes: calendarMinutes[date] ?? 0,
      plannedMinutes: plannedCommitments[date]?.minutes ?? 0,
      snapshot: personalization,
    });
    return {
      date,
      day_name: DAY_NAMES[dayOfWeek(date)],
      energy_forecast: forecast,
      tasks: [],
      total_minutes: 0,
      capacity_minutes: capacity.capacity,
      capacity_reason: capacity.reason,
    };
  });

  // Sort days: high-energy days get first priority on demanding tasks
  const assignedIds = new Set<number>();
  for (const commitment of Object.values(plannedCommitments)) {
    for (const taskId of commitment.taskIds) assignedIds.add(taskId);
  }
  const sortedDayIndices = [...days.keys()].sort((a, b) => {
    const scoreOf = (band: string) => band === 'high' ? 3 : band === 'medium' ? 2 : 1;
    return scoreOf(days[b].energy_forecast) - scoreOf(days[a].energy_forecast);
  });

  for (const i of sortedDayIndices) {
    assignTasksToDay(days[i], candidates, assignedIds);
  }

  // Collect unscheduled tasks
  const unscheduled = candidates
    .filter(t => !assignedIds.has(t.id))
    .slice(0, 20)
    .map(t => ({ task_id: t.id, title: t.title, reason: 'no capacity this week' }));

  // Build summary
  const goalIds = new Set(days.flatMap(d => d.tasks.map(t => t.goal_id).filter(Boolean)));
  const totalTasks = days.reduce((s, d) => s + d.tasks.length, 0);
  const totalMins = days.reduce((s, d) => s + d.total_minutes, 0);
  const summary = `${goalIds.size} goal${goalIds.size !== 1 ? 's' : ''} covered, ${totalTasks} tasks scheduled (${totalMins} min across 7 days)`;
  const adaptiveSummary = `${summary}; ${personalization.moment.mode} mode, ${personalization.userState.energy} energy, ${getAdaptiveSessionMinutes()}m learned sprint`;

  return {
    week_start: weekStartStr,
    days,
    unscheduled,
    summary: adaptiveSummary,
    generated_at: new Date().toISOString(),
    personalization: {
      mode: personalization.moment.mode,
      guidance: personalization.moment.guidance,
      energy: personalization.userState.energy,
      mood: personalization.userState.mood,
      standupGoal: personalization.userState.standupGoal,
      alertFatigueLevel: personalization.feedback.alertFatigueLevel,
      nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
      learnedSprintMinutes: getAdaptiveSessionMinutes(),
    },
  };
}

/**
 * Persist a weekly plan to the DB.
 * Marks any previous plan for the same week as 'superseded'.
 * Returns the new row id.
 */
export function saveWeeklyPlan(plan: WeeklyPlan): number {
  const db = getDb();
  db.prepare(`
    UPDATE weekly_plans SET status = 'superseded'
    WHERE week_start = ? AND status = 'active'
  `).run(plan.week_start);

  const result = db.prepare(`
    INSERT INTO weekly_plans (week_start, plan_json, status)
    VALUES (?, ?, 'active')
  `).run(plan.week_start, JSON.stringify(plan));

  return result.lastInsertRowid as number;
}

/**
 * Load the active weekly plan for the week containing `fromDate` (default: now).
 * Returns null if none exists yet.
 */
export function loadActiveWeeklyPlan(fromDate?: Date): WeeklyPlan | null {
  try {
    const db = getDb();
    const weekStartStr = weekStart(fromDate);
    const row = db.prepare(`
      SELECT plan_json FROM weekly_plans
      WHERE week_start = ? AND status = 'active'
      ORDER BY generated_at DESC LIMIT 1
    `).get(weekStartStr) as { plan_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.plan_json) as WeeklyPlan;
  } catch {
    return null;
  }
}
