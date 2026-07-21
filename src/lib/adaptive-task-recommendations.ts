import { getDb } from './db';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import type { PersonalizationSnapshot } from './personalization-context';

export type TaskRecommendationFeedback =
  | 'helpful'
  | 'not_now'
  | 'wrong'
  | 'started'
  | 'completed'
  | 'dismissed';

export interface AdaptiveRecommendedTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  goalTitle: string | null;
  score: number;
  reason: string;
  momentFit: 'high' | 'medium' | 'low';
  estimatedMinutes: number | null;
  energyRequired: 'low' | 'medium' | 'high' | null;
  feedbackHint: string | null;
}

interface TaskRow {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  due_date: string | null;
  created_at: string;
  goal_id: number | null;
  task_type: string | null;
  course: string | null;
  estimated_minutes: number | null;
  energy_required: 'low' | 'medium' | 'high' | null;
  complexity: string | null;
  goal_title: string | null;
  goal_deadline: string | null;
  priority_rank: number | null;
  credited_minutes: number;
  linked_sessions: number;
  avg_focus_score: number | null;
  last_credited_at: string | null;
}

interface FeedbackStats {
  helpful: number;
  notNow: number;
  wrong: number;
  started: number;
  completed: number;
  dismissed: number;
}

const priorityWeight: Record<string, number> = {
  critical: 44,
  high: 34,
  medium: 22,
  low: 12,
};

function todayMs(date: string | null): number | null {
  if (!date) return null;
  const time = new Date(date).getTime();
  return Number.isFinite(time) ? time : null;
}

function daysUntil(date: string | null): number | null {
  const time = todayMs(date);
  if (time === null) return null;
  return Math.ceil((time - Date.now()) / 86_400_000);
}

function textMatches(text: string | null | undefined, needle: string | null | undefined): boolean {
  if (!text || !needle) return false;
  const haystack = text.toLowerCase();
  return needle
    .toLowerCase()
    .split(/\W+/)
    .filter(token => token.length >= 4)
    .some(token => haystack.includes(token));
}

function loadFeedbackStats(): Map<number, FeedbackStats> {
  const stats = new Map<number, FeedbackStats>();
  try {
    const rows = getDb().prepare(`
      SELECT task_id, feedback, COUNT(*) as count
      FROM task_recommendation_feedback
      WHERE created_at >= datetime('now', '-45 days')
      GROUP BY task_id, feedback
    `).all() as Array<{ task_id: number; feedback: TaskRecommendationFeedback; count: number }>;

    for (const row of rows) {
      const current = stats.get(row.task_id) ?? {
        helpful: 0,
        notNow: 0,
        wrong: 0,
        started: 0,
        completed: 0,
        dismissed: 0,
      };
      if (row.feedback === 'helpful') current.helpful += row.count;
      if (row.feedback === 'not_now') current.notNow += row.count;
      if (row.feedback === 'wrong') current.wrong += row.count;
      if (row.feedback === 'started') current.started += row.count;
      if (row.feedback === 'completed') current.completed += row.count;
      if (row.feedback === 'dismissed') current.dismissed += row.count;
      stats.set(row.task_id, current);
    }
  } catch {
    // Table may not exist before migrations run.
  }
  return stats;
}

function feedbackAdjustment(feedback?: FeedbackStats): { score: number; hint: string | null } {
  if (!feedback) return { score: 0, hint: null };
  const positive = feedback.helpful + feedback.started + feedback.completed;
  const negative = feedback.notNow + feedback.wrong + feedback.dismissed;
  let score = positive * 8 - feedback.notNow * 10 - feedback.wrong * 18 - feedback.dismissed * 6;
  let hint: string | null = null;

  if (feedback.wrong > 0) hint = 'previously marked wrong fit';
  else if (feedback.notNow > 0) hint = 'previously marked not now';
  else if (feedback.dismissed > 0) hint = 'often dismissed';
  else if (positive > 0) hint = 'you have accepted this kind of pick before';

  if (negative >= 3 && positive === 0) score -= 12;
  return { score, hint };
}

function momentFitLabel(score: number): AdaptiveRecommendedTask['momentFit'] {
  if (score >= 78) return 'high';
  if (score >= 48) return 'medium';
  return 'low';
}

export function getAdaptiveTaskRecommendations(
  snapshot: PersonalizationSnapshot,
  limit = 5,
): AdaptiveRecommendedTask[] {
  const db = getDb();
  const learnedSprint = getAdaptiveSessionMinutes();
  const feedback = loadFeedbackStats();
  const standupGoal = snapshot.userState.standupGoal;

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.goal_id, t.created_at,
           t.task_type, t.course, t.estimated_minutes, t.energy_required, t.complexity, t.priority_rank,
           g.title as goal_title, g.deadline as goal_deadline,
           COALESCE(SUM(l.credited_minutes), 0) as credited_minutes,
           COUNT(l.id) as linked_sessions,
           AVG(l.focus_score) as avg_focus_score,
           MAX(l.credited_at) as last_credited_at
    FROM tasks t
    LEFT JOIN goals g ON t.goal_id = g.id
    LEFT JOIN task_session_logs l ON l.task_id = t.id
    WHERE t.status IN ('todo', 'doing')
    GROUP BY t.id
    ORDER BY t.position ASC, t.created_at DESC
  `).all() as TaskRow[];

  const scored = tasks.map(task => {
    const reasons: string[] = [];
    let score = priorityWeight[task.priority || 'medium'] ?? priorityWeight.medium;
    const dueDays = daysUntil(task.due_date);
    const goalDueDays = daysUntil(task.goal_deadline);
    const estimate = task.estimated_minutes;
    const taskText = `${task.title} ${task.goal_title ?? ''} ${task.task_type ?? ''} ${task.course ?? ''}`;
    const remainingMinutes = estimate !== null ? Math.max(0, estimate - Number(task.credited_minutes ?? 0)) : null;

    if (task.priority_rank !== null) {
      score += Math.max(0, 16 - Math.min(16, task.priority_rank));
      reasons.push('ranked high by task model');
    }

    if (task.status === 'doing') {
      score += snapshot.moment.mode === 'protect_focus' ? 24 : 12;
      reasons.push('already in progress');
    }

    if (dueDays !== null) {
      if (dueDays < 0) {
        score += 42;
        reasons.push('overdue');
      } else if (dueDays === 0) {
        score += 36;
        reasons.push('due today');
      } else if (dueDays <= 2) {
        score += 24;
        reasons.push(`due in ${dueDays}d`);
      } else if (dueDays <= 7) {
        score += 10;
        reasons.push('due this week');
      }
    }

    if (goalDueDays !== null && goalDueDays <= 7) {
      score += goalDueDays < 0 ? 22 : 14;
      reasons.push(goalDueDays < 0 ? 'goal overdue' : 'goal deadline close');
    }

    if (standupGoal && textMatches(taskText, standupGoal)) {
      score += 20;
      reasons.push('matches today goal');
    }

    if (snapshot.today.doingTasks.some(title => textMatches(taskText, title))) {
      score += 14;
      reasons.push('matches active work thread');
    }

    if (snapshot.userState.nextBestFocusWindow && snapshot.moment.mode === 'protect_focus') {
      score += task.status === 'doing' ? 8 : 0;
    }

    if (snapshot.moment.mode === 'deadline_pressure') {
      if (dueDays !== null && dueDays <= 2) score += 18;
      if (!task.due_date) score -= 12;
      reasons.push('deadline mode');
    }

    if (snapshot.moment.mode === 'recovery') {
      if (estimate !== null && estimate <= Math.max(20, learnedSprint / 2)) {
        score += 18;
        reasons.push('small enough for low-energy mode');
      }
      if (remainingMinutes !== null && remainingMinutes <= learnedSprint) {
        score += 12;
        reasons.push('finishable without overreaching');
      }
      if (task.energy_required === 'low') {
        score += 14;
        reasons.push('low energy fit');
      }
      if (task.energy_required === 'high') {
        score -= 16;
        reasons.push('high energy mismatch');
      }
      if (task.complexity === 'familiar') score += 8;
      if (task.complexity === 'novel') score -= 6;
    }

    if (snapshot.moment.mode === 'planning') {
      if (task.status === 'doing') score += 8;
      if (!task.due_date && task.priority === 'low') score += 8;
      if (dueDays !== null && dueDays <= 1) score += 12;
      reasons.push('planning window');
    }

    if (snapshot.userState.energy === 'high' && task.energy_required === 'high') {
      score += 10;
      reasons.push('uses high-energy window');
    }

    if (task.avg_focus_score !== null && task.avg_focus_score >= 75) {
      score += snapshot.userState.energy === 'low' ? 6 : 12;
      reasons.push(`historically ${Math.round(task.avg_focus_score)} focus`);
    }

    if (task.avg_focus_score !== null && task.avg_focus_score < 55) {
      score += snapshot.moment.mode === 'recovery' ? -12 : -4;
      reasons.push(`past sessions were hard (${Math.round(task.avg_focus_score)} focus)`);
    }

    if (task.linked_sessions > 0 && remainingMinutes !== null && remainingMinutes <= Math.max(learnedSprint, Math.round((estimate ?? learnedSprint) * 0.35))) {
      score += 14;
      reasons.push(`${task.linked_sessions} linked session${task.linked_sessions === 1 ? '' : 's'}; close to done`);
    }

    if (task.course && standupGoal && textMatches(task.course, standupGoal)) {
      score += 8;
      reasons.push(`course fit: ${task.course}`);
    }

    if (estimate !== null) {
      if (estimate <= learnedSprint) {
        score += 8;
        reasons.push(`fits ${learnedSprint}m sprint`);
      } else if (snapshot.moment.mode === 'recovery') {
        score -= 10;
      }
    }

    const ageDays = Math.round((Date.now() - new Date(task.created_at).getTime()) / 86_400_000);
    if (ageDays > 14) {
      score += 8;
      reasons.push(`${ageDays}d old`);
    }

    if (task.last_credited_at) {
      const daysSinceCredit = Math.round((Date.now() - new Date(task.last_credited_at).getTime()) / 86_400_000);
      if (daysSinceCredit >= 3) {
        score += 6;
        reasons.push(`not touched for ${daysSinceCredit}d`);
      }
    }

    const feedbackSignal = feedbackAdjustment(feedback.get(task.id));
    score += feedbackSignal.score;
    if (feedbackSignal.hint) reasons.push(feedbackSignal.hint);

    return {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority || 'medium',
      goalTitle: task.goal_title,
      score: Math.round(score),
      reason: reasons.slice(0, 4).join(' · ') || snapshot.moment.guidance,
      momentFit: momentFitLabel(score),
      estimatedMinutes: estimate,
      energyRequired: task.energy_required,
      feedbackHint: feedbackSignal.hint,
    };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function recordTaskRecommendationFeedback(input: {
  taskId: number;
  feedback: TaskRecommendationFeedback;
  momentMode?: string | null;
  surface?: string;
  reason?: string | null;
}): boolean {
  const db = getDb();
  const task = db.prepare('SELECT id, title FROM tasks WHERE id = ?').get(input.taskId) as { id: number; title: string } | undefined;
  if (!task) return false;

  const helpful = input.feedback === 'helpful' || input.feedback === 'started' || input.feedback === 'completed'
    ? 1
    : input.feedback === 'dismissed'
      ? null
      : 0;

  const outcome = db.prepare(`
    INSERT INTO agent_action_outcomes (action_type, inferred_value, actual_outcome, was_corrected, correction_text, helpful)
    VALUES ('task_recommendation', ?, ?, ?, ?, ?)
  `).run(
    JSON.stringify({ taskId: task.id, title: task.title, surface: input.surface ?? 'dashboard', momentMode: input.momentMode ?? null }),
    JSON.stringify({ feedback: input.feedback, reason: input.reason ?? null, source: 'task_recommendation_feedback' }),
    input.feedback === 'not_now' || input.feedback === 'wrong' ? 1 : 0,
    input.feedback === 'wrong' || input.feedback === 'not_now' ? input.reason ?? input.feedback : null,
    helpful,
  );

  db.prepare(`
    INSERT INTO task_recommendation_feedback (task_id, surface, moment_mode, feedback, reason, outcome_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    input.surface ?? 'dashboard',
    input.momentMode ?? null,
    input.feedback,
    input.reason ?? null,
    outcome.lastInsertRowid,
  );

  return true;
}
