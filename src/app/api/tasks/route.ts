import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sanitizeText } from '@/lib/sanitize';
import { propagateMastery } from '@/lib/graph';
import { autoLinkTaskToGoal } from '@/lib/task-auto-linker';
import { triggerPrioritize } from '@/lib/task-priority-ranker';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { getAdaptiveTaskRecommendations } from '@/lib/adaptive-task-recommendations';
import { getTaskTimeProgress } from '@/lib/task-time-sessions';
import { getAdaptiveRewardDecision, getAdaptiveTaskRewardBase } from '@/lib/adaptive-rewards';
import { getAdaptiveSessionMinutes } from '@/lib/adaptive-command-defaults';
import { buildAdaptiveTaskDefaults } from '@/lib/adaptive-task-defaults';
import { reconcileActivePlanningState } from '@/lib/planning-reconciliation';

type TaskRow = Record<string, unknown> & {
    id: number;
    status: string;
    priority_rank: number | null;
    position: number | null;
    created_at: string;
    estimated_minutes?: number | null;
};

type ExistingTaskForPatch = {
    id: number;
    title: string;
    task_type: string | null;
    due_date: string | null;
    priority: string | null;
    estimated_minutes: number | null;
    energy_required: string | null;
};

// GET: Fetch all tasks, optionally filtered by status, or get daily history
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const status = searchParams.get('status');
        const history = searchParams.get('history');

        const db = getDb();

        // Day-by-day task history with daily scores
        if (history === 'true') {
            const days = parseInt(searchParams.get('days') || '14');
            const dailyHistory = db.prepare(`
                WITH RECURSIVE dates(d) AS (
                    SELECT date('now', '-${days} days')
                    UNION ALL SELECT date(d, '+1 day') FROM dates WHERE d < date('now')
                )
                SELECT 
                    dates.d as date,
                    COALESCE(assigned.count, 0) as tasks_assigned,
                    COALESCE(completed.count, 0) as tasks_completed,
                    COALESCE(pending.count, 0) as tasks_pending
                FROM dates
                LEFT JOIN (
                    SELECT date(created_at) as d, COUNT(*) as count
                    FROM tasks WHERE status IN ('todo', 'doing', 'done')
                    GROUP BY d
                ) assigned ON assigned.d = dates.d
                LEFT JOIN (
                    SELECT date(completed_at) as d, COUNT(*) as count
                    FROM tasks WHERE completed_at IS NOT NULL
                    GROUP BY d
                ) completed ON completed.d = dates.d
                LEFT JOIN (
                    SELECT date(created_at) as d, 
                        COUNT(*) as count
                    FROM tasks WHERE status IN ('todo', 'doing')
                    GROUP BY d
                ) pending ON pending.d = dates.d
                ORDER BY dates.d ASC
            `).all() as { date: string; tasks_assigned: number; tasks_completed: number; tasks_pending: number }[];

            const historyWithScores = dailyHistory.map(day => {
                const total = day.tasks_assigned || 1;
                const score = Math.min(100, Math.round((day.tasks_completed / total) * 100));
                return { ...day, task_score: day.tasks_assigned > 0 ? score : null };
            });

            const completedByDay = db.prepare(`
                SELECT title, status, date(completed_at) as completed_date, date(created_at) as created_date
                FROM tasks
                WHERE completed_at IS NOT NULL AND completed_at >= datetime('now', '-${days} days')
                ORDER BY completed_at DESC
            `).all();

            return NextResponse.json({ history: historyWithScores, completedTasks: completedByDay });
        }

        let query = 'SELECT * FROM tasks';
        const params: string[] = [];

        if (status) {
            query += ' WHERE status = ?';
            params.push(status);
        }

        query += ' ORDER BY CASE WHEN priority_rank IS NULL THEN 1 ELSE 0 END, priority_rank ASC, position ASC, created_at DESC';
        const rows = db.prepare(query).all(...params) as TaskRow[];
        const personalization = buildPersonalizationSnapshot({
            surface: 'tasks',
            maxInsights: 2,
            includeMemoryFacts: 4,
        });
        const recommendations = getAdaptiveTaskRecommendations(personalization, 50);
        const recommendationById = new Map(recommendations.map((task, index) => [task.id, { ...task, adaptiveRank: index + 1 }]));

        const tasks = rows.map(task => {
            const recommendation = recommendationById.get(task.id);
            return {
                ...task,
                adaptive_score: recommendation?.score ?? null,
                adaptive_rank: recommendation?.adaptiveRank ?? null,
                adaptive_reason: recommendation?.reason ?? null,
                adaptive_moment_fit: recommendation?.momentFit ?? null,
                adaptive_estimated_minutes: recommendation?.estimatedMinutes ?? null,
                adaptive_energy_required: recommendation?.energyRequired ?? null,
                time_progress: getTaskTimeProgress(task.id),
            };
        }).sort((a, b) => {
            const activeA = ['todo', 'doing'].includes(String(a.status));
            const activeB = ['todo', 'doing'].includes(String(b.status));
            if (activeA && activeB) {
                const scoreA = Number(a.adaptive_score ?? -Infinity);
                const scoreB = Number(b.adaptive_score ?? -Infinity);
                if (scoreA !== scoreB) return scoreB - scoreA;
            }
            if (activeA !== activeB) return activeA ? -1 : 1;
            const rankA = Number(a.priority_rank ?? Number.MAX_SAFE_INTEGER);
            const rankB = Number(b.priority_rank ?? Number.MAX_SAFE_INTEGER);
            if (rankA !== rankB) return rankA - rankB;
            return Number(a.position ?? 0) - Number(b.position ?? 0);
        });

        return NextResponse.json({
            tasks,
            personalization: {
                mode: personalization.moment.mode,
                guidance: personalization.moment.guidance,
                energy: personalization.userState.energy,
                mood: personalization.userState.mood,
                standupGoal: personalization.userState.standupGoal,
                alertFatigueLevel: personalization.feedback.alertFatigueLevel,
                nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
                recommendedSessionMinutes: getAdaptiveSessionMinutes(),
                plannedFocus: personalization.today.plannedFocus,
            },
        });
    } catch (error) {
        console.error('Tasks GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST: Create a new task
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { title, description, status, due_date, goal_id, priority, task_type, due_time, course } = body;

        if (!title) {
            return NextResponse.json({ error: 'title is required' }, { status: 400 });
        }

        const safeTitle = sanitizeText(title, 500);
        const safeDesc = sanitizeText(description || '', 2000);
        // Enforce simplified status model
        const safeStatus = ['todo', 'doing', 'done'].includes(status) ? status : 'todo';
        const safeType = ['task', 'assignment', 'exam'].includes(task_type) ? task_type : 'task';
        const personalization = buildPersonalizationSnapshot({
            surface: 'tasks',
            maxInsights: 2,
            includeMemoryFacts: 4,
        });
        const rawEstimatedMinutes = Number.parseInt(String(body.estimated_minutes ?? body.target_minutes ?? body.durationMinutes ?? ''), 10);
        const hasExplicitEstimate = Number.isFinite(rawEstimatedMinutes) && rawEstimatedMinutes > 0;
        const defaults = buildAdaptiveTaskDefaults({
            title: safeTitle,
            taskType: safeType,
            course: course || null,
            dueDate: due_date || null,
            explicitPriority: priority,
            explicitEstimateMinutes: hasExplicitEstimate ? rawEstimatedMinutes : undefined,
            explicitEnergyRequired: body.energy_required,
            snapshot: personalization,
        });

        const db = getDb();

        const maxPos = db.prepare(
            'SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM tasks WHERE status = ?'
        ).get(safeStatus) as { next_pos: number };

        const stmt = db.prepare(`
            INSERT INTO tasks (title, description, status, due_date, due_time, course, task_type, position, goal_id, priority, estimated_minutes, energy_required, completed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const result = stmt.run(
            safeTitle,
            safeDesc,
            safeStatus,
            due_date || null,
            due_time || null,
            course || null,
            safeType,
            maxPos.next_pos,
            goal_id || null,
            defaults.priority,
            defaults.estimatedMinutes,
            defaults.energyRequired,
            safeStatus === 'done' ? new Date().toISOString() : null
        );

        const taskId = Number(result.lastInsertRowid);

        // Fire-and-forget: auto-link to goal + re-rank all tasks
        if (typeof autoLinkTaskToGoal === 'function') {
            autoLinkTaskToGoal(taskId).catch(console.error);
        }
        triggerPrioritize();
        await reconcileActivePlanningState(new Date(), { regenerate: true });

        return NextResponse.json({
            id: taskId,
            estimated_minutes: defaults.estimatedMinutes,
            priority: defaults.priority,
            energy_required: defaults.energyRequired,
            adaptive_reason: hasExplicitEstimate
                ? defaults.reason
                : `${defaults.reason}; selected as the initial time target`,
        }, { status: 201 });
    } catch (error) {
        console.error('Tasks POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH: Update a task (move between columns, edit, complete)
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, title, description, status, due_date, due_time, course, task_type, position, goal_id, priority, priority_rank, energy_required } = body;

        if (!id) {
            return NextResponse.json({ error: 'id is required' }, { status: 400 });
        }

        const db = getDb();
        const existingTask = db.prepare(`
            SELECT id, title, task_type, due_date, priority, estimated_minutes, energy_required
            FROM tasks
            WHERE id = ?
        `).get(id) as ExistingTaskForPatch | undefined;
        if (!existingTask) {
            return NextResponse.json({ error: 'task not found' }, { status: 404 });
        }
        const updates: string[] = [];
        const params: (string | number | null)[] = [];
        const explicitEstimate = body.estimated_minutes !== undefined || body.target_minutes !== undefined;

        // Track whether we need a re-rank
        let needsRerank = false;

        if (title !== undefined) {
            updates.push('title = ?');
            params.push(sanitizeText(title, 500));
            needsRerank = true;
        }
        if (description !== undefined) { updates.push('description = ?'); params.push(sanitizeText(description, 2000)); }
        if (task_type !== undefined) {
            const safeType = ['task', 'assignment', 'exam'].includes(task_type) ? task_type : 'task';
            updates.push('task_type = ?');
            params.push(safeType);
            needsRerank = true;
        }
        if (course !== undefined) { updates.push('course = ?'); params.push(course); }
        if (status !== undefined) {
            const safeStatus = ['todo', 'doing', 'done'].includes(status) ? status : 'todo';
            updates.push('status = ?');
            params.push(safeStatus);
            if (safeStatus === 'done') {
                const progress = getTaskTimeProgress(Number(id));
                if (progress.targetMinutes === null) {
                    return NextResponse.json({
                        error: 'time_target_required',
                        message: 'Task needs a time target before completion. Add a target and complete linked focus sessions against it.',
                        progress,
                    }, { status: 409 });
                }
                if (progress.creditedMinutes < progress.targetMinutes) {
                    return NextResponse.json({
                        error: 'time_target_not_reached',
                        message: `Task needs ${progress.remainingMinutes} more linked focus minute${progress.remainingMinutes === 1 ? '' : 's'} before completion.`,
                        progress,
                    }, { status: 409 });
                }
                updates.push("completed_at = datetime('now')");
                try {
                    const task = db.prepare('SELECT title, status, priority, estimated_minutes FROM tasks WHERE id = ?').get(id) as { title: string; status: string; priority: string; estimated_minutes: number | null };
                    if (task?.status !== 'done') {
                        const snapshot = buildPersonalizationSnapshot({ surface: 'rewards', maxInsights: 2, includeMemoryFacts: 3 });
                        const rewardBase = getAdaptiveTaskRewardBase({
                            taskId: id,
                            title: task?.title ?? `Task ${id}`,
                            priority: task?.priority,
                            targetMinutes: task?.estimated_minutes ?? getAdaptiveSessionMinutes(),
                            snapshot,
                        });
                        const reward = getAdaptiveRewardDecision({
                            action: 'task_auto_complete',
                            baseCoins: rewardBase.baseCoins,
                            priority: task?.priority,
                            subject: task?.title ? `${task.title} (manual completion; ${rewardBase.reason})` : `Task ${id} (${rewardBase.reason})`,
                            snapshot,
                        });
                        db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(reward.coins, reward.ledgerReason);
                        try { propagateMastery(id, null); } catch { /* non-critical */ }
                    }
                } catch (e) { console.error('Error awarding task coins:', e); }
            } else {
                updates.push('completed_at = NULL');
            }
        }
        if (due_date !== undefined) {
            updates.push('due_date = ?');
            params.push(due_date);
            needsRerank = true;
        }
        if (due_time !== undefined) { updates.push('due_time = ?'); params.push(due_time); }
        if (position !== undefined) { updates.push('position = ?'); params.push(position); }
        if (goal_id !== undefined) { updates.push('goal_id = ?'); params.push(goal_id); }
        if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
        if (energy_required !== undefined) { updates.push('energy_required = ?'); params.push(energy_required); }
        if (priority_rank !== undefined) { updates.push('priority_rank = ?'); params.push(priority_rank); }
        if (explicitEstimate) {
            const rawEstimatedMinutes = Number.parseInt(String(body.estimated_minutes ?? body.target_minutes), 10);
            if (!Number.isFinite(rawEstimatedMinutes) || rawEstimatedMinutes <= 0) {
                return NextResponse.json({ error: 'estimated_minutes must be a positive number' }, { status: 400 });
            }
            updates.push('estimated_minutes = ?');
            params.push(Math.min(720, rawEstimatedMinutes));
            needsRerank = true;
        }
        if (
            needsRerank &&
            status === undefined &&
            (title !== undefined || task_type !== undefined || due_date !== undefined) &&
            (priority === undefined || energy_required === undefined || !explicitEstimate)
        ) {
            const nextTitle = title !== undefined ? sanitizeText(title, 500) : existingTask.title;
            const nextType = task_type !== undefined && ['task', 'assignment', 'exam'].includes(task_type)
                ? task_type
                : existingTask.task_type;
            const nextDueDate = due_date !== undefined ? due_date || null : existingTask.due_date;
            const personalization = buildPersonalizationSnapshot({
                surface: 'tasks',
                maxInsights: 2,
                includeMemoryFacts: 4,
            });
            const defaults = buildAdaptiveTaskDefaults({
                title: nextTitle,
                taskType: nextType,
                dueDate: nextDueDate,
                explicitPriority: priority,
                explicitEstimateMinutes: explicitEstimate ? body.estimated_minutes ?? body.target_minutes : undefined,
                explicitEnergyRequired: energy_required,
                snapshot: personalization,
            });

            if (priority === undefined) {
                updates.push('priority = ?');
                params.push(defaults.priority);
            }
            if (energy_required === undefined) {
                updates.push('energy_required = ?');
                params.push(defaults.energyRequired);
            }
            if (!explicitEstimate) {
                const progress = getTaskTimeProgress(Number(id));
                if (progress.creditedMinutes === 0) {
                    updates.push('estimated_minutes = ?');
                    params.push(defaults.estimatedMinutes);
                }
            }
        }

        if (updates.length === 0) {
            return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
        }

        params.push(id);
        db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        // Re-rank if deadline, title, or type changed
        if (needsRerank) triggerPrioritize();

        await reconcileActivePlanningState(new Date(), { regenerate: true });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Tasks PATCH error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// DELETE: Delete a task
export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'id is required' }, { status: 400 });
        }

        const db = getDb();
        db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
        await reconcileActivePlanningState(new Date(), { regenerate: true });

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Tasks DELETE error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
