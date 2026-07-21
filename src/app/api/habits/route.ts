import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAutomaticityScore, getStreakCount } from '@/lib/scoring';
import { sanitizeText } from '@/lib/sanitize';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { buildAdaptiveHabitPlans, buildAdaptiveNewHabitDefaults, type AdaptiveHabitInput } from '@/lib/adaptive-habit-plan';
import { getAdaptiveRewardDecision } from '@/lib/adaptive-rewards';
import { buildAdaptiveHabitHistory } from '@/lib/adaptive-habit-history';
import { recordAdaptiveHabitCheckin } from '@/lib/adaptive-habit-checkin';

type HabitRow = AdaptiveHabitInput & {
    frequency: string;
    created_at: string;
    archived: number;
    goal_id: number | null;
};

// GET: Fetch all habits with today's checkin status, or a full year of checkins for heatmap
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const heatmap = searchParams.get('heatmap');
        const habit_id = searchParams.get('habit_id');

        const db = getDb();
        const personalization = buildPersonalizationSnapshot({
            surface: 'habits',
            maxInsights: 2,
            includeMemoryFacts: 4,
        });

        // Day-by-day habit history with daily scores
        if (searchParams.get('history') === 'true') {
            const days = parseInt(searchParams.get('days') || '14');
            const totalHabits = (db.prepare('SELECT COUNT(*) as c FROM habits WHERE archived = 0').get() as { c: number }).c;

            const dailyHistory = db.prepare(`
                WITH RECURSIVE dates(d) AS (
                    SELECT date('now', '-${days} days')
                    UNION ALL SELECT date(d, '+1 day') FROM dates WHERE d < date('now', '+1 day')
                )
                SELECT 
                    dates.d as date,
                    COALESCE(completed.count, 0) as habits_completed,
                    ${totalHabits} as total_habits,
                    dp.mood,
                    dp.energy,
                    COALESCE(dp.generated_summary, dp.tomorrow_intention, dp.evening_notes) as day_context
                FROM dates
                LEFT JOIN (
                    SELECT hc.date as d, COUNT(DISTINCT hc.habit_id) as count
                    FROM habit_checkins hc
                    JOIN habits h ON h.id = hc.habit_id AND h.archived = 0
                    WHERE hc.completed = 1
                    GROUP BY hc.date
                ) completed ON completed.d = dates.d
                LEFT JOIN daily_plans dp ON dp.plan_date = dates.d
                ORDER BY dates.d ASC
            `).all() as {
                date: string;
                habits_completed: number;
                total_habits: number;
                mood: string | null;
                energy: string | null;
                day_context: string | null;
            }[];

            // Calculate daily habit score and add adaptive interpretation.
            const historyWithScores = dailyHistory.map(day => {
                const score = day.total_habits > 0 ? Math.round((day.habits_completed / day.total_habits) * 100) : null;
                return { ...day, habit_score: score };
            });
            const adaptiveHistory = buildAdaptiveHabitHistory(historyWithScores, personalization);

            // Per-habit breakdown with names
            const habitBreakdown = db.prepare(`
                SELECT h.id, h.name, h.icon, hc.date, hc.completed, COALESCE(hc.value, 0) as value
                FROM habits h
                LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date >= date('now', '-${days} days')
                WHERE h.archived = 0
                ORDER BY h.created_at ASC, hc.date ASC
            `).all();

            return NextResponse.json({ history: adaptiveHistory, habitBreakdown, totalHabits });
        }

        if (heatmap) {
            // Return 365 days of checkin data for heatmap
            const startDate = new Date();
            startDate.setFullYear(startDate.getFullYear() - 1);
            const startStr = startDate.toISOString().split('T')[0];

            let query = `
        SELECT hc.date, COUNT(hc.id) as checkins, COUNT(DISTINCT hc.habit_id) as habits_done,
               (SELECT COUNT(*) FROM habits WHERE archived = 0) as total_habits,
               dp.mood,
               dp.energy,
               COALESCE(dp.generated_summary, dp.tomorrow_intention, dp.evening_notes) as day_context
        FROM habit_checkins hc
        JOIN habits h ON h.id = hc.habit_id AND h.archived = 0
        LEFT JOIN daily_plans dp ON dp.plan_date = hc.date
        WHERE hc.date >= ? AND hc.completed = 1
      `;
            const params: (string | number)[] = [startStr];

            if (habit_id) {
                query += ' AND hc.habit_id = ?';
                params.push(parseInt(habit_id));
            }

            query += ' GROUP BY hc.date ORDER BY hc.date ASC';

            const data = db.prepare(query).all(...params) as Array<{
                date: string;
                checkins: number;
                habits_done: number;
                total_habits: number;
                mood: string | null;
                energy: string | null;
                day_context: string | null;
            }>;
            const adaptiveHeatmap = buildAdaptiveHabitHistory(data.map(day => ({
                date: day.date,
                habits_completed: day.habits_done,
                total_habits: day.total_habits,
                mood: day.mood,
                energy: day.energy,
                day_context: day.day_context,
            })), personalization).map((day, index) => ({
                ...data[index],
                adaptive_target_habits: day.adaptive_target_habits,
                adaptive_habit_score: day.adaptive_habit_score,
                adaptive_heatmap_level: day.adaptive_heatmap_level,
                adaptive_posture: day.adaptive_posture,
                adaptive_reason: day.adaptive_reason,
            }));
            return NextResponse.json({ heatmap: adaptiveHeatmap });
        }

        // Default: return all active habits with today's status
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const habits = db.prepare(`
	      SELECT h.*,
            g.title as goal_title,
	        CASE WHEN hc.id IS NOT NULL THEN hc.completed ELSE 0 END as checked_today,
	        COALESCE(hc.value, 0) as today_value,
	        (SELECT COUNT(*) FROM habit_checkins WHERE habit_id = h.id AND completed = 1) as total_checkins
	      FROM habits h
          LEFT JOIN goals g ON g.id = h.goal_id
	      LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
	      WHERE h.archived = 0
	      ORDER BY h.created_at ASC
	    `).all(today) as HabitRow[];

        // Calculate Habit Automaticity Score (Lally Curve) before adaptive planning.
        for (const h of habits) {
            const checkins = db.prepare('SELECT date FROM habit_checkins WHERE habit_id = ? AND completed = 1 ORDER BY date DESC').all(h.id) as { date: string }[];
            const streak = getStreakCount(checkins.map(c => c.date));
            h.current_streak = streak;
            h.automaticity_score = getAutomaticityScore(streak);
        }

        const habitDefaults = buildAdaptiveNewHabitDefaults(personalization);
        const adaptivePlans = buildAdaptiveHabitPlans(habits, personalization);

        // Auto-update time-based habits for today against today's adaptive target, not the static base target.
        const timeHabits = habits.filter(h => h.goal_metric === 'time');
        if (timeHabits.length > 0) {
            const productiveMinutes = db.prepare(`
                SELECT SUM(duration_seconds) / 60 as mins
                FROM activities WHERE date(started_at, 'localtime') = ? AND category = 'productive'
            `).get(today) as { mins: number } | undefined;

            const todayProdMins = Math.round(productiveMinutes?.mins || 0);

            db.transaction((habitsToUpdate: HabitRow[]) => {
                for (const h of habitsToUpdate) {
                    // The activities table records ALL productive time including guardian session time.
                    // So MAX(session_value, activities_value) = activities_value (subsumes sessions),
                    // which is the correct total with no double-counting.
                    // We preserve 'guardian_session' as source only if it won (session > activities).
                    const existing = db.prepare(
                        `SELECT id, value, source FROM habit_checkins WHERE habit_id = ? AND date = ?`
                    ).get(h.id, today) as { id: number; value: number; source: string } | undefined;

                    const bestValue = Math.max(todayProdMins, existing?.value ?? 0);
                    // Keep guardian_session source if it contributed the higher value
                    const bestSource = (existing?.source === 'guardian_session' && (existing.value ?? 0) >= todayProdMins)
                        ? 'guardian_session'
                        : 'screen_time';
                    const todayTarget = adaptivePlans.get(h.id)?.adaptive_today_target ?? h.goal_target ?? 1;
                    const isCompleted = bestValue >= todayTarget ? 1 : 0;

                    db.prepare(`
                        INSERT INTO habit_checkins (habit_id, date, completed, value, source)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(habit_id, date) DO UPDATE SET
                          completed = excluded.completed,
                          value = excluded.value,
                          source = excluded.source
                    `).run(h.id, today, isCompleted, bestValue, bestSource);
                    h.today_value = bestValue;
                    h.checked_today = isCompleted;
                }
            })(timeHabits);
        }

        const adaptiveHabits = habits.map(habit => ({
            ...habit,
            ...adaptivePlans.get(habit.id),
        })).sort((a, b) => {
            if (a.checked_today !== b.checked_today) return a.checked_today - b.checked_today;
            const scoreDiff = (b.adaptive_priority_score ?? 0) - (a.adaptive_priority_score ?? 0);
            if (scoreDiff !== 0) return scoreDiff;
            return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

        // Global streak: how many consecutive days have ALL habits been completed
        const allDates = db.prepare(`
      SELECT DISTINCT date FROM habit_checkins WHERE completed = 1 ORDER BY date DESC
    `).all() as { date: string }[];

        return NextResponse.json({
            habits: adaptiveHabits,
            streakDates: allDates.map(d => d.date),
            personalization: {
                mode: personalization.moment.mode,
                guidance: personalization.moment.guidance,
                energy: personalization.userState.energy,
                mood: personalization.userState.mood,
                standupGoal: personalization.userState.standupGoal,
                alertFatigueLevel: personalization.feedback.alertFatigueLevel,
                nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
            },
            habitDefaults,
        });
    } catch (error) {
        console.error('Habits GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST: Create a habit or check in
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { action } = body;

        const db = getDb();

        if (action === 'checkin') {
            const { habit_id, date, value, completed } = body;
            if (!habit_id) {
                return NextResponse.json({ error: 'habit_id is required' }, { status: 400 });
            }

            const checkinDate = date || new Date(Date.now() + 19800000).toISOString().slice(0, 10);
            const rewardSnapshot = buildPersonalizationSnapshot({
                surface: 'rewards',
                maxInsights: 2,
                includeMemoryFacts: 3,
            });

            // Toggle: if already checked in, remove it; otherwise add it
            const existing = db.prepare(
                'SELECT id FROM habit_checkins WHERE habit_id = ? AND date = ?'
            ).get(habit_id, checkinDate);

            if (existing) {
                if (value !== undefined) {
                    const checkin = recordAdaptiveHabitCheckin({
                        habitId: Number(habit_id),
                        date: checkinDate,
                        source: 'manual',
                        value: Number(value),
                        forceComplete: completed !== undefined ? Boolean(completed) : undefined,
                    });
                    return NextResponse.json({
                        checked: checkin.completed,
                        value: checkin.value,
                        adaptiveTarget: checkin.adaptiveTarget,
                        adaptiveReason: checkin.adaptiveReason,
                        adaptiveIntensity: checkin.adaptiveIntensity,
                    });
                } else {
                    db.prepare('DELETE FROM habit_checkins WHERE habit_id = ? AND date = ?').run(habit_id, checkinDate);
                    // Only deduct coins if balance would remain >= 0
                    const reward = getAdaptiveRewardDecision({
                        action: 'habit_uncheck',
                        baseCoins: 20,
                        subject: `Habit ${habit_id}`,
                        snapshot: rewardSnapshot,
                    });
                    let applied = false;
                    try {
                        const bal = db.prepare('SELECT COALESCE(SUM(amount), 0) as b FROM coin_ledger').get() as { b: number };
                        if (bal.b >= Math.abs(reward.coins)) {
                            db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(reward.coins, reward.ledgerReason);
                            applied = true;
                        }
                    } catch { }
                    return NextResponse.json({ checked: false, reward: { ...reward, applied } });
                }
            } else {
                const checkin = recordAdaptiveHabitCheckin({
                    habitId: Number(habit_id),
                    date: checkinDate,
                    source: 'manual',
                    value: value !== undefined ? Number(value) : undefined,
                    forceComplete: completed !== undefined ? Boolean(completed) : undefined,
                });
                let reward = null;
                if (checkin.completed) {
                    const baseCoins = checkin.adaptiveIntensity === 'stretch'
                        ? 28
                        : checkin.adaptiveIntensity === 'minimum'
                            ? 14
                            : 20;
                    reward = getAdaptiveRewardDecision({
                        action: 'habit_checkin',
                        baseCoins,
                        subject: `${checkin.habitName} (${checkin.value}/${checkin.adaptiveTarget}${checkin.goalMetric === 'time' ? 'm' : ''}; ${checkin.adaptiveReason ?? 'adaptive habit target'})`,
                        snapshot: rewardSnapshot,
                    });
                    try { db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(reward.coins, reward.ledgerReason); } catch { }
                }
                return NextResponse.json({
                    checked: checkin.completed,
                    value: checkin.value,
                    reward,
                    adaptiveTarget: checkin.adaptiveTarget,
                    adaptiveReason: checkin.adaptiveReason,
                    adaptiveIntensity: checkin.adaptiveIntensity,
                });
            }
        }

        // Create new habit
        const { name, icon, frequency, goal_metric, goal_target, goal_id } = body;
        if (!name) {
            return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }

        const createPersonalization = buildPersonalizationSnapshot({
            surface: 'habits',
            maxInsights: 2,
            includeMemoryFacts: 4,
        });
        const createDefaults = buildAdaptiveNewHabitDefaults(createPersonalization);
        const resolvedGoalMetric = goal_metric === 'time' || goal_metric === 'boolean'
            ? goal_metric
            : createDefaults.goalMetric;
        const hasExplicitGoalTarget = goal_target !== undefined && goal_target !== null && goal_target !== '';
        const parsedGoalTarget = Number(goal_target);
        const resolvedGoalTarget = resolvedGoalMetric === 'time'
            ? Math.max(1, Math.round(hasExplicitGoalTarget && Number.isFinite(parsedGoalTarget) ? parsedGoalTarget : createDefaults.timeTargetMinutes))
            : 1;

        const safeName = sanitizeText(name, 200);
        const safeIcon = sanitizeText(icon || '✅', 10);

        const result = db.prepare(
            'INSERT INTO habits (name, icon, frequency, goal_metric, goal_target, goal_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(safeName, safeIcon, frequency || 'daily', resolvedGoalMetric, resolvedGoalTarget, goal_id || null);

        return NextResponse.json({
            id: result.lastInsertRowid,
            adaptiveDefaults: {
                ...createDefaults,
                appliedGoalMetric: resolvedGoalMetric,
                appliedGoalTarget: resolvedGoalTarget,
            },
        }, { status: 201 });
    } catch (error) {
        console.error('Habits POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH: Update a habit definition
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, name, icon, goal_metric, goal_target, goal_id } = body;
        if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

        const db = getDb();
        const updates: string[] = [];
        const params: (string | number | null)[] = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(sanitizeText(name, 200)); }
        if (icon !== undefined) { updates.push('icon = ?'); params.push(sanitizeText(icon, 10)); }
        if (goal_metric !== undefined) { updates.push('goal_metric = ?'); params.push(goal_metric); }
        if (goal_target !== undefined) { updates.push('goal_target = ?'); params.push(Number(goal_target)); }
        if (goal_id !== undefined) { updates.push('goal_id = ?'); params.push(goal_id); }

        if (updates.length === 0) return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
        params.push(id);
        db.prepare(`UPDATE habits SET ${updates.join(', ')} WHERE id = ?`).run(...params);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Habits PATCH error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// DELETE: Archive or delete a habit
export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');
        const permanent = searchParams.get('permanent');

        if (!id) {
            return NextResponse.json({ error: 'id is required' }, { status: 400 });
        }

        const db = getDb();
        if (permanent === 'true') {
            db.prepare('DELETE FROM habits WHERE id = ?').run(id);
        } else {
            db.prepare('UPDATE habits SET archived = 1 WHERE id = ?').run(id);
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Habits DELETE error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
