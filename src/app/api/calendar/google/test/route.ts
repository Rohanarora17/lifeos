import { NextRequest, NextResponse } from 'next/server';
import { createCalendarEvent, isCalendarConfigured } from '@/lib/google-calendar';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';

function calendarSetupError(): string {
  try {
    const snapshot = buildPersonalizationSnapshot({
      surface: 'scheduler',
      maxInsights: 2,
      includeMemoryFacts: 2,
    });
    if (snapshot.today.plannedFocus.nextTitle) {
      return `Google Calendar is not connected yet. Connect it before syncing the next planned block: ${snapshot.today.plannedFocus.nextTitle}.`;
    }
    if (snapshot.moment.mode === 'planning') {
      return 'Google Calendar is not connected yet. Connect it before turning tomorrow planning into synced focus blocks.';
    }
    return `Google Calendar is not connected yet. Connect it before scheduling around ${snapshot.userState.nextBestFocusWindow}.`;
  } catch {
    return 'Google Calendar is not connected yet. Visit /api/calendar/google/auth first.';
  }
}

export async function POST(req: NextRequest) {
  if (!isCalendarConfigured()) {
    return NextResponse.json({ success: false, error: calendarSetupError() }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const now = new Date();
  const end = new Date(now.getTime() + 30 * 60_000);

  const eventId = await createCalendarEvent({
    summary: body.summary ?? '🧪 LifeOS Calendar Test',
    description: body.description ?? 'Integration test — safe to delete.',
    startTime: body.startTime ? new Date(body.startTime) : now,
    endTime: body.endTime ? new Date(body.endTime) : end,
    colorId: '9',
  });

  if (!eventId) {
    return NextResponse.json({ success: false, error: 'Event creation failed — check server logs' }, { status: 500 });
  }

  return NextResponse.json({ success: true, eventId });
}
