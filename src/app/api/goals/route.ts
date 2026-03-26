import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sanitizeText } from '@/lib/sanitize';

// GET — List goals with linked tasks, habits, computed progress, TMT motivation, and self-efficacy
export async function GET() {
    const db = getDb();
    const goals = db.prepare('SELECT * FROM goals ORDER BY active DESC, created_at DESC').all() as any[];

    // Compute rolling self-efficacy (task success rate over last 14 days)
    const efficacyRow = db.prepare(`
        SELECT 
            COUNT(CASE WHEN status = 'done' THEN 1 END) as completed,
            COUNT(*) as total
        FROM tasks 
        WHERE status IN ('todo', 'doing', 'done')
        AND created_at >= datetime('now', '-14 days')
    `).get() as { completed: number; total: number };
    const selfEfficacy = efficacyRow.total > 0
        ? Math.round((efficacyRow.completed / efficacyRow.total) * 100)
        : 50; // default to 50% when no data

    for (const goal of goals) {
        // Get linked tasks
        const linkedTasks = db.prepare(
            'SELECT id, title, status, completed_at FROM tasks WHERE goal_id = ? ORDER BY position ASC'
        ).all(goal.id) as { id: number; title: string; status: string; completed_at: string | null }[];

        // Get linked habits
        const linkedHabits = db.prepare(`
            SELECT h.id, h.name, h.icon,
                (SELECT COUNT(*) FROM habit_checkins WHERE habit_id = h.id AND completed = 1) as total_checkins,
                (SELECT COUNT(DISTINCT date) FROM habit_checkins WHERE habit_id = h.id AND completed = 1 AND date >= date('now', '-7 days')) as week_checkins
            FROM habits h WHERE h.goal_id = ? AND h.archived = 0
        `).all(goal.id) as any[];

        // Compute progress from linked tasks
        const totalTasks = linkedTasks.length;
        const completedTasks = linkedTasks.filter(t => t.status === 'done').length;
        const taskProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

        // Factor in habit consistency for overall goal health
        const habitHealth = linkedHabits.length > 0
            ? Math.round(linkedHabits.reduce((sum: number, h: any) => sum + (h.week_checkins / 7) * 100, 0) / linkedHabits.length)
            : null;

        // Overall goal progress: weighted blend of task completion + habit consistency
        const progress = habitHealth !== null
            ? Math.round(taskProgress * 0.7 + habitHealth * 0.3)  // tasks weigh more
            : taskProgress;

        // TMT Motivation Score: (Expectancy × Value) / (1 + Impulsiveness × Delay)
        // Expectancy = self-efficacy (0-1), Value = 1 for active goals, Delay = days until deadline
        let tmtScore = null;
        if (goal.deadline && goal.active) {
            const daysUntilDeadline = Math.max(0,
                Math.round((new Date(goal.deadline).getTime() - Date.now()) / 86400000)
            );
            const expectancy = selfEfficacy / 100;
            const value = 1.0;  // all active goals have full value
            const impulsiveness = 0.5;  // moderate default
            const delay = daysUntilDeadline;
            tmtScore = Math.round(((expectancy * value) / (1 + impulsiveness * delay)) * 100);
        }

        // Goal gradient: are we accelerating? Compare recent task completion rate to earlier rate
        let momentum = null;
        if (totalTasks >= 4) {
            const recent = linkedTasks.filter(t => t.completed_at &&
                new Date(t.completed_at).getTime() > Date.now() - 7 * 86400000).length;
            const earlier = completedTasks - recent;
            const earlierDays = Math.max(1, Math.round(
                (Date.now() - new Date(goal.created_at).getTime()) / 86400000) - 7);
            const recentRate = recent / 7;
            const earlierRate = earlier / earlierDays;
            if (earlierRate > 0) {
                momentum = Math.round(((recentRate - earlierRate) / earlierRate) * 100);
            }
        }

        const intentions = db.prepare(`
            SELECT id, if_condition, then_action, active, times_triggered
            FROM intentions WHERE goal_id = ? AND active = 1
        `).all(goal.id);

        goal.linkedTasks = linkedTasks;
        goal.linkedHabits = linkedHabits;
        goal.intentions = intentions;
        goal.progress = progress;
        goal.taskProgress = taskProgress;
        goal.habitHealth = habitHealth;
        goal.completedTasks = completedTasks;
        goal.totalTasks = totalTasks;
        goal.tmtScore = tmtScore;
        goal.momentum = momentum;
    }

    return NextResponse.json({ goals, selfEfficacy });
}

// POST — Create goal
export async function POST(request: Request) {
    const body = await request.json();
    const { title, description, type, metric, target_value, unit, category, deadline } = body;

    if (!title) {
        return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const db = getDb();
    const result = db.prepare(
        'INSERT INTO goals (title, description, type, metric, target_value, unit, category, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
        sanitizeText(title, 300), sanitizeText(description || '', 2000), type || 'general', metric || 'tasks',
        target_value || 1, unit || 'tasks', category || 'productivity', deadline || null
    );

    return NextResponse.json({ id: result.lastInsertRowid });
}

// PATCH — Update goal
export async function PATCH(request: Request) {
    const body = await request.json();
    const { id, ...updates } = body;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const db = getDb();
    const allowed = ['title', 'description', 'type', 'metric', 'target_value', 'unit', 'category', 'deadline', 'active'];
    const textFields = ['title', 'description'];
    const fields = Object.keys(updates).filter(k => allowed.includes(k)).map(k => `${k} = ?`).join(', ');
    const values = Object.keys(updates).filter(k => allowed.includes(k)).map(k =>
        textFields.includes(k) ? sanitizeText(updates[k], k === 'title' ? 300 : 2000) : updates[k]
    );

    if (fields) {
        db.prepare(`UPDATE goals SET ${fields} WHERE id = ?`).run(...values, id);
    }

    return NextResponse.json({ ok: true });
}

// DELETE — Delete goal (unlinks tasks/habits but doesn't delete them)
export async function DELETE(request: Request) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const db = getDb();
    // Unlink tasks and habits before deleting
    db.prepare('UPDATE tasks SET goal_id = NULL WHERE goal_id = ?').run(id);
    db.prepare('UPDATE habits SET goal_id = NULL WHERE goal_id = ?').run(id);
    db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    return NextResponse.json({ ok: true });
}
