import { createHash } from 'node:crypto';
import { getDb, getSetting, setSetting } from './db';
import { expandCalendarICS } from './calendar-ics';

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
    // Event MAX(synced_at) cannot distinguish an empty successful fetch from a
    // never-synced mirror, and a partial sync is not evidence of availability.
    const url = getSetting('calendar_ics_url');
    if (!url || getSetting('calendar_ics_last_success_source') !== createHash('sha256').update(url).digest('hex')) return null;
    const stamp = getSetting('calendar_ics_last_success_at');
    if (!stamp) return null;
    const parsed = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(stamp) ? `${stamp.replace(' ', 'T')}Z` : stamp);
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

        const date = new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
        const today = Date.parse(`${date}T00:00:00+05:30`);
        const windowStart = new Date(today - 7 * 86_400_000);
        const windowEnd = new Date(today + 30 * 86_400_000);
        const events = expandCalendarICS(icsText, windowStart, windowEnd);
        const db = getDb(), syncBatchTime = new Date().toISOString();
        db.transaction(() => {
            const upsert = db.prepare(`
                INSERT INTO calendar_events(id,title,description,start_time,end_time,location,synced_at)
                VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,description=excluded.description,start_time=excluded.start_time,
                end_time=excluded.end_time,location=excluded.location,synced_at=excluded.synced_at
            `);
            for (const event of events) upsert.run(event.id,event.title,event.description,event.start,event.end,event.location,syncBatchTime);
            // Snapshot membership, rather than a clock stamp, also handles two
            // successful syncs in the same millisecond with deleted events.
            db.prepare(`DELETE FROM calendar_events
                WHERE julianday(end_time)>julianday(?) AND julianday(start_time)<julianday(?)
                AND id NOT IN (SELECT value FROM json_each(?))
            `).run(windowStart.toISOString(),windowEnd.toISOString(),JSON.stringify(events.map(event=>event.id)));
            setSetting('calendar_ics_last_success_at', syncBatchTime);
            setSetting('calendar_ics_last_success_source', createHash('sha256').update(icsUrl).digest('hex'));
        })();
        result.synced = events.length;
        result.total = events.length;

    } catch (err) {
        console.error('[Calendar] Sync failed completely:', err);
        result.errors.push(`Sync failed: ${String(err)}`);
    }

    return result;
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
