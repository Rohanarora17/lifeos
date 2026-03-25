import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * POST /api/guardian/session/complete
 * Actions a pending session_completion review card.
 *
 * Body:
 *   id            — session_completions.id (required)
 *   action        — 'done' | 'blocked' | 'skipped' (required)
 *   completion_note — free text (optional)
 *   blocker_note    — reason if blocked (optional)
 *   mark_task_done  — boolean, default false
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, action, completion_note, blocker_note, mark_task_done } = body;

    if (!id || !action) {
      return NextResponse.json({ error: 'id and action are required' }, { status: 400 });
    }
    if (!['done', 'blocked', 'skipped'].includes(action)) {
      return NextResponse.json({ error: 'action must be done | blocked | skipped' }, { status: 400 });
    }

    const db = getDb();
    const completion = db.prepare(
      `SELECT id, task_id, status FROM session_completions WHERE id = ?`
    ).get(id) as { id: number; task_id: number | null; status: string } | undefined;

    if (!completion) {
      return NextResponse.json({ error: 'completion not found' }, { status: 404 });
    }
    if (completion.status !== 'pending') {
      return NextResponse.json({ error: 'completion already actioned' }, { status: 409 });
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE session_completions
        SET status = ?, completion_note = ?, blocker_note = ?, actioned_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(action, completion_note ?? null, blocker_note ?? null, id);

      // Optionally mark the linked task as done
      if (mark_task_done && completion.task_id && action === 'done') {
        db.prepare(`
          UPDATE tasks SET status = 'done', updated_at = datetime('now', 'localtime')
          WHERE id = ? AND status != 'done'
        `).run(completion.task_id);
      }

      // If blocked, set blocked_since on the task
      if (action === 'blocked' && completion.task_id && blocker_note) {
        db.prepare(`
          UPDATE tasks
          SET blocked_since = datetime('now', 'localtime')
          WHERE id = ? AND blocked_since IS NULL
        `).run(completion.task_id);
      }
    })();

    return NextResponse.json({ success: true, id, action });
  } catch (error) {
    console.error('[guardian/session/complete] POST failed', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
