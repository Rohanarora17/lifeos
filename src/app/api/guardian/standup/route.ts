import { NextResponse } from 'next/server';
import { getDb, setSetting } from '@/lib/db';

/**
 * POST /api/guardian/standup
 * Persists the daily stand-up goal and mood from the Telegram morning check-in.
 * Stored in DB settings as `standup_goal_today` and `standup_mood_today`.
 * The longitudinal engine and day briefing read these as context.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const goal = (body.goal as string | undefined)?.trim();
    const mood = (body.mood as string | undefined)?.trim();
    const date = new Date(Date.now() + 19800000).toISOString().slice(0, 10); // IST date

    if (!goal) {
      return NextResponse.json({ error: 'goal is required' }, { status: 400 });
    }

    setSetting('standup_goal_today', goal);
    setSetting('standup_goal_date', date);
    if (mood) setSetting('standup_mood_today', mood);

    // Also log to DB for history
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(`standup_log_${date}`, JSON.stringify({ goal, mood: mood || null, date }));
    } catch { /* non-fatal */ }

    console.log(`[Standup] Goal for ${date}: "${goal}" mood=${mood || 'not set'}`);

    return NextResponse.json({ success: true, goal, mood: mood || null, date });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/**
 * GET /api/guardian/standup — return today's stand-up goal.
 */
export async function GET() {
  const { getSetting } = await import('@/lib/db');
  const goal = getSetting('standup_goal_today');
  const date = getSetting('standup_goal_date');
  const mood = getSetting('standup_mood_today');
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

  return NextResponse.json({
    goal: date === today ? goal : null,
    mood: date === today ? mood : null,
    date: date === today ? date : null,
  });
}
