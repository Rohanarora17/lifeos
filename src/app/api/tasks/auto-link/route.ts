import { NextRequest, NextResponse } from 'next/server';
import { autoLinkAllUnlinkedTasks, autoLinkTaskToGoal } from '@/lib/task-auto-linker';

/**
 * POST /api/tasks/auto-link
 * Body: {} → relink ALL unlinked tasks
 * Body: { taskId: number } → relink a specific task
 *
 * GET /api/tasks/auto-link → preview count of unlinked tasks
 */

export async function GET() {
  const { getDb } = await import('@/lib/db');
  const db = getDb();
  const count = (db.prepare(`
    SELECT COUNT(*) as c FROM tasks WHERE goal_id IS NULL AND status NOT IN ('done','cancelled')
  `).get() as { c: number }).c;
  return NextResponse.json({ unlinkedTasks: count });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.taskId) {
      const goalId = await autoLinkTaskToGoal(Number(body.taskId));
      return NextResponse.json({ linked: goalId !== null, goalId });
    }
    const result = await autoLinkAllUnlinkedTasks();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
