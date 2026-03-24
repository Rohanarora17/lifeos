import { NextRequest, NextResponse } from 'next/server';
import { createCalendarEvent, isCalendarConfigured } from '@/lib/google-calendar';

export async function POST(req: NextRequest) {
  if (!isCalendarConfigured()) {
    return NextResponse.json({ success: false, error: 'Google Calendar not configured — visit /api/calendar/google/auth first' }, { status: 400 });
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
