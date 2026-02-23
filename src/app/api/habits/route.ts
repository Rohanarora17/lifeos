import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getAutomaticityScore, getStreakCount } from '@/lib/scoring';
import { sanitizeText } from '@/lib/sanitize';

// GET: Fetch all habits with today's checkin status, or a full year of checkins for heatmap
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const heatmap = searchParams.get('heatmap');
        const habit_id = searchParams.get('habit_id');

        const db = getDb();

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
                    ${totalHabits} as total_habits
                FROM dates
                LEFT JOIN (
                    SELECT hc.date as d, COUNT(DISTINCT hc.habit_id) as count
                    FROM habit_checkins hc
                    JOIN habits h ON h.id = hc.habit_id AND h.archived = 0
                    WHERE hc.completed = 1
                    GROUP BY hc.date
                ) completed ON completed.d = dates.d
                ORDER BY dates.d ASC
            `).all() as { date: string; habits_completed: number; total_habits: number }[];

            // Calculate daily habit score and add per-habit breakdown
            const historyWithScores = dailyHistory.map(day => {
                const score = day.total_habits > 0 ? Math.round((day.habits_completed / day.total_habits) * 100) : null;
                return { ...day, habit_score: score };
            });

            // Per-habit breakdown with names
            const habitBreakdown = db.prepare(`
                SELECT h.id, h.name, h.icon, hc.date, hc.completed, COALESCE(hc.value, 0) as value
                FROM habits h
                LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date >= date('now', '-${days} days')
                WHERE h.archived = 0
                ORDER BY h.created_at ASC, hc.date ASC
            `).all();

            return NextResponse.json({ history: historyWithScores, habitBreakdown, totalHabits });
        }

        if (heatmap) {
            // Return 365 days of checkin data for heatmap
            const startDate = new Date();
            startDate.setFullYear(startDate.getFullYear() - 1);
            const startStr = startDate.toISOString().split('T')[0];

            let query = `
        SELECT hc.date, COUNT(hc.id) as checkins, COUNT(DISTINCT hc.habit_id) as habits_done,
               (SELECT COUNT(*) FROM habits WHERE archived = 0) as total_habits
        FROM habit_checkins hc
        JOIN habits h ON h.id = hc.habit_id AND h.archived = 0
        WHERE hc.date >= ? AND hc.completed = 1
      `;
            const params: (string | number)[] = [startStr];

            if (habit_id) {
                query += ' AND hc.habit_id = ?';
                params.push(parseInt(habit_id));
            }

            query += ' GROUP BY hc.date ORDER BY hc.date ASC';

            const data = db.prepare(query).all(...params);
            return NextResponse.json({ heatmap: data });
        }

        // Default: return all active habits with today's status
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const habits = db.prepare(`
      SELECT h.*, 
        CASE WHEN hc.id IS NOT NULL THEN hc.completed ELSE 0 END as checked_today,
        COALESCE(hc.value, 0) as today_value,
        (SELECT COUNT(*) FROM habit_checkins WHERE habit_id = h.id AND completed = 1) as total_checkins
      FROM habits h
      LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
      WHERE h.archived = 0
      ORDER BY h.created_at ASC
    `).all(today) as any[];

        // Auto-update time-based habits for today
        const timeHabits = habits.filter(h => h.goal_metric === 'time');
        if (timeHabits.length > 0) {
            const productiveMinutes = db.prepare(`
                SELECT SUM(duration_seconds) / 60 as mins
                FROM activities WHERE date(started_at, 'localtime') = ? AND category = 'productive'
            `).get(today) as { mins: number } | undefined;

            const todayProdMins = Math.round(productiveMinutes?.mins || 0);

            const updateStmt = db.prepare(`
                INSERT INTO habit_checkins (habit_id, date, completed, value) 
                VALUES (?, ?, ?, ?) 
                ON CONFLICT(habit_id, date) DO UPDATE SET completed = excluded.completed, value = excluded.value
            `);
            const updateMany = db.transaction((habitsToUpdate: any[]) => {
                for (const h of habitsToUpdate) {
                    const isCompleted = todayProdMins >= (h.goal_target || 1) ? 1 : 0;
                    updateStmt.run(h.id, today, isCompleted, todayProdMins);
                    h.today_value = todayProdMins;
                    h.checked_today = isCompleted;
                }
            });
            updateMany(timeHabits);
        }

        // Calculate Habit Automaticity Score (Lally Curve)
        for (const h of habits) {
            const checkins = db.prepare('SELECT date FROM habit_checkins WHERE habit_id = ? AND completed = 1 ORDER BY date DESC').all(h.id) as { date: string }[];
            const streak = getStreakCount(checkins.map(c => c.date));
            h.current_streak = streak;
            h.automaticity_score = getAutomaticityScore(streak);
        }

        // Global streak: how many consecutive days have ALL habits been completed
        const allDates = db.prepare(`
      SELECT DISTINCT date FROM habit_checkins WHERE completed = 1 ORDER BY date DESC
    `).all() as { date: string }[];

        return NextResponse.json({ habits, streakDates: allDates.map(d => d.date) });
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

            // Toggle: if already checked in, remove it; otherwise add it
            const existing = db.prepare(
                'SELECT id FROM habit_checkins WHERE habit_id = ? AND date = ?'
            ).get(habit_id, checkinDate);

            if (existing) {
                if (value !== undefined) {
                    const isCompleted = completed !== undefined ? completed : 1;
                    db.prepare('UPDATE habit_checkins SET value = ?, completed = ? WHERE habit_id = ? AND date = ?').run(value, isCompleted ? 1 : 0, habit_id, checkinDate);
                    return NextResponse.json({ checked: !!isCompleted, value });
                } else {
                    db.prepare('DELETE FROM habit_checkins WHERE habit_id = ? AND date = ?').run(habit_id, checkinDate);
                    // Only deduct coins if balance would remain >= 0
                    try {
                        const bal = db.prepare('SELECT COALESCE(SUM(amount), 0) as b FROM coin_ledger').get() as { b: number };
                        if (bal.b >= 20) {
                            db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(-20, 'Unchecked Habit (ID: ' + habit_id + ')');
                        }
                    } catch (e) { }
                    return NextResponse.json({ checked: false });
                }
            } else {
                const isCompleted = completed !== undefined ? completed : 1;
                const finalValue = value !== undefined ? value : 1;
                db.prepare('INSERT INTO habit_checkins (habit_id, date, completed, value) VALUES (?, ?, ?, ?)').run(habit_id, checkinDate, isCompleted ? 1 : 0, finalValue);
                if (isCompleted) {
                    try { db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(20, 'Completed Habit (ID: ' + habit_id + ')'); } catch (e) { }
                }
                return NextResponse.json({ checked: !!isCompleted, value: finalValue });
            }
        }

        // Create new habit
        const { name, icon, frequency, goal_metric, goal_target, goal_id } = body;
        if (!name) {
            return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }

        const safeName = sanitizeText(name, 200);
        const safeIcon = sanitizeText(icon || '✅', 10);

        const result = db.prepare(
            'INSERT INTO habits (name, icon, frequency, goal_metric, goal_target, goal_id) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(safeName, safeIcon, frequency || 'daily', goal_metric || 'boolean', goal_target || 1, goal_id || null);

        return NextResponse.json({ id: result.lastInsertRowid }, { status: 201 });
    } catch (error) {
        console.error('Habits POST error:', error);
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
