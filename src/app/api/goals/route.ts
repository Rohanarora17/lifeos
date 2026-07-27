import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { sanitizeText } from '@/lib/sanitize';
import { buildPersonalizationSnapshot, type PersonalizationSnapshot } from '@/lib/personalization-context';
import { buildAdaptiveGoalPolicy } from '@/lib/adaptive-goal-policy';

type LinkedTask = { id: number; title: string; status: string; completed_at: string | null };
type LinkedHabit = { id: number; name: string; icon: string; total_checkins: number; week_checkins: number };
type GoalRecord = {
    id: number;
    title: string;
    description?: string | null;
    type?: string | null;
    category?: string | null;
    deadline: string | null;
    active: number;
    archived?: number | null;
    created_at: string;
    health_status: 'on_track' | 'at_risk' | 'off_track' | null;
    velocity_needed: number | null;
    actual_velocity: number | null;
    [key: string]: unknown;
};

function textMatches(text: string | null | undefined, query: string | null | undefined): boolean {
    if (!text || !query) return false;
    const textLower = text.toLowerCase();
    const terms = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(term => term.length >= 4);
    return terms.length > 0 && terms.some(term => textLower.includes(term));
}

function clamp01(value: number): number {
    return Math.max(0.05, Math.min(1, value));
}

function buildAdaptiveGoalMotivation(input: {
    goal: GoalRecord;
    linkedTasks: LinkedTask[];
    linkedHabits: LinkedHabit[];
    selfEfficacy: number;
    snapshot: PersonalizationSnapshot;
}) {
    const { goal, linkedTasks, linkedHabits, selfEfficacy, snapshot } = input;
    const active = Number(goal.active ?? 0) === 1;
    const goalTitle = goal.title;
    const standupMatch = textMatches(goalTitle, snapshot.userState.standupGoal) ||
        linkedTasks.some(task => textMatches(task.title, snapshot.userState.standupGoal));
    const doingMatch = snapshot.today.doingTasks.some(taskTitle =>
        textMatches(goalTitle, taskTitle) ||
        linkedTasks.some(task => textMatches(task.title, taskTitle))
    );
    const incompleteTask = linkedTasks.find(task => task.status !== 'done');
    const underdoneHabit = linkedHabits.find(habit => habit.week_checkins < 5);

    let expectancy = selfEfficacy / 100;
    let value = active ? 1.0 : 0.25;
    let impulsiveness = 0.5;
    const reasons: string[] = [];

    if (standupMatch) {
        value += 0.35;
        expectancy += 0.08;
        reasons.push('matches today goal');
    }
    if (doingMatch) {
        value += 0.2;
        reasons.push('already in motion');
    }
    if (goal.health_status === 'off_track') {
        value += 0.25;
        reasons.push('off track');
    } else if (goal.health_status === 'at_risk') {
        value += 0.15;
        reasons.push('at risk');
    }

    if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low') {
        impulsiveness += 0.2;
        expectancy -= 0.05;
        reasons.push('low-energy day');
    }
    if (snapshot.moment.mode === 'deadline_pressure') {
        value += 0.2;
        impulsiveness = Math.max(0.25, impulsiveness - 0.15);
        reasons.push('deadline-pressure mode');
    }
    if (snapshot.moment.mode === 'protect_focus') {
        impulsiveness = Math.max(0.25, impulsiveness - 0.1);
        reasons.push('protect focus');
    }
    if (snapshot.feedback.alertFatigueLevel === 'high') {
        impulsiveness += 0.15;
        reasons.push('alert fatigue high');
    }

    const daysUntilDeadline = goal.deadline && active
        ? Math.max(0, Math.round((new Date(goal.deadline).getTime() - Date.now()) / 86400000))
        : null;
    const delay = daysUntilDeadline ?? 14;
    const tmtScore = active
        ? Math.round(((clamp01(expectancy) * value) / (1 + impulsiveness * delay)) * 100)
        : null;

    const nextAction = snapshot.moment.mode === 'recovery'
        ? `Minimum viable step: ${incompleteTask ? incompleteTask.title : underdoneHabit ? `${underdoneHabit.icon} ${underdoneHabit.name}` : goalTitle} for 10 minutes.`
        : snapshot.moment.mode === 'deadline_pressure'
            ? `Move this first: ${incompleteTask?.title || goalTitle}.`
            : snapshot.moment.mode === 'planning'
                ? `Define the next concrete task for ${goalTitle}.`
                : incompleteTask
                    ? `Next best step: ${incompleteTask.title}.`
                    : underdoneHabit
                        ? `Stabilize habit support: ${underdoneHabit.icon} ${underdoneHabit.name}.`
                        : 'No obvious next action; review whether this goal still matters.';

    return {
        tmtScore,
        tmtReason: reasons.slice(0, 4).join(' · ') || snapshot.moment.guidance,
        adaptiveNextAction: nextAction,
        adaptiveMode: snapshot.moment.mode,
        adaptiveValue: Number(value.toFixed(2)),
        adaptiveImpulsiveness: Number(impulsiveness.toFixed(2)),
    };
}

// GET — List goals with linked tasks, habits, computed progress, TMT motivation, and self-efficacy
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const showAll = searchParams.get('all') === 'true';
    const db = getDb();
    const personalization = buildPersonalizationSnapshot({
        surface: 'dashboard',
        maxInsights: 2,
        includeMemoryFacts: 4,
    });
    // By default only return active (non-archived) goals — mirrors what the dashboard shows.
    // Pass ?all=true to include archived goals (e.g. for admin/history views).
    const goals = db.prepare(
        showAll
            ? 'SELECT * FROM goals ORDER BY active DESC, created_at DESC'
            : 'SELECT * FROM goals WHERE active = 1 AND (archived = 0 OR archived IS NULL) ORDER BY created_at DESC'
    ).all() as GoalRecord[];

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
        ).all(goal.id) as LinkedTask[];

        // Get linked habits
        const linkedHabits = db.prepare(`
            SELECT h.id, h.name, h.icon,
                (SELECT COUNT(*) FROM habit_checkins WHERE habit_id = h.id AND completed = 1) as total_checkins,
                (SELECT COUNT(DISTINCT date) FROM habit_checkins WHERE habit_id = h.id AND completed = 1 AND date >= date('now', '-7 days')) as week_checkins
            FROM habits h WHERE h.goal_id = ? AND h.archived = 0
        `).all(goal.id) as LinkedHabit[];

        // Compute progress from linked tasks
        const totalTasks = linkedTasks.length;
        const completedTasks = linkedTasks.filter(t => t.status === 'done').length;
        const taskProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

        // Factor in habit consistency for overall goal health
        const habitHealth = linkedHabits.length > 0
            ? Math.round(linkedHabits.reduce((sum, habit) => sum + (habit.week_checkins / 7) * 100, 0) / linkedHabits.length)
            : null;

        // Overall goal progress: weighted blend of task completion + habit consistency
        const progress = habitHealth !== null
            ? Math.round(taskProgress * 0.7 + habitHealth * 0.3)  // tasks weigh more
            : taskProgress;

        const adaptiveMotivation = buildAdaptiveGoalMotivation({
            goal,
            linkedTasks,
            linkedHabits,
            selfEfficacy,
            snapshot: personalization,
        });

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

        const adaptiveGoalPolicy = buildAdaptiveGoalPolicy({
            id: goal.id,
            title: goal.title,
            deadline: goal.deadline,
            active: goal.active,
            health_status: goal.health_status,
            velocity_needed: goal.velocity_needed,
            actual_velocity: goal.actual_velocity,
            progress,
            taskProgress,
            habitHealth,
            linkedTasks,
            linkedHabits,
            momentum,
        }, personalization);

        goal.linkedTasks = linkedTasks;
        goal.linkedHabits = linkedHabits;
        goal.intentions = intentions;
        goal.progress = progress;
        goal.taskProgress = taskProgress;
        goal.habitHealth = habitHealth;
        goal.completedTasks = completedTasks;
        goal.totalTasks = totalTasks;
        goal.tmtScore = adaptiveMotivation.tmtScore;
        goal.tmtReason = adaptiveMotivation.tmtReason;
        goal.adaptiveNextAction = adaptiveMotivation.adaptiveNextAction;
        goal.adaptiveMode = adaptiveMotivation.adaptiveMode;
        goal.adaptiveValue = adaptiveMotivation.adaptiveValue;
        goal.adaptiveImpulsiveness = adaptiveMotivation.adaptiveImpulsiveness;
        goal.adaptiveGoalStatus = adaptiveGoalPolicy.adaptiveGoalStatus;
        goal.adaptiveProgressTarget = adaptiveGoalPolicy.adaptiveProgressTarget;
        goal.adaptiveProgressDelta = adaptiveGoalPolicy.adaptiveProgressDelta;
        goal.adaptiveProgressFit = adaptiveGoalPolicy.adaptiveProgressFit;
        goal.adaptiveGoalReason = adaptiveGoalPolicy.adaptiveGoalReason;
        goal.adaptiveGoalCheckpoint = adaptiveGoalPolicy.adaptiveGoalCheckpoint;
        goal.momentum = momentum;
    }

    return NextResponse.json({
        goals,
        selfEfficacy,
        personalization: {
            mode: personalization.moment.mode,
            guidance: personalization.moment.guidance,
            energy: personalization.userState.energy,
            mood: personalization.userState.mood,
            standupGoal: personalization.userState.standupGoal,
            alertFatigueLevel: personalization.feedback.alertFatigueLevel,
        },
    });
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

// DELETE — Delete goal and its goal-owned graph/planning records.
// Tasks and habits are kept, but unlinked from the goal.
export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const rawId = searchParams.get('id');
        const id = rawId ? Number.parseInt(rawId, 10) : 0;
        if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: 'valid id required' }, { status: 400 });

        const db = getDb();
        let deleted = 0;

        db.transaction(() => {
            // Keep user tasks/habits, but remove their goal association.
            db.prepare('UPDATE tasks SET goal_id = NULL WHERE goal_id = ?').run(id);
            db.prepare('UPDATE habits SET goal_id = NULL WHERE goal_id = ?').run(id);

            // Goal-owned records should disappear with the goal.
            db.prepare('DELETE FROM node_task_links WHERE node_id IN (SELECT id FROM knowledge_nodes WHERE goal_id = ?)').run(id);
            db.prepare(`
                DELETE FROM knowledge_edges
                WHERE from_node_id IN (SELECT id FROM knowledge_nodes WHERE goal_id = ?)
                   OR to_node_id IN (SELECT id FROM knowledge_nodes WHERE goal_id = ?)
            `).run(id, id);
            db.prepare('DELETE FROM knowledge_nodes WHERE goal_id = ?').run(id);
            db.prepare('DELETE FROM intentions WHERE goal_id = ?').run(id);
            db.prepare('DELETE FROM goal_time_logs WHERE goal_id = ?').run(id);
            try { db.prepare('UPDATE daily_checkins SET inferred_goal_id = NULL WHERE inferred_goal_id = ?').run(id); } catch {}

            const result = db.prepare('DELETE FROM goals WHERE id = ?').run(id);
            deleted = result.changes;
        })();

        if (deleted === 0) return NextResponse.json({ error: 'goal not found' }, { status: 404 });
        return NextResponse.json({ ok: true, deleted });
    } catch (error) {
        console.error('Goal DELETE error:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
