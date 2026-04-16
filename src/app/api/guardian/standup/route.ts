import { NextResponse } from 'next/server';
import { getDb, setSetting } from '@/lib/db';
import { classifyEnergy } from '@/lib/adaptive-bands';

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
 * GET /api/guardian/standup — return today's stand-up goal + ranked task suggestions.
 */
export async function GET() {
  const { getSetting } = await import('@/lib/db');
  const { computeEnergyComposite } = await import('@/lib/energy-composite');
  const { rankTasksForSession } = await import('@/lib/session-task-ranker');

  const goal = getSetting('standup_goal_today');
  const date = getSetting('standup_goal_date');
  const mood = getSetting('standup_mood_today');
  const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);

  const isToday = date === today;

  // Compute energy composite and surface ranked suggestions
  let energy = null;
  let suggestedTasks = [];
  let weakConcepts: Array<{ id: number; title: string; mastery: number; goalTitle: string | null }> = [];
  try {
    const components = computeEnergyComposite();
    energy = {
      composite: components.composite_score,
      band: classifyEnergy(components.composite_score),
      standup_mood: components.standup_mood,
      circadian_prior: components.circadian_prior,
    };
    suggestedTasks = rankTasksForSession(components.composite_score, 5) as any[];
  } catch { /* non-fatal */ }

  // Surface weak knowledge concepts across all active goals
  try {
    const { getDb } = await import('@/lib/db');
    const { getUnblockedNextConcepts } = await import('@/lib/graph');
    const db = getDb();
    const goals = db.prepare(`SELECT id, title FROM goals WHERE active = 1`).all() as { id: number; title: string }[];
    for (const goal of goals) {
      const concepts = getUnblockedNextConcepts(goal.id).slice(0, 2);
      for (const c of concepts) {
        weakConcepts.push({ id: c.id, title: c.title, mastery: Math.round(c.mastery * 100), goalTitle: goal.title });
      }
    }
    weakConcepts.sort((a, b) => a.mastery - b.mastery);
    weakConcepts = weakConcepts.slice(0, 5);
  } catch { /* non-fatal */ }

  return NextResponse.json({
    goal: isToday ? goal : null,
    mood: isToday ? mood : null,
    date: isToday ? date : null,
    energy,
    suggestedTasks,
    weakConcepts,
  });
}
