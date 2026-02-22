import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// GET: Fetch all habits with today's checkin status, or a full year of checkins for heatmap
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const heatmap = searchParams.get('heatmap');
        const habit_id = searchParams.get('habit_id');

        const db = getDb();

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
        const today = new Date().toISOString().split('T')[0];
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
                FROM activities WHERE date(started_at) = ? AND category = 'productive'
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

            const checkinDate = date || new Date().toISOString().split('T')[0];

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
                    return NextResponse.json({ checked: false });
                }
            } else {
                const isCompleted = completed !== undefined ? completed : 1;
                const finalValue = value !== undefined ? value : 1;
                db.prepare('INSERT INTO habit_checkins (habit_id, date, completed, value) VALUES (?, ?, ?, ?)').run(habit_id, checkinDate, isCompleted ? 1 : 0, finalValue);
                return NextResponse.json({ checked: !!isCompleted, value: finalValue });
            }
        }

        // Create new habit
        const { name, icon, frequency, goal_metric, goal_target } = body;
        if (!name) {
            return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }

        const result = db.prepare(
            'INSERT INTO habits (name, icon, frequency, goal_metric, goal_target) VALUES (?, ?, ?, ?, ?)'
        ).run(name, icon || '✅', frequency || 'daily', goal_metric || 'boolean', goal_target || 1);

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
