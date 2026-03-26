import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sanitizeText } from '@/lib/sanitize';
import { propagateMastery } from '@/lib/graph';
import { autoLinkTaskToGoal } from '@/lib/task-auto-linker';
import { triggerPrioritize } from '@/lib/task-priority-ranker';

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
        const tasks = db.prepare(query).all(...params);

        return NextResponse.json({ tasks });
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

        const db = getDb();

        const maxPos = db.prepare(
            'SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM tasks WHERE status = ?'
        ).get(safeStatus) as { next_pos: number };

        const stmt = db.prepare(`
            INSERT INTO tasks (title, description, status, due_date, due_time, course, task_type, position, goal_id, priority)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            priority || 'medium'
        );

        const taskId = Number(result.lastInsertRowid);

        // Fire-and-forget: auto-link to goal + re-rank all tasks
        if (typeof autoLinkTaskToGoal === 'function') {
            autoLinkTaskToGoal(taskId).catch(console.error);
        }
        triggerPrioritize();

        return NextResponse.json({ id: taskId }, { status: 201 });
    } catch (error) {
        console.error('Tasks POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH: Update a task (move between columns, edit, complete)
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, title, description, status, due_date, due_time, course, task_type, position, goal_id, priority, priority_rank } = body;

        if (!id) {
            return NextResponse.json({ error: 'id is required' }, { status: 400 });
        }

        const db = getDb();
        const updates: string[] = [];
        const params: (string | number | null)[] = [];

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
                updates.push("completed_at = datetime('now')");
                try {
                    const task = db.prepare('SELECT priority FROM tasks WHERE id = ?').get(id) as { priority: string };
                    let coins = 20;
                    if (task) {
                        if (task.priority === 'low') coins = 10;
                        if (task.priority === 'high') coins = 40;
                        if (task.priority === 'critical') coins = 100;
                    }
                    db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(coins, `Completed Task (ID: ${id})`);
                    try { propagateMastery(id, null); } catch { /* non-critical */ }
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
        if (priority_rank !== undefined) { updates.push('priority_rank = ?'); params.push(priority_rank); }

        if (updates.length === 0) {
            return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
        }

        params.push(id);
        db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        // Re-rank if deadline, title, or type changed
        if (needsRerank) triggerPrioritize();

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

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Tasks DELETE error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
