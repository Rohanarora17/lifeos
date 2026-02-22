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
        CASE WHEN hc.id IS NOT NULL THEN 1 ELSE 0 END as checked_today,
        (SELECT COUNT(*) FROM habit_checkins WHERE habit_id = h.id AND completed = 1) as total_checkins
      FROM habits h
      LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
      WHERE h.archived = 0
      ORDER BY h.created_at ASC
    `).all(today);

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
            const { habit_id, date } = body;
            if (!habit_id) {
                return NextResponse.json({ error: 'habit_id is required' }, { status: 400 });
            }

            const checkinDate = date || new Date().toISOString().split('T')[0];

            // Toggle: if already checked in, remove it; otherwise add it
            const existing = db.prepare(
                'SELECT id FROM habit_checkins WHERE habit_id = ? AND date = ?'
            ).get(habit_id, checkinDate);

            if (existing) {
                db.prepare('DELETE FROM habit_checkins WHERE habit_id = ? AND date = ?').run(habit_id, checkinDate);
                return NextResponse.json({ checked: false });
            } else {
                db.prepare('INSERT INTO habit_checkins (habit_id, date, completed) VALUES (?, ?, 1)').run(habit_id, checkinDate);
                return NextResponse.json({ checked: true });
            }
        }

        // Create new habit
        const { name, icon, frequency } = body;
        if (!name) {
            return NextResponse.json({ error: 'name is required' }, { status: 400 });
        }

        const result = db.prepare(
            'INSERT INTO habits (name, icon, frequency) VALUES (?, ?, ?)'
        ).run(name, icon || '✅', frequency || 'daily');

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
