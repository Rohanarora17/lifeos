/**
 * session-task-sync.ts
 * Handles automatic task status transitions tied to Guardian sessions:
 *  - Session START: move matching tasks from todo → doing
 *  - Session END: LLM evaluates which tasks were likely completed; auto-done or adds to review
 */

import { getDb } from './db';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import { sendTelegram, FULL_MENU_KEYBOARD } from './telegram';

interface TaskRow {
  id: number;
  title: string;
  status: string;
  priority: string;
  goal_id: number | null;
}

// ─── Session START ────────────────────────────────────────────────────────────

/**
 * Find tasks that match the session topic and move them to 'doing'.
 * Uses keyword overlap so it's fast and synchronous-safe when called at session start.
 * Returns the list of task IDs that were activated.
 */
export function activateTasksForSession(topic: string, goalId?: string | null): number[] {
  const db = getDb();

  // Candidate tasks: not done/cancelled, not already doing
  const candidates = db.prepare(`
    SELECT id, title, status, priority, goal_id
    FROM tasks
    WHERE status IN ('todo', 'doing')
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
      CASE WHEN priority_rank IS NULL THEN 1 ELSE 0 END, priority_rank ASC
    LIMIT 20
  `).all() as TaskRow[];

  if (candidates.length === 0) return [];

  const topicWords = tokenize(topic);
  const activated: number[] = [];

  for (const task of candidates) {
    const titleWords = tokenize(task.title);
    const overlap = topicWords.filter(w => titleWords.includes(w) && w.length > 3).length;
    const goalMatch = goalId && task.goal_id === parseInt(goalId, 10);

    // Activate if: strong keyword overlap OR task is linked to the session goal
    if (overlap >= 2 || goalMatch || isTitleContained(topic, task.title)) {
      db.prepare(`UPDATE tasks SET status = 'doing' WHERE id = ?`).run(task.id);
      activated.push(task.id);
    }
  }

  // Also activate the first 'todo' task if no keyword match was found
  if (activated.length === 0) {
    const topTodo = candidates.find(t => t.status === 'todo' || t.status === 'doing');
    if (topTodo) {
      db.prepare(`UPDATE tasks SET status = 'doing' WHERE id = ?`).run(topTodo.id);
      activated.push(topTodo.id);
    }
  }

  if (activated.length > 0) {
    console.log(`[session-task-sync] Activated ${activated.length} tasks for session topic: "${topic}"`);
  }
  return activated;
}

/** True if one string is contained as a phrase in the other (case-insensitive). */
function isTitleContained(a: string, b: string): boolean {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  return al.includes(bl) || bl.includes(al);
}

// ─── Session END ──────────────────────────────────────────────────────────────

interface CompletionAssessment {
  taskId: number;
  title: string;
  verdict: 'done' | 'partial' | 'not_done';
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * After a session ends, use LLM to decide which 'doing' tasks were completed.
 * - high confidence done → auto-mark as done, award coins
 * - medium confidence / partial → add to session review queue with assessment note
 * - low confidence / not_done → leave as 'doing', nothing added to review
 */
export async function evaluateSessionTaskCompletion(
  sessionId: string,
  topic: string,
  elapsedMinutes: number,
  avgFocusScore: number,
): Promise<void> {
  const db = getDb();
  const doingTasks = db.prepare(`
    SELECT id, title, status, priority, goal_id FROM tasks WHERE status = 'doing'
  `).all() as TaskRow[];

  if (doingTasks.length === 0) return;

  let assessments: CompletionAssessment[] = [];

  const ai = getGenAI();
  if (ai) {
    assessments = await llmAssessCompletion(ai, topic, elapsedMinutes, avgFocusScore, doingTasks);
  } else {
    // Fallback: assume tasks matching topic are done if good focus, otherwise partial
    assessments = doingTasks.map(t => {
      const match = tokenize(topic).some(w => tokenize(t.title).includes(w) && w.length > 3);
      return {
        taskId: t.id,
        title: t.title,
        verdict: match && avgFocusScore >= 70 ? 'done' : 'partial',
        confidence: match && avgFocusScore >= 70 ? 'medium' : 'low',
        reason: match ? 'Title matches session topic' : 'No direct topic match',
      };
    });
  }

  const autoDone: string[] = [];
  const pendingReview: string[] = [];

  db.transaction(() => {
    for (const a of assessments) {
      if (a.verdict === 'done' && a.confidence === 'high') {
        // Auto-complete
        db.prepare(`
          UPDATE tasks
          SET status = 'done', completed_at = datetime('now')
          WHERE id = ? AND status = 'doing'
        `).run(a.taskId);
        // Award coins
        try {
          const task = db.prepare(`SELECT priority FROM tasks WHERE id = ?`).get(a.taskId) as { priority: string } | undefined;
          const coins = task?.priority === 'critical' ? 100 : task?.priority === 'high' ? 40 : task?.priority === 'low' ? 10 : 20;
          db.prepare(`INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)`).run(coins, `Auto-completed Task (ID: ${a.taskId}) after session`);
        } catch { }
        autoDone.push(a.title);
      } else if (a.verdict !== 'not_done') {
        // Add to review queue with assessment context as note
        const existing = db.prepare(`SELECT id FROM session_completions WHERE session_id = ? AND task_id = ?`).get(sessionId, a.taskId);
        if (!existing) {
          db.prepare(`
            INSERT INTO session_completions (session_id, task_id, status, blocker_note)
            VALUES (?, ?, 'pending', ?)
          `).run(sessionId, a.taskId, `${a.confidence} confidence: ${a.reason}`);
        }
        pendingReview.push(a.title);
      }
    }
  })();

  // Send Telegram summary
  const lines: string[] = [];
  if (autoDone.length > 0) {
    lines.push(`✅ <b>Auto-completed (${autoDone.length}):</b>\n${autoDone.map(t => `  • ${t}`).join('\n')}`);
  }
  if (pendingReview.length > 0) {
    lines.push(`📝 <b>Needs review (${pendingReview.length}):</b>\n${pendingReview.map(t => `  • ${t}`).join('\n')}\n<i>Use /review to confirm.</i>`);
  }
  if (lines.length > 0) {
    await sendTelegram(lines.join('\n\n'), 'HTML', FULL_MENU_KEYBOARD);
  }
}

async function llmAssessCompletion(
  ai: ReturnType<typeof getGenAI>,
  topic: string,
  elapsedMinutes: number,
  avgFocusScore: number,
  tasks: TaskRow[],
): Promise<CompletionAssessment[]> {
  if (!ai) return [];
  const taskList = tasks.map(t => `- ID ${t.id}: "${t.title}"`).join('\n');

  const prompt = `A focus session just ended.
Topic: "${topic}"
Duration: ${elapsedMinutes} minutes
Focus score: ${avgFocusScore}/100

Tasks that were in progress during this session:
${taskList}

For each task, assess whether it was likely completed during this session.
Consider: does the task title match the session topic? Was there enough time? Was focus good?

Respond ONLY with valid JSON (no markdown):
{
  "assessments": [
    { "taskId": <number>, "verdict": "done|partial|not_done", "confidence": "high|medium|low", "reason": "<one sentence>" }
  ]
}`;

  try {
    const res = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse((res.text || '{}').trim()) as {
      assessments: Array<{ taskId: number; verdict: string; confidence: string; reason: string }>;
    };
    return (parsed.assessments || []).map(a => ({
      taskId: a.taskId,
      title: tasks.find(t => t.id === a.taskId)?.title ?? '',
      verdict: (['done', 'partial', 'not_done'].includes(a.verdict) ? a.verdict : 'partial') as CompletionAssessment['verdict'],
      confidence: (['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'low') as CompletionAssessment['confidence'],
      reason: a.reason || '',
    })).filter(a => a.title);
  } catch (err) {
    console.error('[session-task-sync] LLM assessment failed:', err);
    return [];
  }
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}
