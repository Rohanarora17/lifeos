import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// GET — List goals
export async function GET() {
    const db = getDb();
    const goals = db.prepare('SELECT * FROM goals ORDER BY active DESC, created_at DESC').all();
    return NextResponse.json({ goals });
}

// POST — Create goal
export async function POST(request: Request) {
    const body = await request.json();
    const { title, type, metric, target_value, unit, category } = body;

    if (!title || !metric || !target_value) {
        return NextResponse.json({ error: 'title, metric, and target_value are required' }, { status: 400 });
    }

    const db = getDb();
    const result = db.prepare(
        'INSERT INTO goals (title, type, metric, target_value, unit, category) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(title, type || 'daily', metric, target_value, unit || 'minutes', category || 'productivity');

    return NextResponse.json({ id: result.lastInsertRowid });
}

// PATCH — Update goal
export async function PATCH(request: Request) {
    const body = await request.json();
    const { id, ...updates } = body;
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const db = getDb();
    const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = Object.values(updates);

    if (fields) {
        db.prepare(`UPDATE goals SET ${fields} WHERE id = ?`).run(...values, id);
    }

    return NextResponse.json({ ok: true });
}

// DELETE — Delete goal
export async function DELETE(request: Request) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

    const db = getDb();
    db.prepare('DELETE FROM goals WHERE id = ?').run(id);
    return NextResponse.json({ ok: true });
}
