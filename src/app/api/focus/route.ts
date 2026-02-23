import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { task_id, duration_minutes } = body;

        if (!duration_minutes) {
            return NextResponse.json({ error: 'duration_minutes is required' }, { status: 400 });
        }

        const db = getDb();
        const stmt = db.prepare(`
      INSERT INTO focus_sessions (task_id, duration_minutes)
      VALUES (?, ?)
    `);

        const result = stmt.run(task_id || null, duration_minutes);

        // Also add to activities as productive time
        db.prepare(`
      INSERT INTO activities (url, domain, title, category, subcategory, duration_seconds)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
            'app://focus-mode',
            'Focus Mode',
            task_id ? `Focused on Task #${task_id}` : 'Pomodoro Session',
            'productive',
            'deep_work',
            duration_minutes * 60
        );

        // Give +1 coin per minute focused
        try {
            db.prepare('INSERT INTO coin_ledger (amount, reason) VALUES (?, ?)').run(duration_minutes, `Completed ${duration_minutes}m Focus Session`);
        } catch (e) {
            console.error('Error awarding focus coins:', e);
        }

        return NextResponse.json({ id: result.lastInsertRowid, success: true }, { status: 201 });
    } catch (error) {
        console.error('Focus POST error:', error);
        return NextResponse.json({ error: 'Failed' }, { status: 500 });
    }
}
