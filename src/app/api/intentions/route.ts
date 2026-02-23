import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
    try {
        const db = getDb();
        const intentions = db.prepare(`
      SELECT i.*, g.title as goal_title 
      FROM intentions i
      LEFT JOIN goals g ON i.goal_id = g.id
      ORDER BY i.created_at DESC
    `).all();
        return NextResponse.json({ intentions });
    } catch (error) {
        console.error('Intentions GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { if_condition, then_action, goal_id } = body;

        if (!if_condition || !then_action) {
            return NextResponse.json({ error: 'if_condition and then_action required' }, { status: 400 });
        }

        const db = getDb();
        const stmt = db.prepare(`
      INSERT INTO intentions (if_condition, then_action, goal_id)
      VALUES (?, ?, ?)
    `);
        const result = stmt.run(if_condition, then_action, goal_id || null);

        return NextResponse.json({ id: result.lastInsertRowid }, { status: 201 });
    } catch (error) {
        console.error('Intentions POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

export async function DELETE(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const db = getDb();
    db.prepare('DELETE FROM intentions WHERE id = ?').run(id);

    return NextResponse.json({ success: true });
}
