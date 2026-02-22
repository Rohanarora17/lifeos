import { getDb, getSetting } from './db';

// ============================================================
//  GOOGLE CALENDAR SYNC via ICS Feed
//  No OAuth needed — user pastes their "Secret address in iCal format"
// ============================================================

interface CalendarEvent {
    uid: string;
    title: string;
    description: string;
    startTime: string;
    endTime: string;
    location: string;
}

interface SyncResult {
    synced: number;
    total: number;
    errors: string[];
}

/**
 * Sync calendar events from a Google Calendar ICS feed URL.
 */
export async function syncCalendarFromICS(): Promise<SyncResult> {
    const icsUrl = getSetting('calendar_ics_url');
    console.log('[Calendar] Starting sync. ICS URL configured:', !!icsUrl);
    console.log('[Calendar] ICS URL:', icsUrl);

    if (!icsUrl) {
        return { synced: 0, total: 0, errors: ['Calendar ICS URL not configured'] };
    }

    const result: SyncResult = { synced: 0, total: 0, errors: [] };

    try {
        console.log('[Calendar] Fetching ICS from url...');
        const res = await fetch(icsUrl, {
            headers: { 'User-Agent': 'LifeOS/1.0' },
            next: { revalidate: 0 }
        });

        console.log('[Calendar] Fetch response status:', res.status, res.statusText);

        if (!res.ok) {
            console.error('[Calendar] Fetch failed:', res.status);
            result.errors.push(`Failed to fetch ICS: HTTP ${res.status}`);
            return result;
        }

        const icsText = await res.text();
        console.log(`[Calendar] Fetched ICS text length: ${icsText.length} characters`);

        let parsedData: any;
        try {
            const ical = require('node-ical');
            parsedData = ical.sync.parseICS(icsText);
        } catch (e) {
            console.error('[Calendar] Failed to parse ICS format:', e);
            result.errors.push(`Parse error: ${String(e)}`);
            return result;
        }

        const db = getDb();
        const upsert = db.prepare(`
      INSERT INTO calendar_events (id, title, description, start_time, end_time, location, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        title = ?, description = ?, start_time = ?, end_time = ?, location = ?, synced_at = datetime('now')
    `);

        // Sync window: from 7 days ago to 30 days in the future
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const windowStart = new Date(today.getTime() - 7 * 86400000);
        const windowEnd = new Date(today.getTime() + 30 * 86400000);

        let eventCount = 0;

        for (const key in parsedData) {
            if (!parsedData.hasOwnProperty(key)) continue;
            const ev = parsedData[key];
            if (ev.type !== 'VEVENT') continue;

            let instances: { start: Date, end: Date }[] = [];

            const evStart = new Date(ev.start);
            const evEnd = new Date(ev.end || ev.start);
            const duration = evEnd.getTime() - evStart.getTime();

            if (ev.rrule) {
                // Expand recurring events within our window
                const dates = ev.rrule.between(windowStart, windowEnd);
                for (const date of dates) {
                    // node-ical rrule between() returns Date objects for start times
                    instances.push({
                        start: new Date(date),
                        end: new Date(new Date(date).getTime() + duration) // Add duration to each new start
                    });
                }
            } else {
                // Single event
                if (evStart >= windowStart && evStart <= windowEnd) {
                    instances.push({ start: evStart, end: evEnd });
                }
            }

            for (const instance of instances) {
                try {
                    // To avoid PK conflicts on recurring events, augment the ID with the start ISO string
                    const instanceId = `${ev.uid}_${instance.start.toISOString()}`;
                    const title = ev.summary || 'Busy';
                    const description = ev.description || '';
                    const loc = ev.location || '';
                    const startTime = instance.start.toISOString();
                    const endTime = instance.end.toISOString();

                    upsert.run(
                        instanceId, title, description, startTime, endTime, loc,
                        title, description, startTime, endTime, loc
                    );
                    eventCount++;
                    result.synced++;
                } catch (e) {
                    console.error(`[Calendar] Failed to insert event: ${ev.summary}`, e);
                }
            }
        }

        result.total = eventCount;

    } catch (err) {
        console.error('[Calendar] Sync failed completely:', err);
        result.errors.push(`Sync failed: ${String(err)}`);
    }

    return result;
}



/**
 * Get calendar events for a date range.
 */
export function getCalendarEvents(startDate?: string, endDate?: string) {
    const db = getDb();
    const start = startDate || new Date().toISOString().slice(0, 10);
    const end = endDate || start;

    return db.prepare(`
    SELECT * FROM calendar_events
    WHERE date(start_time) >= ? AND date(start_time) <= ?
    ORDER BY start_time ASC
  `).all(start, end);
}

/**
 * Get today's events for morning brief / dashboard.
 */
export function getTodayEvents() {
    const today = new Date().toISOString().slice(0, 10);
    return getCalendarEvents(today, today);
}

/**
 * Get upcoming events (next 7 days).
 */
export function getUpcomingEvents() {
    const today = new Date().toISOString().slice(0, 10);
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    return getCalendarEvents(today, nextWeek);
}
