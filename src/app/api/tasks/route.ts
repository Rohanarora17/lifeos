import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

// GET: Fetch all tasks, optionally filtered by status
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const status = searchParams.get('status');

        const db = getDb();
        let query = 'SELECT * FROM tasks';
        const params: string[] = [];

        if (status) {
            query += ' WHERE status = ?';
            params.push(status);
        }

        query += ' ORDER BY position ASC, created_at DESC';
        const tasks = db.prepare(query).all(...params);

        return NextResponse.json({ tasks });
    } catch (error) {
        console.error('Tasks GET error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST: Create a new task
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { title, description, status, due_date } = body;

        if (!title) {
            return NextResponse.json({ error: 'title is required' }, { status: 400 });
        }

        const db = getDb();

        // Get max position for the target status column
        const maxPos = db.prepare(
            'SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM tasks WHERE status = ?'
        ).get(status || 'backlog') as { next_pos: number };

        const stmt = db.prepare(`
      INSERT INTO tasks (title, description, status, due_date, position)
      VALUES (?, ?, ?, ?, ?)
    `);

        const result = stmt.run(
            title,
            description || '',
            status || 'backlog',
            due_date || null,
            maxPos.next_pos
        );

        return NextResponse.json({ id: result.lastInsertRowid }, { status: 201 });
    } catch (error) {
        console.error('Tasks POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// PATCH: Update a task (move between columns, edit, complete)
export async function PATCH(request: NextRequest) {
    try {
        const body = await request.json();
        const { id, title, description, status, due_date, position } = body;

        if (!id) {
            return NextResponse.json({ error: 'id is required' }, { status: 400 });
        }

        const db = getDb();
        const updates: string[] = [];
        const params: (string | number)[] = [];

        if (title !== undefined) { updates.push('title = ?'); params.push(title); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }
        if (status !== undefined) {
            updates.push('status = ?');
            params.push(status);
            // If moving to 'done', set completed_at
            if (status === 'done') {
                updates.push("completed_at = datetime('now')");
            } else {
                updates.push('completed_at = NULL');
            }
        }
        if (due_date !== undefined) { updates.push('due_date = ?'); params.push(due_date); }
        if (position !== undefined) { updates.push('position = ?'); params.push(position); }

        if (updates.length === 0) {
            return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
        }

        params.push(id);
        db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Tasks PATCH error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// DELETE: Delete a task
export async function DELETE(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json({ error: 'id is required' }, { status: 400 });
        }

        const db = getDb();
        db.prepare('DELETE FROM tasks WHERE id = ?').run(id);

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Tasks DELETE error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
