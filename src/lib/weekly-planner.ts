/**
 * Weekly Planner
 *
 * Generates a structured weekly plan: for each day Mon–Sun, assigns tasks
 * from the ranked task pool taking into account:
 *   - Per-day energy forecast (historical focus quality by day-of-week)
 *   - Goal velocity urgency (off_track goals get first pick)
 *   - Task priority, status, energy requirement
 *   - Daily capacity cap (default 90 min)
 *
 * The output is stored as plan_json in the weekly_plans table.
 */

import { getDb } from '@/lib/db';

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
}

export interface WeeklyPlan {
  week_start: string;
  days: WeeklyPlanDay[];
  unscheduled: Array<{ task_id: number; title: string; reason: string }>;
  summary: string;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAILY_CAPACITY_MINUTES = 90;

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
  if (score >= 0.65) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

/**
 * Compute per-day-of-week energy forecast from historical focus_sessions.
 * Returns a map {0..6} → [0,1] representing avg productive ratio.
 * Falls back to 0.5 for days with no history.
 */
function computeDayEnergyMap(): Record<number, number> {
  const map: Record<number, number> = { 0: 0.5, 1: 0.5, 2: 0.5, 3: 0.5, 4: 0.5, 5: 0.5, 6: 0.5 };
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT strftime('%w', started_at, 'localtime') as dow,
             AVG(focus_score / 100.0) as avg_focus
      FROM focus_sessions
      WHERE started_at IS NOT NULL AND focus_score IS NOT NULL
      GROUP BY dow
    `).all() as Array<{ dow: string; avg_focus: number }>;
    for (const row of rows) {
      const d = parseInt(row.dow, 10);
      map[d] = row.avg_focus;
    }
  } catch { /* no history yet */ }
  return map;
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

function loadAndScoreCandidates(): CandidateTask[] {
  const db = getDb();
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority,
           COALESCE(t.energy_required, 'medium') as energy_required,
           COALESCE(t.estimated_minutes, 30) as estimated_minutes,
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
  `).all() as CandidateTask[];

  return tasks.map(task => {
    let score = 0;
    const reasons: string[] = [];

    score += (STATUS_WEIGHT[task.status] ?? 1) * 10;
    score += (PRIORITY_WEIGHT[task.priority] ?? 2) * 8;

    if (task.goal_health === 'off_track') { score += 30; reasons.push('goal off track'); }
    else if (task.goal_health === 'at_risk') { score += 15; reasons.push('goal at risk'); }
    else if (task.goal_health === 'on_track') { score += 5; }

    if (task.velocity_needed && task.actual_velocity !== null) {
      const gap = task.velocity_needed - task.actual_velocity;
      if (gap > 0) { score += Math.min(15, gap * 3); reasons.push('velocity gap'); }
    }

    const reason = reasons.length > 0 ? reasons.join(', ') : task.status;
    return { ...task, score, reason };
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
  let remaining = DAILY_CAPACITY_MINUTES - day.total_minutes;

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
  const dayEnergyMap = computeDayEnergyMap();
  const candidates = loadAndScoreCandidates();

  const days: WeeklyPlanDay[] = dates.map(date => ({
    date,
    day_name: DAY_NAMES[dayOfWeek(date)],
    energy_forecast: energyBand(dayEnergyMap[dayOfWeek(date)] ?? 0.5),
    tasks: [],
    total_minutes: 0,
  }));

  // Sort days: high-energy days get first priority on demanding tasks
  const assignedIds = new Set<number>();
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

  return {
    week_start: weekStartStr,
    days,
    unscheduled,
    summary,
    generated_at: new Date().toISOString(),
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
