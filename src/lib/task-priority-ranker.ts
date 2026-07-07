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
import { buildPersonalizationSnapshot, formatPersonalizationContext } from './personalization-context';
import { getAdaptiveTaskRecommendations, type AdaptiveRecommendedTask } from './adaptive-task-recommendations';

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

interface RankedPriorityItem {
    taskId: number;
    rank: number;
    reason: string;
}

function daysUntil(due: string | null): number | null {
    if (!due) return null;
    const today = new Date(Date.now() + 19800000); // IST
    today.setHours(0, 0, 0, 0);
    const dueDate = new Date(due);
    dueDate.setHours(0, 0, 0, 0);
    return Math.round((dueDate.getTime() - today.getTime()) / 86400000);
}

function dueSortValue(task: TaskRow): number {
    const days = daysUntil(task.due_date);
    if (days === null) return Number.MAX_SAFE_INTEGER;
    return days;
}

function compactReason(reason: string, prefix?: string): string {
    const text = prefix ? `${prefix}: ${reason}` : reason;
    return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

function applyRankings(items: RankedPriorityItem[]): number {
    const db = getDb();
    const update = db.prepare('UPDATE tasks SET priority_rank = ?, priority_reason = ? WHERE id = ?');
    const updateMany = db.transaction((rankedItems: RankedPriorityItem[]) => {
        for (const item of rankedItems) {
            update.run(item.rank, compactReason(item.reason), item.taskId);
        }
    });
    updateMany(items);
    return items.length;
}

function buildAdaptiveRankings(tasks: TaskRow[], recommendations: AdaptiveRecommendedTask[]): RankedPriorityItem[] {
    const recs = new Map(recommendations.map(rec => [rec.id, rec]));
    return [...tasks]
        .sort((a, b) => {
            const recA = recs.get(a.id);
            const recB = recs.get(b.id);
            const scoreDiff = (recB?.score ?? Number.NEGATIVE_INFINITY) - (recA?.score ?? Number.NEGATIVE_INFINITY);
            if (scoreDiff !== 0) return scoreDiff;
            const dueDiff = dueSortValue(a) - dueSortValue(b);
            if (dueDiff !== 0) return dueDiff;
            const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
            return (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2);
        })
        .map((task, index) => {
            const rec = recs.get(task.id);
            return {
                taskId: task.id,
                rank: index + 1,
                reason: rec
                    ? compactReason(`${rec.momentFit} fit · ${rec.reason}`, 'adaptive')
                    : compactReason(task.due_date ? `due ${task.due_date}` : 'fallback priority order', 'adaptive'),
            };
        });
}

function mergeLlmRankings(
    tasks: TaskRow[],
    llmItems: RankedPriorityItem[],
    adaptiveItems: RankedPriorityItem[],
): RankedPriorityItem[] {
    const taskIds = new Set(tasks.map(task => task.id));
    const adaptiveById = new Map(adaptiveItems.map(item => [item.taskId, item]));
    const seen = new Set<number>();
    const merged: RankedPriorityItem[] = [];

    for (const item of [...llmItems].sort((a, b) => a.rank - b.rank)) {
        if (!taskIds.has(item.taskId) || seen.has(item.taskId)) continue;
        seen.add(item.taskId);
        const adaptive = adaptiveById.get(item.taskId);
        merged.push({
            taskId: item.taskId,
            rank: merged.length + 1,
            reason: compactReason(adaptive ? `${item.reason} · ${adaptive.reason}` : item.reason),
        });
    }

    for (const item of adaptiveItems) {
        if (seen.has(item.taskId)) continue;
        seen.add(item.taskId);
        merged.push({
            ...item,
            rank: merged.length + 1,
        });
    }

    return merged;
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
    const personalization = buildPersonalizationSnapshot({
        surface: 'tasks',
        maxInsights: 3,
        includeMemoryFacts: 5,
    });
    const adaptiveRecommendations = getAdaptiveTaskRecommendations(personalization, Math.max(tasks.length, 20));
    const adaptiveRankings = buildAdaptiveRankings(tasks, adaptiveRecommendations);

    const goals = db.prepare(`
    SELECT id, title, health_status, deadline
    FROM goals
    WHERE active = 1
    ORDER BY id ASC
  `).all() as GoalRow[];

    const ai = getGenAI();
    if (!ai) {
        return applyRankings(adaptiveRankings);
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

    const adaptiveLines = adaptiveRecommendations.map((rec, index) =>
        `${index + 1}. task ${rec.id}: score ${rec.score}, ${rec.momentFit} fit, ${rec.reason}`
    ).join('\n');

    const prompt = `You are LifeOS's personalized task prioritizer. Rank ALL tasks for this user's current day, not for a generic student.

TODAY: ${dateStr} (${dayName})
ENERGY: ${energyBand} (${energy}/100)

${formatPersonalizationContext(personalization)}

ACTIVE GOALS:
${goalLines || '- No active goals'}

TASKS:
${taskLines}

ADAPTIVE MODEL BASELINE:
${adaptiveLines || '- No adaptive baseline available'}

Rules:
- Use the adaptive baseline as grounding, but override it when a real deadline, exam, active goal, or user feedback makes another order more useful.
- In recovery mode, prefer minimum viable, low-energy progress unless a deadline is truly dangerous.
- In deadline_pressure mode, prioritize concrete deadline relief and demote unrelated low-urgency work.
- In protect_focus mode, keep already-started relevant work near the top so ranking does not create a context switch.
- In planning mode, prefer cleanup, sequencing, and tasks that make tomorrow easier.
- Do not rank an item high only because it is generically important; explain why it fits this user's current day.

Respond ONLY with valid JSON (no markdown):
{"prioritized": [{"taskId": <number>, "rank": <1=highest>, "reason": "<≤10 words>"}, ...]}`;

    try {
        const res = await generateWithFallback(ai, {
            model: MODEL_FLASH,
            contents: prompt,
            config: { responseMimeType: 'application/json' },
        });

        const parsed = JSON.parse((res.text || '{}').trim()) as {
            prioritized: RankedPriorityItem[];
        };

        if (!Array.isArray(parsed.prioritized)) throw new Error('Invalid LLM response shape');

        const mergedRankings = mergeLlmRankings(tasks, parsed.prioritized, adaptiveRankings);
        const ranked = applyRankings(mergedRankings);

        console.log(`[TaskPriorityRanker] Ranked ${ranked} tasks`);
        return ranked;
    } catch (err) {
        console.error('[TaskPriorityRanker] Failed:', err);
        return applyRankings(adaptiveRankings);
    }
}

/**
 * Fire-and-forget wrapper — safe to call after task mutations.
 */
export function triggerPrioritize(): void {
    prioritizeAllTasks().catch(err => console.error('[TaskPriorityRanker] Background rank failed:', err));
}
