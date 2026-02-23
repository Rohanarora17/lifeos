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
        const now = new Date(Date.now() + 19800000);
        const dateStr = now.toISOString().slice(0, 10);
        const startTimeStr = now.toISOString().replace('T', ' ').slice(0, 19);
        const endTime = new Date(now.getTime() + duration_minutes * 60000);
        const endTimeStr = endTime.toISOString().replace('T', ' ').slice(0, 19);

        const stmt = db.prepare(`
      INSERT INTO focus_sessions (session_date, start_time, end_time, duration_minutes, focus_type, primary_domain, primary_category)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

        const focusType = duration_minutes >= 45 ? 'deep' : duration_minutes >= 25 ? 'moderate' : 'shallow';
        const result = stmt.run(dateStr, startTimeStr, endTimeStr, duration_minutes, focusType, 'Focus Mode', 'productive');

        // Also add to activities as productive time
        db.prepare(`
      INSERT INTO activities (url, domain, title, category, subcategory, duration_seconds, started_at, ended_at, device_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
            'app://focus-mode',
            'Focus Mode',
            task_id ? `Focused on Task #${task_id}` : 'Pomodoro Session',
            'productive',
            'deep_work',
            duration_minutes * 60,
            startTimeStr,
            endTimeStr,
            'Local Server'
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
