/**
 * task-auto-linker.ts
 * LLM-based automatic task → goal linking.
 * Runs fire-and-forget after task creation and on-demand via /api/tasks/auto-link.
 */

import { getDb } from './db';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';

interface GoalRow {
  id: number;
  title: string;
  description: string | null;
  category: string;
}

interface TaskRow {
  id: number;
  title: string;
  description: string | null;
}

/**
 * Ask the LLM which goal best matches a given task.
 * Returns the goalId to link, or null if no good match.
 */
export async function autoLinkTaskToGoal(taskId: number): Promise<number | null> {
  const db = getDb();
  const task = db.prepare(`SELECT id, title, description FROM tasks WHERE id = ?`).get(taskId) as TaskRow | undefined;
  if (!task) return null;

  const goals = db.prepare(`SELECT id, title, description, category FROM goals WHERE active = 1`).all() as GoalRow[];
  if (goals.length === 0) return null;

  const ai = getGenAI();
  if (!ai) {
    // Fallback: keyword overlap scoring
    return keywordMatchGoal(task, goals);
  }

  const goalList = goals.map(g =>
    `- ID ${g.id}: "${g.title}" [${g.category}]${g.description ? ` — ${g.description.slice(0, 80)}` : ''}`
  ).join('\n');

  const prompt = `You are a task organiser. Match the task to the best goal, or return null if no goal fits.

GOALS:
${goalList}

TASK: "${task.title}"${task.description ? `\nDescription: "${task.description.slice(0, 200)}"` : ''}

Respond ONLY with valid JSON (no markdown):
{"goalId": <number or null>, "confidence": "high|medium|low", "reason": "<one sentence>"}`;

  try {
    const res = await generateWithFallback(ai, {
      model: MODEL_FLASH,
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse((res.text || '{}').trim()) as {
      goalId: number | null;
      confidence: string;
      reason: string;
    };
    // Only link on high or medium confidence
    if (parsed.goalId && (parsed.confidence === 'high' || parsed.confidence === 'medium')) {
      const valid = goals.find(g => g.id === parsed.goalId);
      if (valid) {
        db.prepare(`UPDATE tasks SET goal_id = ? WHERE id = ? AND goal_id IS NULL`).run(parsed.goalId, taskId);
        console.log(`[auto-linker] Task ${taskId} → Goal ${parsed.goalId} (${parsed.confidence}): ${parsed.reason}`);
        return parsed.goalId;
      }
    }
    return null;
  } catch (err) {
    console.error('[auto-linker] LLM failed, falling back to keyword match:', err);
    return keywordMatchGoal(task, goals);
  }
}

/** Simple keyword fallback when LLM is unavailable. */
function keywordMatchGoal(task: TaskRow, goals: GoalRow[]): number | null {
  const taskWords = tokenize(`${task.title} ${task.description || ''}`);
  let bestGoal: GoalRow | null = null;
  let bestScore = 0;

  for (const goal of goals) {
    const goalWords = tokenize(`${goal.title} ${goal.description || ''} ${goal.category}`);
    const overlap = taskWords.filter(w => goalWords.includes(w) && w.length > 3).length;
    if (overlap > bestScore) {
      bestScore = overlap;
      bestGoal = goal;
    }
  }

  if (bestGoal && bestScore >= 2) {
    const db = getDb();
    db.prepare(`UPDATE tasks SET goal_id = ? WHERE id = ? AND goal_id IS NULL`).run(bestGoal.id, task.id);
    return bestGoal.id;
  }
  return null;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Batch re-link all tasks that have no goal_id.
 * Runs sequentially to avoid rate-limit spikes.
 */
export async function autoLinkAllUnlinkedTasks(): Promise<{ linked: number; unchanged: number }> {
  const db = getDb();
  const unlinked = db.prepare(`
    SELECT id FROM tasks WHERE goal_id IS NULL AND status NOT IN ('done', 'cancelled')
  `).all() as { id: number }[];

  let linked = 0;
  for (const { id } of unlinked) {
    const result = await autoLinkTaskToGoal(id);
    if (result !== null) linked++;
  }
  return { linked, unchanged: unlinked.length - linked };
}
