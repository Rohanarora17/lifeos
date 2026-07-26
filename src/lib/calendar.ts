import { getDb, getSetting } from './db';
import { rrulestr } from 'rrule';

// ============================================================
//  GOOGLE CALENDAR SYNC via ICS Feed
//  No OAuth needed — user pastes their "Secret address in iCal format"
// ============================================================

export interface CalendarEvent {
    uid: string;
    title: string;
    description: string;
    startTime: string;
    endTime: string;
    location: string;
    rrule?: string;
    exdate?: string[];
}

export interface SyncResult {
    synced: number;
    total: number;
    errors: string[];
}

const CALENDAR_SYNC_MAX_AGE_MS = 15 * 60_000;
let calendarSyncInFlight: Promise<SyncResult> | null = null;

function latestCalendarSyncAgeMs(): number | null {
    const row = getDb().prepare(`
        SELECT MAX(synced_at) as synced_at
        FROM calendar_events
    `).get() as { synced_at: string | null } | undefined;
    if (!row?.synced_at) return null;

    const parsed = Date.parse(`${row.synced_at.replace(' ', 'T')}Z`);
    return Number.isFinite(parsed) ? Date.now() - parsed : null;
}

/**
 * Refresh the read-only ICS mirror before a schedule view when it is stale.
 * Concurrent dashboard and calendar reads share a single fetch.
 */
export async function syncCalendarIfStale(maxAgeMs = CALENDAR_SYNC_MAX_AGE_MS): Promise<SyncResult | null> {
    if (!getSetting('calendar_ics_url')) return null;

    const ageMs = latestCalendarSyncAgeMs();
    if (ageMs !== null && ageMs >= 0 && ageMs < maxAgeMs) return null;

    if (!calendarSyncInFlight) {
        calendarSyncInFlight = syncCalendarFromICS().finally(() => {
            calendarSyncInFlight = null;
        });
    }
    return calendarSyncInFlight;
}

/**
 * Sync calendar events from a Google Calendar ICS feed URL.
 */
export async function syncCalendarFromICS(): Promise<SyncResult> {
    const icsUrl = getSetting('calendar_ics_url');
    console.log('[Calendar] Starting ICS sync. URL configured:', !!icsUrl);

    if (!icsUrl) {
        return { synced: 0, total: 0, errors: ['Calendar ICS URL not configured'] };
    }

    const result: SyncResult = { synced: 0, total: 0, errors: [] };

    try {
        console.log('[Calendar] Fetching ICS from url...');
        const res = await fetch(icsUrl, {
            headers: { 'User-Agent': 'LifeOS/1.0' },
            next: { revalidate: 0 },
            signal: AbortSignal.timeout(10_000),
        });

        console.log('[Calendar] Fetch response status:', res.status, res.statusText);

        if (!res.ok) {
            console.error('[Calendar] Fetch failed:', res.status);
            result.errors.push(`Failed to fetch ICS: HTTP ${res.status}`);
            return result;
        }

        const icsText = await res.text();
        console.log(`[Calendar] Fetched ICS text length: ${icsText.length} characters`);

        // 1. Parse raw events
        let events: CalendarEvent[] = [];
        try {
            events = parseICS(icsText);
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

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const windowStart = new Date(today.getTime() - 7 * 86400000);
        const windowEnd = new Date(today.getTime() + 30 * 86400000);

        let eventCount = 0;

        for (const ev of events) {
            const instances: { start: Date, end: Date }[] = [];

            const evStart = new Date(ev.startTime);
            const evEnd = new Date(ev.endTime || ev.startTime);
            const duration = evEnd.getTime() - evStart.getTime();

            if (ev.rrule) {
                try {
                    // NOTE: Node-rrule uses the dtstart provided in the options mapping, but rrulestr can take it from string or it assumes current date. 
                    // Better to parse with our known start date to fix bounds.
                    const rruleWithStart = rrulestr(`DTSTART:${formatDateToICS(evStart)}\n${ev.rrule}`);

                    const dates = rruleWithStart.between(windowStart, windowEnd);
                    for (const date of dates) {
                        instances.push({
                            start: new Date(date),
                            end: new Date(new Date(date).getTime() + duration)
                        });
                    }
                } catch (rruleErr) {
                    console.error('[Calendar] Failed to expand RRULE for event:', ev.title, rruleErr);
                }
            } else {
                if (evStart >= windowStart && evStart <= windowEnd) {
                    instances.push({ start: evStart, end: evEnd });
                }
            }

            for (const instance of instances) {
                try {
                    const instanceId = `${ev.uid}_${instance.start.toISOString()}`;
                    upsert.run(
                        instanceId, ev.title, ev.description, instance.start.toISOString(), instance.end.toISOString(), ev.location,
                        ev.title, ev.description, instance.start.toISOString(), instance.end.toISOString(), ev.location
                    );
                    eventCount++;
                    result.synced++;
                } catch {
                    // Ignore individual upsert collisions quietly
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

/** Format native Date to ICS format YYYYMMDDTHHMMSSZ */
function formatDateToICS(date: Date): string {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Lightweight ICS (iCalendar) parser. */
function parseICS(icsText: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];
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
                    rrule: current.rrule
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
            case 'RRULE':
                current.rrule = line; // Store full line RRULE:FREQ=...
                break;
        }
    }

    return events;
}

function unescapeICS(text: string): string {
    return text
        .replace(/\\,/g, ',')
        .replace(/\\;/g, ';')
        .replace(/\\n/g, '\n')
        .replace(/\\\\/g, '\\');
}

function parseICSDate(icsDate: string): string {
    // We parse as UTC if 'Z' is present, otherwise assume IST (UTC+05:30) and convert to ISO string.

    if (icsDate.length === 8) { // YYYYMMDD (all-day event)
        const year = parseInt(icsDate.substring(0, 4), 10);
        const month = parseInt(icsDate.substring(4, 6), 10) - 1; // Month is 0-indexed
        const day = parseInt(icsDate.substring(6, 8), 10);
        // All day event starts at 00:00:00 IST -> which is 18:30:00 UTC of previous day
        const utcMs = Date.UTC(year, month, day, 0, 0, 0);
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        return new Date(utcMs - istOffsetMs).toISOString();
    }

    // YYYYMMDDTHHMMSS or YYYYMMDDTHHMMSSZ
    const year = parseInt(icsDate.substring(0, 4), 10);
    const month = parseInt(icsDate.substring(4, 6), 10) - 1;
    const day = parseInt(icsDate.substring(6, 8), 10);
    const hour = parseInt(icsDate.substring(9, 11), 10);
    const minute = parseInt(icsDate.substring(11, 13), 10);
    const second = parseInt(icsDate.substring(13, 15), 10);

    if (icsDate.endsWith('Z')) {
        return new Date(Date.UTC(year, month, day, hour, minute, second)).toISOString();
    } else {
        // Assume Indian Standard Time (IST, UTC+5:30) for floating times
        const utcMs = Date.UTC(year, month, day, hour, minute, second);
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        return new Date(utcMs - istOffsetMs).toISOString();
    }
}


/**
 * Helper to get current YYYY-MM-DD in IST
 */
function getTodayIST(): string {
    const istMs = Date.now() + (5.5 * 60 * 60 * 1000);
    return new Date(istMs).toISOString().slice(0, 10);
}

/**
 * Get calendar events for a date range in IST.
 */
export function getCalendarEvents(startDate?: string, endDate?: string) {
    const db = getDb();
    const start = startDate || getTodayIST();
    const end = endDate || start;

    return db.prepare(`
    SELECT * FROM calendar_events
    WHERE date(start_time, '+5 hours', '+30 minutes') >= ? AND date(start_time, '+5 hours', '+30 minutes') <= ?
    ORDER BY start_time ASC
  `).all(start, end);
}

/**
 * Get today's events for morning brief / dashboard (IST).
 */
export function getTodayEvents() {
    const today = getTodayIST();
    return getCalendarEvents(today, today);
}

/**
 * Get upcoming events (next 7 days) in IST.
 */
export function getUpcomingEvents() {
    const today = getTodayIST();
    const nextWeekMs = Date.now() + (5.5 * 60 * 60 * 1000) + (7 * 86400000);
    const nextWeek = new Date(nextWeekMs).toISOString().slice(0, 10);
    return getCalendarEvents(today, nextWeek);
}
