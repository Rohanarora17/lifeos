import ical, { type VEvent } from 'node-ical';

export interface CalendarOccurrence {
    id: string;
    title: string;
    description: string;
    start: string;
    end: string;
    location: string;
}

const IST_OFFSET = 19_800_000;
const DATE_FIELDS = new Set(['DTSTART', 'DTEND', 'RECURRENCE-ID', 'EXDATE']);

function validateDate(value: string): void {
    const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value);
    if (!match) throw new Error('Invalid ICS date value');
    const [, y, m, d, h = '0', min = '0', sec = '0'] = match;
    const parts = [Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(sec)];
    const date = new Date(Date.UTC(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]));
    if (date.getUTCFullYear() !== parts[0] || date.getUTCMonth() !== parts[1] || date.getUTCDate() !== parts[2]
        || date.getUTCHours() !== parts[3] || date.getUTCMinutes() !== parts[4] || date.getUTCSeconds() !== parts[5]) {
        throw new Error('Invalid ICS date bounds');
    }
}

/** Preserve the existing LifeOS IST interpretation of floating dates on every host. */
function prepareCalendar(text: string): { text: string; uids: Set<string> } {
    const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(line => line.length);
    if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR') throw new Error('Invalid ICS calendar envelope');
    const stack: string[] = [], uids = new Set<string>();
    let event: { uid?: string; start?: string; cancelled?: boolean } | null = null;
    const normalized: string[] = [];
    for (let line of lines) {
        const separator = line.indexOf(':');
        if (separator < 1) throw new Error('Invalid ICS content line');
        const property = line.slice(0, separator), value = line.slice(separator + 1);
        const name = property.split(';')[0].toUpperCase();
        if (name === 'BEGIN') {
            stack.push(value);
            if (value === 'VEVENT') {
                if (event) throw new Error('Nested ICS event');
                event = {};
            }
        } else if (name === 'END') {
            if (stack.pop() !== value) throw new Error('Incomplete ICS component');
            if (value === 'VEVENT') {
                if (!event?.uid || (!event.start && !event.cancelled)) throw new Error('Incomplete ICS event');
                uids.add(event.uid);
                event = null;
            }
        } else if (stack.at(-1) === 'VEVENT') {
            if (name === 'UID' && event) event.uid = value;
            if (name === 'STATUS' && value === 'CANCELLED' && event) event.cancelled = true;
            if (name === 'RDATE' || name === 'EXRULE' || /;RANGE=/i.test(property)) throw new Error('Unsupported ICS recurrence set');
            if (DATE_FIELDS.has(name)) {
                for (const date of value.split(',')) validateDate(date);
                const timezone = /;TZID=("[^"]+"|[^;]+)/i.exec(property)?.[1]?.replace(/^"|"$/g, '');
                if (timezone) {
                    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
                    catch { throw new Error('Unknown ICS event timezone'); }
                }
                if (name === 'DTSTART' && event) event.start = value;
                if (!timezone && value.includes('T') && !value.endsWith('Z')) line = `${property};TZID=Asia/Kolkata:${value}`;
            }
        }
        normalized.push(line);
    }
    if (stack.length || event) throw new Error('Incomplete ICS calendar');
    return { text: normalized.join('\r\n'), uids };
}

function stringValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'val' in value && typeof value.val === 'string') return value.val;
    return '';
}

function fullDayInIST(date: Date): Date {
    // node-ical intentionally returns full-day instances at host-local midnight.
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - IST_OFFSET);
}

/** Parse and validate the complete snapshot before the caller mutates its mirror. */
export function expandCalendarICS(text: string, from: Date, to: Date): CalendarOccurrence[] {
    const prepared = prepareCalendar(text);
    const parsed = ical.sync.parseICS(prepared.text);
    const events = Object.values(parsed).filter((event): event is VEvent => event?.type === 'VEVENT');
    const parsedUIDs = new Set(events.map(event => event.uid));
    if ([...prepared.uids].some(uid => !parsedUIDs.has(uid))) throw new Error('Incomplete ICS events');
    const result = new Map<string, CalendarOccurrence>();
    // Include a boundary day for DATE values, which are converted to IST below.
    const lower = new Date(from.getTime() - 86_400_000), upper = new Date(to.getTime() + 86_400_000);
    for (const event of events) {
        if (event.status === 'CANCELLED') continue;
        const members = [event, ...new Set(Object.values(event.recurrences || {}))];
        for (const member of members) {
            if (member.status === 'CANCELLED') continue;
            if (!(member.start instanceof Date) || !Number.isFinite(+member.start)
                || (member.end && (!(member.end instanceof Date) || !Number.isFinite(+member.end) || member.end < member.start))) {
                throw new Error('Calendar event has invalid bounds');
            }
        }
        for (const instance of ical.expandRecurringEvent(event, { from: lower, to: upper, expandOngoing: true })) {
            if (instance.event.status === 'CANCELLED') continue;
            const start = instance.isFullDay ? fullDayInIST(instance.start) : instance.start;
            const end = instance.isFullDay ? fullDayInIST(instance.end) : instance.end;
            if (!Number.isFinite(+start) || !Number.isFinite(+end) || end < start) throw new Error('Calendar occurrence has invalid bounds');
            // RFC 5545 DATE-TIME events with no duration are instantaneous.
            if (+end === +start) continue;
            if (end <= from || start >= to) continue;
            const id = `${event.uid}_${start.toISOString()}`;
            const row = { id, title: stringValue(instance.summary) || 'Calendar commitment',
                description: stringValue(instance.event.description) || stringValue(event.description),
                location: stringValue(instance.event.location) || stringValue(event.location),
                start: start.toISOString(), end: end.toISOString() };
            if (result.has(id) && JSON.stringify(result.get(id)) !== JSON.stringify(row)) throw new Error('Conflicting ICS occurrence identity');
            result.set(id, row);
            if (result.size > 20_000) throw new Error('Calendar expansion exceeds supported window capacity');
        }
    }
    return [...result.values()];
}
