import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

/**
 * POST /api/guardian/reflection/note
 * Appends a user note to an existing session reflection.
 * Called when the user taps "Add Note" on the Telegram session-end message.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sessionId = body.sessionId as string | undefined;
    const note = (body.note as string | undefined)?.trim();

    if (!note) {
      return NextResponse.json({ error: 'note is required' }, { status: 400 });
    }

    const db = getDb();

    if (sessionId) {
      // Append note to the specific session reflection
      const existing = db.prepare(
        'SELECT reflection_text FROM guardian_session_reflections WHERE session_id = ?'
      ).get(sessionId) as { reflection_text: string } | undefined;

      if (existing) {
        const updated = `${existing.reflection_text}\n\n📝 User note: ${note}`;
        db.prepare(
          'UPDATE guardian_session_reflections SET reflection_text = ? WHERE session_id = ?'
        ).run(updated, sessionId);
      } else {
        db.prepare(
          'INSERT INTO guardian_session_reflections (session_id, reflection_text) VALUES (?, ?)'
        ).run(sessionId, `📝 User note: ${note}`);
      }
    } else {
      // Append to most recent session reflection
      const recent = db.prepare(
        'SELECT session_id, reflection_text FROM guardian_session_reflections ORDER BY rowid DESC LIMIT 1'
      ).get() as { session_id: string; reflection_text: string } | undefined;

      if (recent) {
        const updated = `${recent.reflection_text}\n\n📝 User note: ${note}`;
        db.prepare(
          'UPDATE guardian_session_reflections SET reflection_text = ? WHERE session_id = ?'
        ).run(updated, recent.session_id);
      }
    }

    console.log(`[Reflection] Note appended for session ${sessionId ?? 'latest'}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
