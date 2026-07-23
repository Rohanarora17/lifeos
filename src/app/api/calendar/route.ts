import { NextResponse } from 'next/server';
import { syncCalendarFromICS, getTodayEvents, getUpcomingEvents, getCalendarEvents } from '@/lib/calendar';
import { buildAdaptiveCalendarPolicy } from '@/lib/adaptive-calendar-policy';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';

// GET — Fetch calendar events
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'today';
    const view = action === 'upcoming' ? 'upcoming' : 'today';
    const snapshot = buildPersonalizationSnapshot({
        surface: 'scheduler',
        maxInsights: 2,
        includeMemoryFacts: 3,
    });

    if (action === 'upcoming') {
        const events = getUpcomingEvents();
        return NextResponse.json({
            events,
            calendarPolicy: buildAdaptiveCalendarPolicy(snapshot, 'upcoming', events.length),
        });
    }

    if (action === 'range') {
        const start = searchParams.get('start') || new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        const end = searchParams.get('end') || start;
        const events = getCalendarEvents(start, end);
        return NextResponse.json({
            events,
            calendarPolicy: buildAdaptiveCalendarPolicy(snapshot, view, events.length),
        });
    }

    // Default: today's events
    const events = getTodayEvents();
    return NextResponse.json({
        events,
        calendarPolicy: buildAdaptiveCalendarPolicy(snapshot, 'today', events.length),
    });
}

// POST — Trigger calendar sync from ICS feed
export async function POST() {
    const result = await syncCalendarFromICS();
    return NextResponse.json(result);
}
