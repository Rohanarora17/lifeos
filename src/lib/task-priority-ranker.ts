/**
 * task-priority-ranker.ts
 * LLM-driven task priority ranking for student-focused task management.
 * Runs fire-and-forget after task creation, edits, or on-demand via API.
 * Stores rank + reason on each task row so session-task-ranker reads them directly.
 */

import { getDb } from './db';
import { getGenAI, generateWithFallback } from './ai';
import { MODEL_FLASH } from './models';
import { computeEnergyComposite } from './energy-composite';
import { classifyEnergy } from './adaptive-bands';

interface TaskRow {
    id: number;
    title: string;
    due_date: string | null;
    due_time: string | null;
    task_type: string;
    course: string | null;
    priority: string;
    energy_required: string;
    goal_id: number | null;
}

interface GoalRow {
    id: number;
    title: string;
    health_status: string | null;
    deadline: string | null;
}

function daysUntil(due: string | null): number | null {
    if (!due) return null;
    const today = new Date(Date.now() + 19800000); // IST
    today.setHours(0, 0, 0, 0);
    const dueDate = new Date(due);
    dueDate.setHours(0, 0, 0, 0);
    return Math.round((dueDate.getTime() - today.getTime()) / 86400000);
}

/**
 * Rank all non-done tasks using Gemini Flash.
 * Writes priority_rank + priority_reason back to the DB.
 */
export async function prioritizeAllTasks(): Promise<number> {
    const db = getDb();

    const tasks = db.prepare(`
    SELECT id, title, due_date, due_time, task_type, course, priority, energy_required, goal_id
    FROM tasks
    WHERE status NOT IN ('done', 'cancelled')
    ORDER BY id ASC
  `).all() as TaskRow[];

    if (tasks.length === 0) return 0;

    const goals = db.prepare(`
    SELECT id, title, health_status, deadline
    FROM goals
    WHERE active = 1
    ORDER BY id ASC
  `).all() as GoalRow[];

    const ai = getGenAI();
    if (!ai) {
        // Fallback: sort by due_date then priority
        tasks.sort((a, b) => {
            const da = daysUntil(a.due_date);
            const db2 = daysUntil(b.due_date);
            if (da === null && db2 === null) return 0;
            if (da === null) return 1;
            if (db2 === null) return -1;
            return da - db2;
        });
        tasks.forEach((t, i) => {
            db.prepare('UPDATE tasks SET priority_rank = ?, priority_reason = ? WHERE id = ?')
                .run(i + 1, 'deadline order', t.id);
        });
        return tasks.length;
    }

    const now = new Date(Date.now() + 19800000);
    const dateStr = now.toISOString().slice(0, 10);
    const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });

    let energy = 50;
    let energyBand = 'medium';
    try {
        const ec = computeEnergyComposite();
        energy = ec.composite_score;
        energyBand = classifyEnergy(energy);
    } catch { /* non-fatal */ }

    const goalLines = goals.map(g => {
        const daysLeft = daysUntil(g.deadline);
        const deadlineStr = daysLeft !== null ? `deadline in ${daysLeft} days` : 'no deadline';
        return `- "${g.title}" [${g.health_status ?? 'on_track'}, ${deadlineStr}]`;
    }).join('\n');

    const taskLines = tasks.map((t, i) => {
        const days = daysUntil(t.due_date);
        const dueStr = days === null
            ? 'no deadline'
            : days < 0
                ? `OVERDUE (${Math.abs(days)}d ago)`
                : days === 0
                    ? `due TODAY${t.due_time ? ` ${t.due_time}` : ''}`
                    : `due in ${days}d${t.due_time ? ` ${t.due_time}` : ''}`;
        const courseTag = t.course ? `[${t.course}] ` : '';
        return `[${i + 1}] ${courseTag}${t.title} | ${dueStr} | ${t.task_type} | energy: ${t.energy_required} | priority: ${t.priority}`;
    }).join('\n');

    const prompt = `You are a student productivity prioritizer. Rank ALL tasks from most to least urgent/important.

TODAY: ${dateStr} (${dayName})
ENERGY: ${energyBand} (${energy}/100)

ACTIVE GOALS:
${goalLines || '- No active goals'}

TASKS:
${taskLines}

Rules:
- Overdue items rank highest unless they can't be undone
- Deadlines within 3 days always rank near the top
- Exams rank above assignments of equal urgency
- Undeadlined tasks ranked by goal health and energy fit

Respond ONLY with valid JSON (no markdown):
{"prioritized": [{"taskId": <number>, "rank": <1=highest>, "reason": "<≤10 words>"}, ...]}`;

    try {
        const res = await generateWithFallback(ai, {
            model: MODEL_FLASH,
            contents: prompt,
            config: { responseMimeType: 'application/json' },
        });

        const parsed = JSON.parse((res.text || '{}').trim()) as {
            prioritized: Array<{ taskId: number; rank: number; reason: string }>;
        };

        if (!Array.isArray(parsed.prioritized)) throw new Error('Invalid LLM response shape');

        const update = db.prepare('UPDATE tasks SET priority_rank = ?, priority_reason = ? WHERE id = ?');
        const updateMany = db.transaction((items: typeof parsed.prioritized) => {
            for (const item of items) {
                update.run(item.rank, item.reason, item.taskId);
            }
        });
        updateMany(parsed.prioritized);

        console.log(`[TaskPriorityRanker] Ranked ${parsed.prioritized.length} tasks`);
        return parsed.prioritized.length;
    } catch (err) {
        console.error('[TaskPriorityRanker] Failed:', err);
        return 0;
    }
}

/**
 * Fire-and-forget wrapper — safe to call after task mutations.
 */
export function triggerPrioritize(): void {
    prioritizeAllTasks().catch(err => console.error('[TaskPriorityRanker] Background rank failed:', err));
}
