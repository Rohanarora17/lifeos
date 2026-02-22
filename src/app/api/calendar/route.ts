import { NextResponse } from 'next/server';
import { syncCalendarFromICS, getTodayEvents, getUpcomingEvents, getCalendarEvents } from '@/lib/calendar';

// GET — Fetch calendar events
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'today';

    if (action === 'upcoming') {
        return NextResponse.json({ events: getUpcomingEvents() });
    }

    if (action === 'range') {
        const start = searchParams.get('start') || new Date().toISOString().slice(0, 10);
        const end = searchParams.get('end') || start;
        return NextResponse.json({ events: getCalendarEvents(start, end) });
    }

    // Default: today's events
    return NextResponse.json({ events: getTodayEvents() });
}

// POST — Trigger calendar sync from ICS feed
export async function POST() {
    const result = await syncCalendarFromICS();
    return NextResponse.json(result);
}
