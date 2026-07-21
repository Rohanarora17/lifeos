import { getDb } from './db';
import { buildPersonalizationSnapshot } from './personalization-context';
import { getAdaptiveRewardDecision, getAdaptiveTaskRewardBase } from './adaptive-rewards';
import { propagateMastery } from './graph';

interface CandidateTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  goal_id: number | null;
  estimated_minutes: number | null;
}

export interface TaskTimeProgress {
  taskId: number;
  targetMinutes: number | null;
  creditedMinutes: number;
  remainingMinutes: number | null;
  percent: number | null;
  linkedSessions: number;
}

export interface TaskSessionCredit {
  taskId: number;
  title: string;
  creditedMinutes: number;
  creditedTotalMinutes: number;
  targetMinutes: number;
  completed: boolean;
  rewardCoins: number;
  reason: string;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}

function isTitleContained(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al.includes(bl) || bl.includes(al);
}

function scoreTaskForSession(task: CandidateTask, topic: string, goalId?: string | null): number {
  let score = 0;
  const topicWords = tokenize(topic).filter(word => word.length > 2);
  const titleWords = tokenize(task.title);
  const overlap = topicWords.filter(word => titleWords.includes(word) && word.length > 3).length;
  const goalMatch = goalId && task.goal_id === Number.parseInt(goalId, 10);

  if (goalMatch) score += 6;
  if (isTitleContained(topic, task.title)) score += 5;
  score += overlap * 2;
  if (task.status === 'doing') score += 1;
  if (task.estimated_minutes && task.estimated_minutes > 0) score += 1;
  return score;
}

function loadCandidateTasks(): CandidateTask[] {
  return getDb().prepare(`
    SELECT id, title, status, priority, goal_id, estimated_minutes
    FROM tasks
    WHERE status IN ('todo', 'doing')
    ORDER BY
      CASE status WHEN 'doing' THEN 0 ELSE 1 END,
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      CASE WHEN priority_rank IS NULL THEN 1 ELSE 0 END, priority_rank ASC,
      created_at DESC
    LIMIT 40
  `).all() as CandidateTask[];
}

export function findSessionTaskMatches(topic: string, goalId?: string | null, limit = 3): CandidateTask[] {
  return loadCandidateTasks()
    .map(task => ({ task, score: scoreTaskForSession(task, topic, goalId) }))
    .filter(item => item.score >= 4)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.task);
}

export function activateTimeTasksForSession(topic: string, goalId?: string | null): number[] {
  const db = getDb();
  const matches = findSessionTaskMatches(topic, goalId, 3);
  const activated: number[] = [];

  for (const task of matches) {
    if (task.status === 'todo') {
      db.prepare("UPDATE tasks SET status = 'doing', updated_at = datetime('now') WHERE id = ?").run(task.id);
    }
    activated.push(task.id);
  }

  if (activated.length > 0) {
    console.log(`[task-time-sessions] Activated ${activated.length} time-target task(s) for "${topic}"`);
  }
  return activated;
}

export function getTaskTimeProgress(taskId: number): TaskTimeProgress {
  const row = getDb().prepare(`
    SELECT
      t.id as task_id,
      t.estimated_minutes as target_minutes,
      COALESCE(SUM(l.credited_minutes), 0) as credited_minutes,
      COUNT(l.id) as linked_sessions
    FROM tasks t
    LEFT JOIN task_session_logs l ON l.task_id = t.id
    WHERE t.id = ?
    GROUP BY t.id
  `).get(taskId) as {
    task_id: number;
    target_minutes: number | null;
    credited_minutes: number;
    linked_sessions: number;
  } | undefined;

  const target = row?.target_minutes && row.target_minutes > 0 ? Math.round(row.target_minutes) : null;
  const credited = Math.round(Number(row?.credited_minutes ?? 0));
  return {
    taskId,
    targetMinutes: target,
    creditedMinutes: credited,
    remainingMinutes: target === null ? null : Math.max(0, target - credited),
    percent: target === null ? null : Math.min(100, Math.round((credited / target) * 100)),
    linkedSessions: Number(row?.linked_sessions ?? 0),
  };
}

function markCompletionReviewDone(sessionId: string, taskId: number, note: string): void {
  const db = getDb();
  const existing = db.prepare(`
    SELECT id FROM session_completions WHERE session_id = ? AND task_id = ? LIMIT 1
  `).get(sessionId, taskId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE session_completions
      SET status = 'done', completion_note = ?, actioned_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(note, existing.id);
  } else {
    db.prepare(`
      INSERT INTO session_completions (session_id, task_id, status, completion_note, actioned_at)
      VALUES (?, ?, 'done', ?, datetime('now', 'localtime'))
    `).run(sessionId, taskId, note);
  }
}

export function creditSessionTimeToTasks(input: {
  sessionId: string;
  topic: string;
  elapsedMinutes: number;
  avgFocusScore: number;
  goalId?: string | null;
}): TaskSessionCredit[] {
  const db = getDb();
  const elapsedMinutes = Math.max(1, Math.round(input.elapsedMinutes));
  const matches = findSessionTaskMatches(input.topic, input.goalId, 3);
  const credits: TaskSessionCredit[] = [];

  const snapshot = buildPersonalizationSnapshot({
    surface: 'rewards',
    maxInsights: 2,
    includeMemoryFacts: 3,
    activeSession: {
      sessionId: input.sessionId,
      targetTitle: input.topic,
      focusScore: input.avgFocusScore,
      elapsedMinutes,
    },
  });

  const insertLog = db.prepare(`
    INSERT INTO task_session_logs (task_id, session_id, session_title, credited_minutes, focus_score, auto_completed)
    VALUES (?, ?, ?, ?, ?, 0)
    ON CONFLICT(task_id, session_id) DO UPDATE SET
      session_title = excluded.session_title,
      credited_minutes = excluded.credited_minutes,
      focus_score = excluded.focus_score
  `);
  const markAutoCompleted = db.prepare(`
    UPDATE task_session_logs SET auto_completed = 1 WHERE task_id = ? AND session_id = ?
  `);

  db.transaction(() => {
    for (const task of matches) {
      const targetMinutes = task.estimated_minutes && task.estimated_minutes > 0 ? Math.round(task.estimated_minutes) : elapsedMinutes;
      if (!task.estimated_minutes || task.estimated_minutes <= 0) {
        db.prepare('UPDATE tasks SET estimated_minutes = ?, updated_at = datetime(\'now\') WHERE id = ?').run(targetMinutes, task.id);
      }

      insertLog.run(task.id, input.sessionId, input.topic, elapsedMinutes, input.avgFocusScore);
      const progress = getTaskTimeProgress(task.id);
      const completed = progress.targetMinutes !== null && progress.creditedMinutes >= progress.targetMinutes && task.status !== 'done';
      let rewardCoins = 0;

      if (completed) {
        db.prepare(`
          UPDATE tasks
          SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now')
          WHERE id = ? AND status != 'done'
        `).run(task.id);
        markAutoCompleted.run(task.id, input.sessionId);
        const rewardBase = getAdaptiveTaskRewardBase({
          taskId: task.id,
          title: task.title,
          priority: task.priority,
          targetMinutes,
          snapshot,
        });
        const reward = getAdaptiveRewardDecision({
          action: 'task_auto_complete',
          baseCoins: rewardBase.baseCoins,
          priority: task.priority,
          subject: `${task.title} (${progress.creditedMinutes}/${targetMinutes}m; ${rewardBase.reason})`,
          snapshot,
        });
        rewardCoins = reward.coins;
        db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(reward.coins, reward.ledgerReason);
        try { propagateMastery(task.id, null); } catch { /* graph links are optional */ }
        markCompletionReviewDone(input.sessionId, task.id, `Completed by ${progress.creditedMinutes}/${targetMinutes} linked focus minutes.`);
      }

      credits.push({
        taskId: task.id,
        title: task.title,
        creditedMinutes: elapsedMinutes,
        creditedTotalMinutes: progress.creditedMinutes,
        targetMinutes,
        completed,
        rewardCoins,
        reason: completed
          ? `Reached ${progress.creditedMinutes}/${targetMinutes}m target`
          : `${progress.creditedMinutes}/${targetMinutes}m accumulated`,
      });
    }
  })();

  return credits;
}
