import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { touchIntelligence } from '@/lib/intelligence';

type CapacityState = 'high' | 'medium' | 'low';

function isCapacityState(value: unknown): value is CapacityState {
  return value === 'high' || value === 'medium' || value === 'low';
}

function todayIst(): string {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

// POST: Explicitly correct today's mood and/or energy from the dashboard.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mood = body.mood;
  const energy = body.energy;

  if (!isCapacityState(mood) && !isCapacityState(energy)) {
    return NextResponse.json({ error: 'Provide mood and/or energy as high, medium, or low.' }, { status: 400 });
  }

  const db = getDb();
  const date = todayIst();
  const existing = db.prepare(`
    SELECT id FROM daily_checkins
    WHERE checkin_date = ? AND checkin_type = 'morning'
    ORDER BY received_at DESC, id DESC
    LIMIT 1
  `).get(date) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE daily_checkins
      SET mood = COALESCE(?, mood), energy = COALESCE(?, energy), received_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(isCapacityState(mood) ? mood : null, isCapacityState(energy) ? energy : null, existing.id);
  } else {
    db.prepare(`
      INSERT INTO daily_checkins (checkin_date, checkin_type, mood, energy, raw_transcript)
      VALUES (?, 'morning', ?, ?, 'Explicit dashboard state update')
    `).run(date, isCapacityState(mood) ? mood : null, isCapacityState(energy) ? energy : null);
  }

  touchIntelligence('explicit_dashboard_state');
  return NextResponse.json({
    ok: true,
    date,
    mood: isCapacityState(mood) ? mood : null,
    energy: isCapacityState(energy) ? energy : null,
    source: 'explicit_checkin',
  });
}
