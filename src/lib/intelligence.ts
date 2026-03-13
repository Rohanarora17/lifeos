import { getDb } from './db';
import { getStreakCount } from './scoring';
import { getUnblockedNextConcepts } from './graph';

// ============================================================
//  COGNITIVE INTELLIGENCE ENGINE
//  Zeigarnik audit, smart prioritization, self-efficacy recovery
// ============================================================

interface CognitiveLoadAudit {
    openTaskCount: number;
    mentalBandwidth: number; // 0-100, lower = more overloaded
    status: 'clear' | 'moderate' | 'overloaded';
    quickWins: { id: number; title: string; status: string; created_at: string }[];
    deferCandidates: { id: number; title: string; status: string; priority: string }[];
}

interface RecommendedTask {
    id: number;
    title: string;
    status: string;
    priority: string;
    goalTitle: string | null;
    score: number;
    reason: string;
}

interface EfficacyMode {
    rate: number;
    isRecoveryMode: boolean;
    message: string;
    suggestedActions: string[];
}

/**
 * Zeigarnik Effect — Cognitive Load Audit
 * Counts open tasks and suggests quick wins to close mental loops.
 */
export function getCognitiveLoadAudit(): CognitiveLoadAudit {
    const db = getDb();

    const openTasks = db.prepare(
        "SELECT id, title, status, priority, created_at, due_date FROM tasks WHERE status IN ('today', 'doing', 'this_week') ORDER BY created_at ASC"
    ).all() as any[];

    const count = openTasks.length;
    const bandwidth = Math.max(0, Math.min(100, 100 - (count - 3) * 12)); // 3 tasks = 100%, 11+ = 0%
    const status = bandwidth >= 70 ? 'clear' : bandwidth >= 40 ? 'moderate' : 'overloaded';

    // Quick wins: oldest tasks with low/medium priority (likely small)
    const quickWins = openTasks
        .filter(t => t.priority !== 'critical' && t.priority !== 'high')
        .slice(0, 3);

    // Defer candidates: tasks with no deadline and low priority
    const deferCandidates = openTasks
        .filter(t => !t.due_date && (t.priority === 'low' || t.priority === 'medium'))
        .slice(-3);

    return { openTaskCount: count, mentalBandwidth: bandwidth, status, quickWins, deferCandidates };
}

/**
 * Smart Prioritization — "What to Work on Next"
 * Ranks all active tasks by composite score using TMT, goal urgency, efficacy match.
 */
export function getSmartPrioritization(): RecommendedTask[] {
    const db = getDb();

    const activeTasks = db.prepare(`
    SELECT t.id, t.title, t.status, t.priority, t.due_date, t.goal_id, t.created_at,
           g.title as goal_title, g.deadline as goal_deadline
    FROM tasks t
    LEFT JOIN goals g ON t.goal_id = g.id
    WHERE t.status IN ('today', 'doing', 'this_week')
    ORDER BY t.position ASC
  `).all() as any[];

    const now = Date.now();
    const priorityWeight: Record<string, number> = { critical: 40, high: 30, medium: 20, low: 10 };

    // Graph-aware: Boost tasks linked to unblocked, undermastered concepts
    let graphBoostTaskIds: Set<number> = new Set();
    try {
        const activeGoals = db.prepare(`SELECT DISTINCT goal_id FROM tasks WHERE status IN ('today','doing','this_week') AND goal_id IS NOT NULL`).all() as { goal_id: number }[];
        for (const { goal_id } of activeGoals) {
            const unblocked = getUnblockedNextConcepts(goal_id);
            for (const concept of unblocked) {
                for (const task of concept.linked_tasks) {
                    if (task.status !== 'done') graphBoostTaskIds.add(task.id);
                }
            }
        }
    } catch (e) { /* non-critical */ }

    const scored = activeTasks.map(t => {
        let score = 0;
        let reasons: string[] = [];

        // Priority weight
        const pw = priorityWeight[t.priority] || 20;
        score += pw;
        if (pw >= 30) reasons.push(`${t.priority} priority`);

        // Knowledge graph boost: task directly addresses an unblocked concept
        if (graphBoostTaskIds.has(t.id)) {
            score += 18;
            reasons.push('addresses knowledge gap');
        }

        // Deadline urgency (TMT-inspired: closer deadline = higher score)
        if (t.due_date) {
            const daysLeft = Math.max(0, Math.ceil((new Date(t.due_date).getTime() - now) / 86400000));
            const urgency = Math.max(0, 30 - daysLeft * 3);
            score += urgency;
            if (daysLeft <= 2) reasons.push(`due ${daysLeft === 0 ? 'today' : daysLeft === 1 ? 'tomorrow' : 'in 2 days'}`);
        }

        // Goal deadline urgency
        if (t.goal_deadline) {
            const goalDaysLeft = Math.max(0, Math.ceil((new Date(t.goal_deadline).getTime() - now) / 86400000));
            const goalUrgency = Math.max(0, 20 - goalDaysLeft * 2);
            score += goalUrgency;
            if (goalDaysLeft <= 7) reasons.push(`goal deadline in ${goalDaysLeft}d`);
        }

        // Goal progress gap — goals behind schedule get boosted
        if (t.goal_id) {
            const goalTasks = db.prepare(
                "SELECT COUNT(*) as total, COUNT(CASE WHEN status='done' THEN 1 END) as done FROM tasks WHERE goal_id = ?"
            ).get(t.goal_id) as { total: number; done: number };
            if (goalTasks.total > 0) {
                const progress = goalTasks.done / goalTasks.total;
                if (progress < 0.3) {
                    score += 15;
                    reasons.push(`goal "${t.goal_title}" behind at ${Math.round(progress * 100)}%`);
                }
            }
        }

        // Status boost: "doing" tasks get a small boost (already started)
        if (t.status === 'doing') {
            score += 10;
            reasons.push('in progress');
        }

        // Age penalty: older tasks get a slight boost to prevent staleness
        const ageDays = Math.round((now - new Date(t.created_at).getTime()) / 86400000);
        if (ageDays > 7) {
            score += Math.min(10, ageDays - 7);
            if (ageDays > 14) reasons.push(`${ageDays} days old`);
        }

        return {
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority || 'medium',
            goalTitle: t.goal_title || null,
            score,
            reason: reasons.length > 0 ? reasons.join(' · ') : 'standard priority',
        };
    });

    // Sort by score descending, return top 5
    return scored.sort((a, b) => b.score - a.score).slice(0, 5);
}

/**
 * Self-Efficacy Recovery Mode
 * When rolling task success rate drops below 30%, enter recovery mode.
 */
export function getSelfEfficacyMode(): EfficacyMode {
    const db = getDb();

    const efficacy = db.prepare(`
    SELECT 
      COUNT(CASE WHEN status = 'done' THEN 1 END) as completed,
      COUNT(*) as total
    FROM tasks 
    WHERE status IN ('today', 'doing', 'done', 'this_week')
    AND created_at >= datetime('now', '-14 days')
  `).get() as { completed: number; total: number };

    const rate = efficacy.total > 0 ? Math.round((efficacy.completed / efficacy.total) * 100) : 50;
    const isRecoveryMode = rate < 30 && efficacy.total >= 5;

    let message = '';
    const suggestedActions: string[] = [];

    if (isRecoveryMode) {
        message = `Your task completion is at ${rate}%. Let's rebuild momentum with some quick wins.`;
        suggestedActions.push('Complete 3 easy tasks to rebuild confidence');
        suggestedActions.push('Defer or remove tasks you won\'t realistically complete');
        suggestedActions.push('Break large tasks into smaller subtasks');
    } else if (rate < 50) {
        message = `Task completion at ${rate}%. Room for improvement — focus on your top priorities.`;
        suggestedActions.push('Prioritize tasks linked to your active goals');
    } else if (rate >= 70) {
        message = `Excellent ${rate}% completion rate! You're in a strong execution rhythm.`;
    } else {
        message = `Solid ${rate}% completion rate. Keep it up!`;
    }

    return { rate, isRecoveryMode, message, suggestedActions };
}

/**
 * Detect Goal Conflicts
 * Finds correlations between task completion on one goal and habit/task misses on another.
 */
export function detectGoalConflicts(): { goalA: string; goalB: string; message: string }[] {
    const db = getDb();
    const conflicts: { goalA: string; goalB: string; message: string }[] = [];

    try {
        // Find goals where recent task completion correlates with habit misses
        const goals = db.prepare('SELECT id, title FROM goals WHERE active = 1').all() as any[];

        for (const goal of goals) {
            const linkedHabits = db.prepare(`
        SELECT h.name, h.id FROM habits h WHERE h.goal_id = ? AND h.archived = 0
      `).all(goal.id) as any[];

            for (const habit of linkedHabits) {
                // Check if habit has been missed more than 3 of the last 7 days
                const recent = db.prepare(`
          SELECT COUNT(*) as checked FROM habit_checkins 
          WHERE habit_id = ? AND completed = 1 AND date >= date('now', '-7 days')
        `).get(habit.id) as { checked: number };

                if (recent.checked <= 4) {
                    // Check if other goals have been getting tasks completed
                    const busyGoals = db.prepare(`
            SELECT g.title, COUNT(*) as completions FROM tasks t
            JOIN goals g ON t.goal_id = g.id
            WHERE t.status = 'done' AND t.completed_at >= datetime('now', '-7 days')
            AND g.id != ?
            GROUP BY g.id HAVING completions >= 3
          `).all(goal.id) as any[];

                    for (const busy of busyGoals) {
                        conflicts.push({
                            goalA: busy.title,
                            goalB: goal.title,
                            message: `Working on "${busy.title}" may be causing you to miss ${habit.name} (${recent.checked}/7 days this week).`,
                        });
                    }
                }
            }
        }
    } catch (err) {
        console.error('[Intelligence] Goal conflict detection error:', err);
    }

    return conflicts;
}

/**
 * Achievement Engine — badge unlocking logic
 * Run periodically to check milestones against current user stats.
 */
export function checkAchievements(): void {
    const db = getDb();

    // Get all locked badges for the user
    const lockedBadges = db.prepare(`
        SELECT id, name, metric, target, icon, description 
        FROM badges 
        WHERE id NOT IN (SELECT badge_id FROM user_badges)
    `).all() as any[];

    if (lockedBadges.length === 0) return;

    let tasksDone = 0;
    let focusSessions = 0;
    let maxStreak = 0;

    try { tasksDone = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'done'").get() as any).c || 0; } catch (e) { console.error(e); }
    try { focusSessions = (db.prepare('SELECT COUNT(*) as c FROM focus_sessions').get() as any).c || 0; } catch (e) { console.error(e); }

    try {
        const allCheckins = db.prepare('SELECT habit_id, date FROM habit_checkins WHERE completed = 1').all() as any[];
        const habitsMap: Record<number, string[]> = {};
        for (const c of allCheckins) {
            if (!habitsMap[c.habit_id]) habitsMap[c.habit_id] = [];
            habitsMap[c.habit_id].push(c.date);
        }
        for (const dates of Object.values(habitsMap)) {
            const streak = getStreakCount(dates);
            if (streak > maxStreak) maxStreak = streak;
        }
    } catch (e) { console.error(e); }

    const stats: Record<string, number> = {
        tasks_done: tasksDone,
        focus_sessions: focusSessions,
        streak_days: maxStreak,
    };

    // Check unlocks
    for (const badge of lockedBadges) {
        const currentValue = stats[badge.metric] || 0;
        if (currentValue >= badge.target) {
            try {
                db.prepare('INSERT INTO user_badges (badge_id) VALUES (?)').run(badge.id);
                // Award 500 bonus coins for unlocking a badge
                db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(500, `Unlocked Badge: ${badge.name}`);

                // Fire an alert so the user sees it in the bell icon
                db.prepare(`
                    INSERT INTO alerts (title, message, type, priority)
                    VALUES (?, ?, ?, ?)
                `).run('🏆 Achievement Unlocked!', `You earned the "${badge.name}" badge and +500 Life Coins!`, 'gamification', 'high');
            } catch (e) { console.error('Error unlocking badge:', e); }
        }
    }
}
