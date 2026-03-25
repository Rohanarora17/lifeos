/**
 * Session Task Ranker
 *
 * Given the user's current energy level and today's context, rank actionable
 * tasks and return the top suggestions for Guardian session start.
 *
 * Scoring factors:
 *  - Goal velocity urgency (goal is falling behind → boost linked tasks)
 *  - Task status (doing > today > this_week > next > backlog)
 *  - Energy match (high-energy required tasks get boosted on high-energy days)
 *  - Priority (critical > high > medium > low)
 *  - Habit completion context (habit is incomplete today → boost tasks that advance it)
 *  - Blocked tasks are excluded
 */

import { getDb } from '@/lib/db';

export interface RankedTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  energy_required: string;
  estimated_minutes: number | null;
  goal_id: number | null;
  goal_title: string | null;
  goal_health: string | null;
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
  // energyBand → task.energy_required → score bonus
  high:   { high: 3, medium: 1, low: -1 },
  medium: { high: -1, medium: 3, low: 1 },
  low:    { high: -2, medium: 0, low: 3 },
};

function energyBand(composite: number): 'high' | 'medium' | 'low' {
  if (composite >= 65) return 'high';
  if (composite >= 35) return 'medium';
  return 'low';
}

/**
 * Return up to `limit` ranked task suggestions.
 * `energyComposite` — [0–100] from computeEnergyComposite(), or null to skip energy matching.
 */
export function rankTasksForSession(
  energyComposite: number | null,
  limit = 5
): RankedTask[] {
  const db = getDb();
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

  // Fetch actionable tasks (not done/cancelled/blocked)
  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.energy_required,
           t.estimated_minutes, t.goal_id, t.blocked_since,
           g.title as goal_title,
           g.health_status as goal_health,
           g.velocity_needed, g.actual_velocity
    FROM tasks t
    LEFT JOIN goals g ON g.id = t.goal_id
    WHERE t.status NOT IN ('done', 'cancelled')
      AND t.blocked_since IS NULL
    ORDER BY t.position ASC, t.id DESC
    LIMIT 100
  `).all() as Array<{
    id: number;
    title: string;
    status: string;
    priority: string;
    energy_required: string;
    estimated_minutes: number | null;
    goal_id: number | null;
    blocked_since: string | null;
    goal_title: string | null;
    goal_health: string | null;
    velocity_needed: number | null;
    actual_velocity: number | null;
  }>;

  if (tasks.length === 0) return [];

  const band = energyComposite !== null ? energyBand(energyComposite) : 'medium';

  // Check if any time-based habit is incomplete today (habit context boost)
  const habitIncomplete = db.prepare(`
    SELECT COUNT(*) as c
    FROM habits h
    LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
    WHERE h.archived = 0 AND h.goal_metric = 'time'
      AND (hc.completed IS NULL OR hc.completed = 0)
  `).get(today) as { c: number };
  const boostStudyTasks = habitIncomplete.c > 0;

  const scored: RankedTask[] = tasks.map(task => {
    let score = 0;
    const reasons: string[] = [];

    // Status weight
    score += (STATUS_WEIGHT[task.status] ?? 1) * 10;

    // Priority weight
    score += (PRIORITY_WEIGHT[task.priority] ?? 2) * 8;

    // Energy match
    if (energyComposite !== null) {
      const energyBonus = (ENERGY_MATCH[band]?.[task.energy_required] ?? 0) * 6;
      score += energyBonus;
      if (energyBonus > 0) reasons.push(`${band} energy day`);
    }

    // Goal velocity urgency
    if (task.goal_health === 'at_risk' || task.goal_health === 'off_track') {
      score += 20;
      reasons.push('goal behind schedule');
    } else if (task.goal_health === 'on_track') {
      score += 5;
    }

    // Velocity gap boost — if actual < needed, add proportional boost
    if (task.velocity_needed && task.actual_velocity !== null) {
      const gap = task.velocity_needed - task.actual_velocity;
      if (gap > 0) {
        score += Math.min(15, gap * 3);
        reasons.push('velocity gap');
      }
    }

    // Study habit incomplete today → boost tasks linked to learning goals
    if (boostStudyTasks && task.goal_id) {
      score += 8;
      reasons.push("habit incomplete today");
    }

    const reason = reasons.length > 0 ? reasons.join(', ') : task.status;

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      energy_required: task.energy_required,
      estimated_minutes: task.estimated_minutes,
      goal_id: task.goal_id,
      goal_title: task.goal_title,
      goal_health: task.goal_health,
      score,
      reason,
    };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
