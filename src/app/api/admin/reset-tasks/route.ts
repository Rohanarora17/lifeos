import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * GET  /api/admin/reset-tasks  — preview task counts
 * POST /api/admin/reset-tasks  — delete tasks
 *
 * Body (POST):
 *   { "confirm": "RESET_TASKS" }                — delete ALL tasks
 *   { "confirm": "RESET_TASKS", "mode": "done" } — delete only done/cancelled tasks
 */

export async function GET() {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT status, COUNT(*) as count FROM tasks GROUP BY status ORDER BY count DESC
    `).all() as Array<{ status: string; count: number }>;

    const total = rows.reduce((s, r) => s + r.count, 0);
    const done = rows.filter(r => r.status === 'done' || r.status === 'cancelled').reduce((s, r) => s + r.count, 0);

    return NextResponse.json({
      message: 'Preview — POST with confirm=RESET_TASKS to delete.',
      total,
      byStatus: Object.fromEntries(rows.map(r => [r.status, r.count])),
      doneOrCancelled: done,
      modes: {
        all: 'Delete all tasks regardless of status',
        done: 'Delete only done + cancelled tasks (safe cleanup)',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));

    if (body.confirm !== 'RESET_TASKS') {
      return NextResponse.json(
        { error: 'Pass { "confirm": "RESET_TASKS" } to execute. Add "mode": "done" to only remove done/cancelled.' },
        { status: 400 }
      );
    }

    const db = getDb();
    const mode = body.mode as string | undefined;

    let deleted = 0;
    db.transaction(() => {
      if (mode === 'done') {
        const result = db.prepare(`DELETE FROM tasks WHERE status IN ('done', 'cancelled')`).run();
        deleted = result.changes;
      } else {
        // Delete all — also clean up linked rows
        db.prepare(`DELETE FROM session_completions WHERE task_id IN (SELECT id FROM tasks)`).run();
        db.prepare(`DELETE FROM node_task_links`).run();
        const result = db.prepare(`DELETE FROM tasks`).run();
        deleted = result.changes;
        // Reset autoincrement sequence
        db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'tasks'`).run();
      }
    })();

    console.log(`[reset-tasks] Deleted ${deleted} tasks (mode=${mode ?? 'all'})`);

    return NextResponse.json({
      success: true,
      deleted,
      mode: mode ?? 'all',
      message: mode === 'done'
        ? `Removed ${deleted} done/cancelled tasks.`
        : `Removed all ${deleted} tasks and linked records.`,
    });
  } catch (err) {
    console.error('[reset-tasks] Failed:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
