import { NextResponse } from 'next/server';
import { prioritizeAllTasks } from '@/lib/task-priority-ranker';

// POST /api/tasks/prioritize — trigger LLM ranking of all tasks
export async function POST() {
    try {
        const ranked = await prioritizeAllTasks();
        return NextResponse.json({ success: true, ranked });
    } catch (err) {
        console.error('[/api/tasks/prioritize] Error:', err);
        return NextResponse.json({ error: 'Failed to prioritize tasks' }, { status: 500 });
    }
}
