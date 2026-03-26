/**
 * Session Task Ranker — Student-focused rewrite.
 *
 * Uses LLM-generated priority_rank as the primary sort.
 * Falls back to due_date when priority_rank is missing.
 * Energy composite is retained as a parameter for future fine-tuning
 * but does NOT override the LLM rank.
 */

import { getDb } from '@/lib/db';

export interface RankedTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  task_type: string;
  course: string | null;
  due_date: string | null;
  due_time: string | null;
  energy_required: string;
  estimated_minutes: number | null;
  goal_id: number | null;
  goal_title: string | null;
  goal_health: string | null;
  priority_rank: number | null;
  score: number;
  reason: string;
}

/**
 * Return up to `limit` ranked task suggestions for a Guardian session.
 * `energyComposite` — [0–100] from computeEnergyComposite(), or null to skip.
 */
export function rankTasksForSession(
  energyComposite: number | null,
  limit = 5
): RankedTask[] {
  const db = getDb();

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.task_type, t.course,
           t.due_date, t.due_time, t.energy_required, t.estimated_minutes,
           t.goal_id, t.blocked_since, t.priority_rank, t.priority_reason,
           g.title as goal_title,
           g.health_status as goal_health
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.status NOT IN ('done', 'cancelled')
      AND t.blocked_since IS NULL
    ORDER BY
      CASE WHEN t.priority_rank IS NULL THEN 1 ELSE 0 END,
      t.priority_rank ASC,
      CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END,
      t.due_date ASC
    LIMIT 100
  `).all() as Array<{
    id: number;
    title: string;
    status: string;
    priority: string;
    task_type: string;
    course: string | null;
    due_date: string | null;
    due_time: string | null;
    energy_required: string;
    estimated_minutes: number | null;
    goal_id: number | null;
    blocked_since: string | null;
    goal_title: string | null;
    goal_health: string | null;
    priority_rank: number | null;
    priority_reason: string | null;
  }>;

  if (tasks.length === 0) return [];

  return tasks.slice(0, limit).map((task, i) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    task_type: task.task_type,
    course: task.course,
    due_date: task.due_date,
    due_time: task.due_time,
    energy_required: task.energy_required,
    estimated_minutes: task.estimated_minutes,
    goal_id: task.goal_id,
    goal_title: task.goal_title,
    goal_health: task.goal_health,
    priority_rank: task.priority_rank,
    score: 100 - i, // Synthetic descending score for API consumers expecting a score field
    reason: task.priority_reason ?? (task.due_date ? `due ${task.due_date}` : task.status),
  }));
}
