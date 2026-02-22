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
    if (!icsUrl) {
        return { synced: 0, total: 0, errors: ['Calendar ICS URL not configured'] };
    }

    const result: SyncResult = { synced: 0, total: 0, errors: [] };

    try {
        const res = await fetch(icsUrl, {
            headers: { 'User-Agent': 'LifeOS/1.0' },
            next: { revalidate: 0 }
        });
        if (!res.ok) {
            result.errors.push(`Failed to fetch ICS: HTTP ${res.status}`);
            return result;
        }

        const icsText = await res.text();
        let events: CalendarEvent[] = [];
        try {
            events = parseICS(icsText);
            result.total = events.length;
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

        // Only sync events from today onwards (no ancient history)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        for (const event of events) {
            const eventDate = new Date(event.startTime);
            if (eventDate >= new Date(today.getTime() - 7 * 86400000)) { // Last 7 days + future
                try {
                    upsert.run(
                        event.uid, event.title, event.description, event.startTime, event.endTime, event.location,
                        event.title, event.description, event.startTime, event.endTime, event.location
                    );
                    result.synced++;
                } catch (e) {
                    console.error(`[Calendar] Failed to insert event: ${event.title}`, e);
                }
            }
        }
    } catch (err) {
        console.error('[Calendar] Sync failed completely:', err);
        result.errors.push(`Sync failed: ${String(err)}`);
    }

    return result;
}

/**
 * Lightweight ICS (iCalendar) parser.
 * Extracts VEVENT components: UID, SUMMARY, DTSTART, DTEND, LOCATION, DESCRIPTION.
 */
function parseICS(icsText: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];
    // Unfold lines first (ICS specs say lines continuing with space/tab belong to previous line)
    const lines = icsText.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);

    let inEvent = false;
    let current: Partial<CalendarEvent> = {};

    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') {
            inEvent = true;
            current = {};
            continue;
        }

        if (line === 'END:VEVENT') {
            inEvent = false;
            if (current.uid && current.title && current.startTime) {
                events.push({
                    uid: current.uid,
                    title: current.title,
                    description: current.description || '',
                    startTime: current.startTime,
                    endTime: current.endTime || current.startTime,
                    location: current.location || '',
                });
            }
            continue;
        }

        if (!inEvent) continue;

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;

        const keyPart = line.slice(0, colonIdx);
        const value = line.slice(colonIdx + 1);
        const key = keyPart.split(';')[0]; // Strip parameters like DTSTART;VALUE=DATE

        switch (key) {
            case 'UID':
                current.uid = value;
                break;
            case 'SUMMARY':
                current.title = unescapeICS(value);
                break;
            case 'DESCRIPTION':
                current.description = unescapeICS(value).slice(0, 500);
                break;
            case 'LOCATION':
                current.location = unescapeICS(value);
                break;
            case 'DTSTART':
                current.startTime = parseICSDate(value);
                break;
            case 'DTEND':
                current.endTime = parseICSDate(value);
                break;
        }
    }

    return events;
}

/** Parse ICS date formats: 20260222T180000Z or 20260222 */
function parseICSDate(value: string): string {
    // Full datetime: 20260222T180000Z
    if (value.length >= 15) {
        const year = value.slice(0, 4);
        const month = value.slice(4, 6);
        const day = value.slice(6, 8);
        const hour = value.slice(9, 11);
        const minute = value.slice(11, 13);
        const second = value.slice(13, 15);
        const isUTC = value.toUpperCase().endsWith('Z');
        return `${year}-${month}-${day}T${hour}:${minute}:${second}${isUTC ? 'Z' : ''}`;
    }
    // Date only: 20260222
    if (value.length >= 8) {
        return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00`;
    }
    return value;
}

/** Unescape ICS special characters */
function unescapeICS(value: string): string {
    return value
        .replace(/\\n/g, '\n')
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\\\/g, '\\');
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
