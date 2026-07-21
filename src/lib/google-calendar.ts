import { google } from 'googleapis';
import { getSetting, setSetting } from './db';
import { buildPersonalizationSnapshot, type PersonalizationSnapshot } from './personalization-context';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/calendar/google/callback';

export function getOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

export function getAuthUrl(): string {
  const auth = getOAuth2Client();
  return auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
  });
}

/**
 * Exchange auth code for tokens and store refresh token in DB.
 */
export async function handleOAuthCallback(code: string): Promise<void> {
  const auth = getOAuth2Client();
  const { tokens } = await auth.getToken(code);
  auth.setCredentials(tokens);
  if (tokens.refresh_token) {
    setSetting('google_calendar_refresh_token', tokens.refresh_token);
  }
}

function getAuthedClient() {
  const refreshToken = getSetting('google_calendar_refresh_token');
  if (!refreshToken) return null;
  const auth = getOAuth2Client();
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function calendarId(): string {
  return process.env.GOOGLE_CALENDAR_ID || getSetting('google_calendar_id') || 'primary';
}

export function isCalendarConfigured(): boolean {
  return !!(getSetting('google_calendar_refresh_token'));
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export interface CalendarEventInput {
  summary: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  colorId?: string; // '1'=lavender '2'=sage '3'=grape '4'=flamingo '9'=blueberry '11'=tomato
  reminderSnapshot?: PersonalizationSnapshot;
}

export interface CalendarReminderDecision {
  useDefault: boolean;
  overrides: Array<{ method: 'popup'; minutes: number }>;
  reason: string;
  label: string;
}

function eventDurationMinutes(input: Pick<CalendarEventInput, 'startTime' | 'endTime'>): number {
  return Math.max(5, Math.round((input.endTime.getTime() - input.startTime.getTime()) / 60000));
}

function minutesUntil(input: Pick<CalendarEventInput, 'startTime'>): number {
  return Math.round((input.startTime.getTime() - Date.now()) / 60000);
}

function uniqueReminderMinutes(minutes: number[], leadMinutes: number): number[] {
  return Array.from(new Set(minutes))
    .map(value => Math.round(value))
    .filter(value => value > 0 && value < leadMinutes)
    .sort((a, b) => b - a)
    .slice(0, 3);
}

export function buildAdaptiveCalendarReminders(
  input: Pick<CalendarEventInput, 'summary' | 'startTime' | 'endTime'>,
  snapshot?: PersonalizationSnapshot | null
): CalendarReminderDecision {
  const duration = eventDurationMinutes(input);
  const leadMinutes = minutesUntil(input);

  if (leadMinutes <= 5) {
    return {
      useDefault: false,
      overrides: [],
      reason: 'session starts immediately, so pre-start calendar reminders would be stale',
      label: 'no stale pre-start reminders',
    };
  }

  const mode = snapshot?.moment.mode ?? 'normal';
  const energy = snapshot?.userState.energy ?? 'medium';
  const mood = snapshot?.userState.mood ?? null;
  const alertFatigue = snapshot?.feedback.alertFatigueLevel ?? 'low';
  const startHour = input.startTime.getHours();
  const isPeakWindow = snapshot?.userState.peakFocusHours.includes(startHour) ?? false;

  let reminderMinutes: number[];
  let reason: string;

  if (duration <= 25) {
    reminderMinutes = [5];
    reason = 'short sprint gets one close reminder';
  } else if (alertFatigue === 'high' || mode === 'protect_focus') {
    reminderMinutes = [10];
    reason = alertFatigue === 'high'
      ? 'recent alert fatigue is high, so reminders stay quiet'
      : 'focus-protection mode avoids early interruption';
  } else if (mode === 'deadline_pressure') {
    reminderMinutes = [45, 15, 5];
    reason = 'deadline pressure gets earlier warning plus a final start cue';
  } else if (mode === 'recovery' || energy === 'low' || mood === 'low') {
    reminderMinutes = [20, 5];
    reason = 'low energy or mood gets softer, closer reminders';
  } else if (mode === 'planning' || startHour >= 20 || startHour < 7) {
    reminderMinutes = [30, 10];
    reason = 'planning or off-hour sessions get a gentler two-step reminder';
  } else if (isPeakWindow) {
    reminderMinutes = [10];
    reason = 'peak focus window gets a minimal reminder';
  } else {
    reminderMinutes = [30, 15];
    reason = 'normal day uses the learned baseline reminder cadence';
  }

  if (duration >= 75 && alertFatigue !== 'high' && mode !== 'protect_focus') {
    reminderMinutes.unshift(60);
  }

  const overrides = uniqueReminderMinutes(reminderMinutes, leadMinutes)
    .map(minutes => ({ method: 'popup' as const, minutes }));

  return {
    useDefault: false,
    overrides,
    reason,
    label: overrides.length
      ? `${overrides.map(reminder => `${reminder.minutes}m`).join(' + ')} before`
      : 'no valid pre-start reminders',
  };
}

/**
 * Create a calendar event. Returns the event ID.
 */
export async function createCalendarEvent(input: CalendarEventInput): Promise<string | null> {
  const auth = getAuthedClient();
  if (!auth) return null;

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const snapshot = input.reminderSnapshot ?? buildPersonalizationSnapshot({ surface: 'scheduler', maxInsights: 2, includeMemoryFacts: 2 });
    const reminderDecision = buildAdaptiveCalendarReminders(input, snapshot);
    const res = await calendar.events.insert({
      calendarId: calendarId(),
      requestBody: {
        summary: input.summary,
        description: [
          input.description,
          `LifeOS adaptive reminders: ${reminderDecision.label} (${reminderDecision.reason}).`,
        ].filter(Boolean).join('\n\n'),
        start: { dateTime: input.startTime.toISOString(), timeZone: 'Asia/Kolkata' },
        end: { dateTime: input.endTime.toISOString(), timeZone: 'Asia/Kolkata' },
        colorId: input.colorId ?? '9', // blueberry for study sessions
        reminders: {
          useDefault: reminderDecision.useDefault,
          overrides: reminderDecision.overrides,
        },
      },
    });
    return res.data.id ?? null;
  } catch (err) {
    // invalid_grant means the refresh token has expired/been revoked.
    // Clear it so isCalendarConfigured() returns false and we stop retrying.
    const errMsg = String(err);
    if (errMsg.includes('invalid_grant') || (err as { code?: number }).code === 400) {
      console.warn('[GCal] Refresh token invalid — clearing stored token. Re-authenticate at /api/calendar/google/auth.');
      setSetting('google_calendar_refresh_token', '');
    } else {
      console.error('[GCal] createEvent failed:', err);
    }
    return null;
  }
}

/**
 * Update an existing event (e.g., set actual end time + focus score in description).
 */
export async function updateCalendarEvent(
  eventId: string,
  patch: Partial<CalendarEventInput> & { description?: string }
): Promise<boolean> {
  const auth = getAuthedClient();
  if (!auth) return false;

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const body: Record<string, unknown> = {};
    if (patch.summary) body.summary = patch.summary;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.startTime) body.start = { dateTime: patch.startTime.toISOString(), timeZone: 'Asia/Kolkata' };
    if (patch.endTime) body.end = { dateTime: patch.endTime.toISOString(), timeZone: 'Asia/Kolkata' };
    if (patch.colorId) body.colorId = patch.colorId;

    await calendar.events.patch({
      calendarId: calendarId(),
      eventId,
      requestBody: body,
    });
    return true;
  } catch (err) {
    console.error('[GCal] updateEvent failed:', err);
    return false;
  }
}

/**
 * Delete a calendar event.
 */
export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  const auth = getAuthedClient();
  if (!auth) return false;

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: calendarId(), eventId });
    return true;
  } catch (err) {
    console.error('[GCal] deleteEvent failed:', err);
    return false;
  }
}

/**
 * Check for calendar conflicts in a given time window.
 * Returns any events that overlap with [startTime, endTime].
 */
export async function getConflictingEvents(
  startTime: Date,
  endTime: Date
): Promise<Array<{ title: string; start: string; end: string }>> {
  const auth = getAuthedClient();
  if (!auth) return [];

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.events.list({
      calendarId: calendarId(),
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10,
    });

    return (res.data.items ?? [])
      .filter(e => e.status !== 'cancelled')
      .map(e => ({
        title: e.summary ?? '(no title)',
        start: e.start?.dateTime ?? e.start?.date ?? '',
        end: e.end?.dateTime ?? e.end?.date ?? '',
      }));
  } catch (err) {
    console.error('[GCal] getConflictingEvents failed:', err);
    return [];
  }
}

/**
 * List upcoming events (next N hours). Used for day briefing context.
 */
export async function listUpcomingEvents(hoursAhead = 12): Promise<Array<{ title: string; start: string; end: string }>> {
  const auth = getAuthedClient();
  if (!auth) return [];

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const now = new Date();
    const timeMax = new Date(now.getTime() + hoursAhead * 3600_000);

    const res = await calendar.events.list({
      calendarId: calendarId(),
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10,
    });

    return (res.data.items ?? []).map(e => ({
      title: e.summary ?? '(no title)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
    }));
  } catch (err) {
    console.error('[GCal] listEvents failed:', err);
    return [];
  }
}
