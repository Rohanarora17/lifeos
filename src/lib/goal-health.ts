/**
 * Goal Health Monitor
 *
 * Nightly computation of goal velocity and health_status.
 * Reads from goal_time_logs + task completions to compute actual velocity,
 * compares against velocity_needed derived from deadline and target_value,
 * then writes health_status + actual_velocity back to goals.
 *
 * Health labels:
 *   on_track   — actual >= 90% of needed, or no deadline
 *   at_risk    — actual 60–90% of needed
 *   off_track  — actual < 60% of needed
 */

import { getDb } from '@/lib/db';
import { classifyGoalHealth, getAdaptiveBands } from './adaptive-bands';

interface GoalRow {
  id: number;
  title: string;
  goal_type: string;
  target_value: number | null;
  progress_value: number | null;
  deadline: string | null;
  active: number;
  velocity_needed: number | null;
}

/** Minutes per day needed to hit target by deadline. */
function computeVelocityNeeded(goal: GoalRow): number | null {
  if (!goal.deadline) return null;
  const daysLeft = Math.max(1, Math.ceil(
    (new Date(goal.deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  ));
  if (goal.goal_type === 'time_based') {
    // target_value in minutes total — compute remaining / days left
    const remaining = Math.max(0, (goal.target_value ?? 0) - (goal.progress_value ?? 0));
    return remaining / daysLeft;
  }
  // For milestone / count_based: use a heuristic of 30 min/day per unit remaining
  const remaining = Math.max(0, (goal.target_value ?? 1) - (goal.progress_value ?? 0));
  return (remaining * 30) / daysLeft;
}

/** Actual velocity = average daily minutes logged in the last 7 days. */
function computeActualVelocity(goalId: number): number {
  const db = getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT COALESCE(SUM(minutes), 0) / 7.0 as avg_daily
    FROM goal_time_logs
    WHERE goal_id = ? AND date(logged_at, 'localtime') >= ?
  `).get(goalId, sevenDaysAgo) as { avg_daily: number };
  return row.avg_daily;
}

function healthStatus(actual: number, needed: number | null): 'on_track' | 'at_risk' | 'off_track' {
  if (!needed || needed <= 0) return 'on_track';
  const ratio = actual / needed;
  return classifyGoalHealth(ratio);
}

/**
 * Run nightly goal health update.
 * Returns a summary of what changed.
 */
export function updateGoalHealth(): { updated: number; summary: string[] } {
  const db = getDb();
  const goals = db.prepare(`
    SELECT id, title, goal_type, target_value, progress_value, deadline, active, velocity_needed
    FROM goals
    WHERE active = 1
  `).all() as GoalRow[];

  const summary: string[] = [];
  let updated = 0;

  for (const goal of goals) {
    try {
      const velocityNeeded = computeVelocityNeeded(goal);
      const actualVelocity = computeActualVelocity(goal.id);
      const status = healthStatus(actualVelocity, velocityNeeded);

      db.prepare(`
        UPDATE goals
        SET velocity_needed = ?,
            actual_velocity = ?,
            health_status = ?
        WHERE id = ?
      `).run(velocityNeeded, actualVelocity, status, goal.id);

      if (status !== 'on_track') {
        summary.push(`${goal.title}: ${status} (actual ${actualVelocity.toFixed(1)}m/day vs needed ${velocityNeeded?.toFixed(1) ?? '?'}m/day)`);
      }
      updated++;
    } catch (err) {
      console.error(`[goal-health] Failed for goal ${goal.id}:`, err);
    }
  }

  return { updated, summary };
}

/**
 * Credit minutes to a goal when a guardian session ends.
 * Called from guardian-runtime.ts on session end.
 */
export function logGoalTime(goalId: number | null | undefined, sessionId: string, minutes: number): void {
  if (!goalId || minutes <= 0) return;
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO goal_time_logs (goal_id, session_id, minutes)
      VALUES (?, ?, ?)
    `).run(goalId, sessionId, minutes);
  } catch (err) {
    console.error('[goal-health] logGoalTime failed:', err);
  }
}
