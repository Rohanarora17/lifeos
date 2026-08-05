import { getSetting, setSetting, getDb } from './db';
import {
  sendTelegram,
  formatDailyReport,
  formatMorningBrief,
  MORNING_BRIEF_KEYBOARD,
  DAILY_REPORT_KEYBOARD,
} from './telegram';
import { listUpcomingEvents } from './google-calendar';
import { forceSynthesis } from './intelligence';
import { consolidateFacts } from './memory-extractor';
import { sendMorningCheckin, sendEveningReflection, getWakeEstimate } from './checkin';
import { getActiveGuardianSession } from './guardian-runtime';
import { runContinuityCheck } from './continuity-guardian';
import { sendWeeklyReckoning } from './weekly-reckoning';
import { sendOpenLoopsAudit, sendMonthlyPatternLetter } from './open-loops';
import { decideAdaptiveJobRun } from './adaptive-scheduler';
import { buildPersonalizationSnapshot } from './personalization-context';
import { composeEveningPlanningReminder } from './notifications';

// ============================================================
//  CRON SCHEDULER — Automated jobs for LifeOS
//  Runs: daily summary, morning brief, deep analysis, GitHub sync,
//        calendar sync, screen time collection
// ============================================================

// Job registry (in-memory state)
interface ScheduledJob {
    name: string;
    schedule: string;
    lastRun: string | null;
    nextRun: string | null;
    enabled: boolean;
    running: boolean;
}

const schedulerGlobal = globalThis as typeof globalThis & {
  lifeosSchedulerState?: {
    jobs: Map<string, ScheduledJob>;
    timers: Map<string, ReturnType<typeof setInterval>>;
    initialized: boolean;
  };
};
const schedulerState = schedulerGlobal.lifeosSchedulerState ?? {
  jobs: new Map<string, ScheduledJob>(),
  timers: new Map<string, ReturnType<typeof setInterval>>(),
  initialized: false,
};
schedulerGlobal.lifeosSchedulerState = schedulerState;
const jobs = schedulerState.jobs;
const timers = schedulerState.timers;

export async function fetchSchedulerEndpoint(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = process.env.LIFEOS_API_TOKEN?.trim();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    throw new Error(
      `Scheduler endpoint failed: ${new URL(url).pathname} returned ${response.status}`
    );
  }
  return response;
}

function buildSchedulerSnapshot() {
  const activeSession = getActiveGuardianSession();
  const activeFocusScore = activeSession?.focusScoreHistory?.slice(-1)[0] ?? null;
  return buildPersonalizationSnapshot({
    surface: 'scheduler',
    maxInsights: 1,
    includeThresholds: true,
    includeMemoryFacts: 3,
    activeSession: activeSession ? {
      sessionId: activeSession.sessionId,
      targetTitle: activeSession.targetTitle,
      focusScore: activeFocusScore,
      elapsedMinutes: Math.max(0, Math.round((Date.now() - activeSession.startedAt) / 60000)),
    } : null,
  });
}

function formatSchedulerMomentLine(snapshot: ReturnType<typeof buildSchedulerSnapshot>): string {
  const modeLabel: Record<string, string> = {
    protect_focus: 'Protect focus',
    deadline_pressure: 'Deadline pressure',
    recovery: 'Recovery mode',
    planning: 'Planning/cleanup',
    normal: 'Balanced day',
  };
  const goal = snapshot.userState.standupGoal
    ? ` Goal: ${snapshot.userState.standupGoal.slice(0, 90)}.`
    : '';
  const pressure = snapshot.today.overdueTasks > 0
    ? ` ${snapshot.today.overdueTasks} overdue task${snapshot.today.overdueTasks === 1 ? '' : 's'} need attention.`
    : '';
  return `🧭 <b>Today mode:</b> ${modeLabel[snapshot.moment.mode] || snapshot.moment.mode}.${goal}${pressure}`;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function composeStreakCliffMessage(streak: number): string {
  const snapshot = buildSchedulerSnapshot();
  const commitment = snapshot.userState.standupGoal
    ? `\n\nToday you named: <i>${escapeTelegramHtml(snapshot.userState.standupGoal.slice(0, 120))}</i>`
    : '';
  const pressure = snapshot.today.overdueTasks > 0
    ? `\n\nThere ${snapshot.today.overdueTasks === 1 ? 'is' : 'are'} ${snapshot.today.overdueTasks} overdue task${snapshot.today.overdueTasks === 1 ? '' : 's'}, so tomorrow needs one concrete relief move.`
    : '';
  const window = snapshot.userState.nextBestFocusWindow
    ? ` Your next best focus window looks like <b>${escapeTelegramHtml(snapshot.userState.nextBestFocusWindow)}</b>.`
    : '';

  if (snapshot.moment.mode === 'recovery') {
    return `You're on day ${streak}. This is usually where streaks become fragile, and today looks lower-capacity.${commitment}${pressure}\n\nMake tomorrow smaller, not vaguer.${window} What is the first minimum viable block?`;
  }

  if (snapshot.moment.mode === 'deadline_pressure') {
    return `You're on day ${streak}, with deadline pressure in the system.${commitment}${pressure}\n\nTomorrow should protect the streak by removing one real bottleneck early.${window} What exactly starts first?`;
  }

  if (snapshot.moment.mode === 'protect_focus') {
    return `You're on day ${streak}, and the data says focus is available right now.${commitment}\n\nUse that signal to design tomorrow's first block before the day gets noisy.${window} What starts first?`;
  }

  return `You're on day ${streak}. Strong stretches usually need a specific next morning, not a general promise.${commitment}${pressure}\n\n${window}What is tomorrow's first focused block?`;
}

function composeOverrideFollowUpMessage(input: {
  domain: string;
  reason: string | null;
}): string {
  const snapshot = buildSchedulerSnapshot();
  const escapedDomain = escapeTelegramHtml(input.domain);
  const escapedReason = escapeTelegramHtml(input.reason || 'none');

  if (snapshot.moment.mode === 'protect_focus') {
    return `<b>Override check-in</b>\n\nYou opened <code>${escapedDomain}</code> during a focus-protection window.\nReason you gave: "${escapedReason}"\n\nDid it support the session, or did it pull you off-thread? Reply yes/no or what actually happened.`;
  }

  if (snapshot.moment.mode === 'deadline_pressure') {
    return `<b>Override check-in</b>\n\nYou opened <code>${escapedDomain}</code> while deadline pressure is active.\nReason you gave: "${escapedReason}"\n\nDid it move the work forward? Reply yes/no or what changed.`;
  }

  if (snapshot.feedback.alertFatigueLevel === 'high' || snapshot.moment.mode === 'recovery') {
    return `<b>Override check-in</b>\n\nQuick calibration on <code>${escapedDomain}</code>.\nReason you gave: "${escapedReason}"\n\nWorth keeping as an allowed exception next time, or should I be stricter?`;
  }

  return `<b>Override check-in</b>\n\nThe override for <code>${escapedDomain}</code> has had time to play out.\nReason you gave: "${escapedReason}"\n\nWas it worth it? Reply yes/no or what actually happened.`;
}

async function runAdaptiveSchedulerJob(name: string, fn: () => Promise<void>): Promise<boolean> {
  const snapshot = buildSchedulerSnapshot();
  const decision = decideAdaptiveJobRun(name, snapshot);
  if (!decision.run) {
    console.log(`[Scheduler] ${name} adaptive skip: ${decision.reason}`);
    return false;
  }
  console.log(`[Scheduler] ${name} adaptive run: ${decision.reason}`);
  await fn();
  return true;
}

function inferMorningTime(): string {
  try {
    const db = getDb();
    // started_at is Unix milliseconds — divide by 1000 for unixepoch conversion
    const row = db.prepare(`
      SELECT AVG(CAST(strftime('%H', datetime(started_at / 1000, 'unixepoch', 'localtime')) AS REAL)) as avg_hour,
             AVG(CAST(strftime('%M', datetime(started_at / 1000, 'unixepoch', 'localtime')) AS REAL)) as avg_min
      FROM guardian_sessions
      WHERE started_at >= (strftime('%s', 'now', '-14 days') * 1000)
      LIMIT 50
    `).get() as { avg_hour: number | null; avg_min: number | null } | undefined;
    if (row?.avg_hour != null) {
      // Clamp to reasonable morning window: 6 AM – 11 AM only
      const h = Math.max(6, Math.min(11, Math.round(row.avg_hour)));
      const m = Math.round(row.avg_min ?? 0);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
  } catch { /* non-fatal */ }
  return '08:00';
}

function inferEveningTime(): string {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT AVG(CAST(strftime('%H', completed_at) AS REAL)) as avg_hour
      FROM guardian_session_summaries
      WHERE completed_at >= datetime('now', '-14 days')
        AND CAST(strftime('%H', completed_at) AS REAL) >= 18
      LIMIT 30
    `).get() as { avg_hour: number | null } | undefined;
    if (row?.avg_hour != null) {
      const h = Math.max(20, Math.min(23, Math.round(row.avg_hour) - 1));
      return `${String(h).padStart(2, '0')}:30`;
    }
  } catch { /* non-fatal */ }
  return '21:30';
}

function timeToMinutes(value: string, sleepTime = false): number {
  const [h, m] = value.split(':').map(Number);
  const minutes = (h * 60) + m;
  return sleepTime && h < 12 ? minutes + 1440 : minutes;
}

function minutesToTime(minutes: number): string {
  const normalized = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function todayIst(): string {
  return new Date(Date.now() + 19800000).toISOString().slice(0, 10);
}

export function schedulerRunTimestamp(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString();
}

export function istDateForTimestamp(timestamp: string): string | null {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + 19800000).toISOString().slice(0, 10);
}

function tomorrowIst(): string {
  return new Date(Date.now() + 19800000 + 86400_000).toISOString().slice(0, 10);
}

function currentLocalMinutes(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

function isInsideMinuteWindow(nowMinutes: number, targetTime: string, windowMinutes: number): boolean {
  if (!/^\d{2}:\d{2}$/.test(targetTime)) return false;
  const target = timeToMinutes(targetTime);
  const delta = (nowMinutes - target + 1440) % 1440;
  return delta >= 0 && delta < windowMinutes;
}

function nextRunIsoForLocalTime(time: string): string {
  const now = new Date();
  const [h, m] = time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function inferEveningTimeFromSleep(): { time: string; reason: string } | null {
  try {
    const rows = getDb().prepare(`
      SELECT sleep_time
      FROM daily_checkins
      WHERE checkin_type = 'evening'
        AND sleep_time IS NOT NULL
      ORDER BY received_at DESC, id DESC
      LIMIT 7
    `).all() as Array<{ sleep_time: string | null }>;
    const sleepMinutes = rows
      .map(row => row.sleep_time)
      .filter((value): value is string => Boolean(value && /^\d{2}:\d{2}$/.test(value)))
      .map(value => timeToMinutes(value, true));
    if (sleepMinutes.length === 0) return null;

    const avgSleep = sleepMinutes.reduce((sum, value) => sum + value, 0) / sleepMinutes.length;
    const snapshot = buildSchedulerSnapshot();
    const leadMinutes = snapshot.moment.mode === 'planning'
      ? 75
      : snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low'
        ? 120
        : 90;
    const reflection = avgSleep - leadMinutes;
    const earliest = 19 * 60;
    const latest = 26 * 60 + 30; // allow 00:00-02:30 for genuinely late nights
    const clamped = Math.max(earliest, Math.min(latest, reflection));
    return {
      time: minutesToTime(clamped),
      reason: `derived ${leadMinutes}m before recent average sleep ${minutesToTime(avgSleep)}`,
    };
  } catch {
    return null;
  }
}

function configuredOrInferredTime(settingKey: string, seededDefault: string, infer: () => string): string {
  const configured = getSetting(settingKey).trim();
  if (configured && configured !== seededDefault) return configured;
  return infer();
}

function resolveEveningReflectionTime(): string {
  return resolveEveningReflectionTimeDetailed().time;
}

function resolveEveningReflectionTimeDetailed(): { time: string; reason: string } {
  const envTime = (process.env.EVENING_REFLECTION_TIME || '').trim();
  if (envTime) return { time: envTime, reason: 'using EVENING_REFLECTION_TIME override' };

  const sleepBased = inferEveningTimeFromSleep();
  if (sleepBased) {
    console.log(`[Scheduler] Evening reflection time ${sleepBased.time}: ${sleepBased.reason}`);
    return sleepBased;
  }

  const configured = getSetting('evening_reflection_time').trim();
  if (configured && configured !== '21:30') {
    return { time: configured, reason: 'using configured evening reflection time' };
  }

  const inferred = inferEveningTime();
  return {
    time: inferred,
    reason: inferred === '21:30'
      ? 'using adaptive baseline evening time'
      : 'using recent evening session endings',
  };
}

function resolveEveningReminderTime(): { time: string; reason: string } {
  const reflection = resolveEveningReflectionTimeDetailed();
  const snapshot = buildSchedulerSnapshot();
  const leadMinutes = snapshot.feedback.alertFatigueLevel === 'high'
    ? 8
    : snapshot.moment.mode === 'planning' || snapshot.today.openTasks > 0
      ? 25
      : snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low'
        ? 12
        : 15;

  return {
    time: minutesToTime(timeToMinutes(reflection.time, true) - leadMinutes),
    reason: `${leadMinutes}m before evening reflection; ${reflection.reason}; mode=${snapshot.moment.mode}, energy=${snapshot.userState.energy}, alerts=${snapshot.feedback.alertFatigueLevel}`,
  };
}

function resolveNextDayPlanRefreshTime(): { time: string; reason: string } {
  const reflection = resolveEveningReflectionTimeDetailed();
  const snapshot = buildSchedulerSnapshot();
  const delayMinutes = snapshot.moment.mode === 'planning'
    ? 8
    : snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low'
      ? 20
      : snapshot.feedback.alertFatigueLevel === 'high'
        ? 25
        : 12;

  return {
    time: minutesToTime(timeToMinutes(reflection.time, true) + delayMinutes),
    reason: `${delayMinutes}m after evening reflection; ${reflection.reason}; mode=${snapshot.moment.mode}, energy=${snapshot.userState.energy}, alerts=${snapshot.feedback.alertFatigueLevel}`,
  };
}

function resolveDailySummaryTime(): { time: string; reason: string } {
  const configured = getSetting('daily_summary_time').trim();
  if (configured && configured !== '23:00') {
    return { time: configured, reason: 'using configured daily summary time' };
  }

  const reflection = resolveEveningReflectionTimeDetailed();
  const snapshot = buildSchedulerSnapshot();
  const lagMinutes = snapshot.moment.mode === 'planning'
    ? 35
    : snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low'
      ? 50
      : snapshot.feedback.alertFatigueLevel === 'high'
        ? 60
        : 40;
  const target = clampMinutes(
    timeToMinutes(reflection.time, true) + lagMinutes,
    20 * 60,
    27 * 60,
  );

  return {
    time: minutesToTime(target),
    reason: `${lagMinutes}m after evening reflection ${reflection.time}; ${reflection.reason}; mode=${snapshot.moment.mode}, energy=${snapshot.userState.energy}, alerts=${snapshot.feedback.alertFatigueLevel}`,
  };
}

function resolveMorningCheckinWindow(): {
  wake: string;
  startMinutes: number;
  endMinutes: number;
  reason: string;
} {
  const wake = getWakeEstimate() ?? inferMorningTime();
  const snapshot = buildSchedulerSnapshot();
  const wakeMinutes = timeToMinutes(wake);
  const lowState = snapshot.userState.energy === 'low' || snapshot.userState.mood === 'low';
  const lateWake = wakeMinutes >= 10 * 60;
  const afterNoonWake = wakeMinutes >= 12 * 60;
  const windowLength = snapshot.feedback.alertFatigueLevel === 'high'
    ? 10
    : snapshot.moment.mode === 'recovery' || lowState
      ? 45
      : lateWake
        ? 30
        : 15;
  const latestMinutes = afterNoonWake
    ? 15 * 60
    : snapshot.moment.mode === 'recovery' || lowState || lateWake
      ? 14 * 60
      : 12 * 60;
  const endMinutes = Math.max(
    wakeMinutes + 1,
    Math.min(wakeMinutes + windowLength, latestMinutes),
  );

  return {
    wake,
    startMinutes: wakeMinutes,
    endMinutes,
    reason: `${windowLength}m morning window from wake ${wake}; mode=${snapshot.moment.mode}, energy=${snapshot.userState.energy}, mood=${snapshot.userState.mood ?? 'unknown'}, alerts=${snapshot.feedback.alertFatigueLevel}`,
  };
}

function clampMinutes(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveWakeRelativeTime(input: {
  jobName: string;
  offsetMinutes: number;
  earliestMinutes: number;
  latestMinutes: number;
}): { time: string; reason: string } {
  const wake = getWakeEstimate() ?? inferMorningTime();
  const snapshot = buildSchedulerSnapshot();
  const recoveryDelay = snapshot.moment.mode === 'recovery' ? 35 : 0;
  const alertDelay = snapshot.feedback.alertFatigueLevel === 'high' ? 15 : 0;
  const target = clampMinutes(
    timeToMinutes(wake) + input.offsetMinutes + recoveryDelay + alertDelay,
    input.earliestMinutes,
    input.latestMinutes,
  );
  return {
    time: minutesToTime(target),
    reason: `${input.jobName} scheduled from wake ${wake}; mode=${snapshot.moment.mode}, energy=${snapshot.userState.energy}, alerts=${snapshot.feedback.alertFatigueLevel}`,
  };
}

function resolveEveningRelativeTime(input: {
  jobName: string;
  leadMinutes: number;
  earliestMinutes: number;
  latestMinutes: number;
}): { time: string; reason: string } {
  const reflection = resolveEveningReflectionTimeDetailed();
  const snapshot = buildSchedulerSnapshot();
  const recoveryLead = snapshot.moment.mode === 'recovery' ? 25 : 0;
  const alertQuieting = snapshot.feedback.alertFatigueLevel === 'high' ? -15 : 0;
  const target = clampMinutes(
    timeToMinutes(reflection.time, true) - input.leadMinutes - recoveryLead - alertQuieting,
    input.earliestMinutes,
    input.latestMinutes,
  );
  return {
    time: minutesToTime(target),
    reason: `${input.jobName} scheduled before evening reflection ${reflection.time}; ${reflection.reason}; mode=${snapshot.moment.mode}, alerts=${snapshot.feedback.alertFatigueLevel}`,
  };
}

function registerAdaptiveDailyTimeJob(
  name: string,
  timing: { time: string; reason: string },
  fn: () => Promise<void>,
) {
  console.log(`[Scheduler] ${name} adaptive time ${timing.time}: ${timing.reason}`);
  registerDailyJob(name, timing.time, fn);
}

/**
 * Initialize the scheduler with all configured jobs.
 * Safe to call multiple times — will only initialize once.
 */
export function initScheduler(baseUrl: string = 'http://localhost:3000') {
    if (schedulerState.initialized) return;
    schedulerState.initialized = true;

    console.log('[Scheduler] Initializing LifeOS cron jobs...');

    // Morning brief — runs at a user override when present, otherwise learned from recent starts.
    const morningTime = configuredOrInferredTime('morning_brief_time', '08:00', inferMorningTime);
    registerDailyJob('morning_brief', morningTime, async () => {
        await fetchSchedulerEndpoint(`${baseUrl}/api/summary?type=morning`);
        // Also send morning brief to Telegram
        try {
            const db = getDb();
            const today = new Date().toISOString().slice(0, 10);
            const pending = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('todo','doing')").get() as { c: number }).c;
            const habits = (db.prepare("SELECT COUNT(*) as c FROM habits WHERE archived = 0").get() as { c: number }).c;
            const streak = (db.prepare("SELECT COALESCE(MAX(streak),0) as s FROM habits WHERE archived = 0").get() as { s: number }).s;
            const upcomingEvents = await listUpcomingEvents(12);
            const schedulerSnapshot = buildSchedulerSnapshot();

            // Time-of-day intelligence: find peak focus hours from last 14 days of sessions
            const hourlyData = db.prepare(`
                SELECT
                    CAST(strftime('%H', started_at, 'localtime') AS INTEGER) as hour,
                    AVG(average_focus_score) as avg_score,
                    COUNT(*) as session_count
                FROM guardian_session_summaries
                WHERE completed_at >= datetime('now', '-14 days')
                GROUP BY hour
                ORDER BY avg_score DESC
                LIMIT 3
            `).all() as { hour: number; avg_score: number; session_count: number }[];

            const peakHoursLine = hourlyData.length >= 2
                ? `⚡ <b>Peak focus hours:</b> ${hourlyData.map(h => `${h.hour}:00`).join(', ')}`
                : null;

            await sendTelegram(formatMorningBrief({
                date: today,
                pendingTasks: pending,
                habitsToday: habits,
                upcomingEvents: upcomingEvents.map(e => {
                    const t = new Date(e.start).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
                    return `${t} ${e.title}`;
                }),
                streak,
                peakHoursLine,
                adaptiveLine: formatSchedulerMomentLine(schedulerSnapshot),
            }), 'HTML', MORNING_BRIEF_KEYBOARD);
        } catch (err) {
            console.error('[Scheduler] Telegram morning brief failed:', err);
        }
    });

    // Daily summary — follows the adaptive evening reflection instead of a fixed clock time.
    registerAdaptiveDailyTimeJob('daily_summary', resolveDailySummaryTime(), async () => {
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        await fetchSchedulerEndpoint(`${baseUrl}/api/summary?type=daily&date=${today}`);
        // Also send daily report to Telegram
        try {
            const db = getDb();
            const stats = db.prepare(`
                SELECT
                    COALESCE(SUM(CASE WHEN category='productive' THEN duration_seconds END),0) as prod,
                    COALESCE(SUM(CASE WHEN category='distraction' THEN duration_seconds END),0) as dist
                FROM effective_activities WHERE date(started_at,'localtime') = ?
            `).get(today) as { prod: number; dist: number };
            const tasks = db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) as done FROM tasks WHERE date(created_at,'localtime') <= ? AND status IN ('todo','doing','done')").get(today) as { total: number; done: number };
            const habits = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN hc.completed=1 THEN 1 ELSE 0 END) as done FROM habits h LEFT JOIN habit_checkins hc ON hc.habit_id=h.id AND hc.date=? WHERE h.archived=0`).get(today) as { total: number; done: number };
            const sessions = (db.prepare("SELECT COUNT(*) as c FROM guardian_session_summaries WHERE date(completed_at,'localtime') = ?").get(today) as { c: number }).c;
            const score = db.prepare("SELECT COALESCE(AVG(score),0) as s FROM daily_scores WHERE date = ?").get(today) as { s: number } | undefined;
            await sendTelegram(formatDailyReport({
                date: today,
                productiveMinutes: Math.round((stats?.prod ?? 0) / 60),
                distractionMinutes: Math.round((stats?.dist ?? 0) / 60),
                tasksCompleted: tasks?.done ?? 0,
                totalTasks: tasks?.total ?? 0,
                habitsCompleted: habits?.done ?? 0,
                totalHabits: habits?.total ?? 0,
                score: Math.round(score?.s ?? 0),
                xp: 0,
                sessionsToday: sessions,
            }), 'HTML', DAILY_REPORT_KEYBOARD);
        } catch (err) {
            console.error('[Scheduler] Telegram daily report failed:', err);
        }
    });

    // Deep analysis — runs daily at 23:30
    registerDailyJob('deep_analysis', '23:30', async () => {
        await runAdaptiveSchedulerJob('deep_analysis', async () => {
          await fetchSchedulerEndpoint(`${baseUrl}/api/behavior`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
        });
    });

    // Monthly deep correlation — runs on the 1st of every month at 01:00
    registerDailyJob('monthly_correlation', '01:00', async () => {
        const today = new Date();
        if (today.getDate() === 1) { // Only run on the 1st of the month
            await fetchSchedulerEndpoint(`${baseUrl}/api/analytics/insights`, { method: 'POST' });
        }
    });

    // GitHub sync — runs every 2 hours if PAT is configured
    registerIntervalJob('github_sync', 2 * 60 * 60 * 1000, async () => {
        const pat = getSetting('github_pat');
        if (!pat) return;
        await fetchSchedulerEndpoint(`${baseUrl}/api/github`, { method: 'POST' });
    });

    // Calendar sync — runs every 4 hours if ICS URL is configured
    registerIntervalJob('calendar_sync', 4 * 60 * 60 * 1000, async () => {
        const icsUrl = getSetting('calendar_ics_url');
        if (!icsUrl) return;
        await fetchSchedulerEndpoint(`${baseUrl}/api/calendar`, { method: 'POST' });
    });

    // Screen time collection — runs every 30 minutes
    registerIntervalJob('screen_time', 30 * 60 * 1000, async () => {
        await fetchSchedulerEndpoint(`${baseUrl}/api/screentime`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
    });

    // Alert engine — runs every 5 minutes, checks for triggers
    registerIntervalJob('alert_engine', 5 * 60 * 1000, async () => {
        await runAdaptiveSchedulerJob('alert_engine', async () => {
            await fetchSchedulerEndpoint(`${baseUrl}/api/alerts/engine`, { method: 'POST' });
        });
    });

    // UIL synthesis — runs every 2 hours during active day to keep profile fresh
    registerIntervalJob('uil_synthesis', 2 * 60 * 60 * 1000, async () => {
        await runAdaptiveSchedulerJob('uil_synthesis', async () => {
            console.log('[Scheduler] Running UIL background synthesis...');
            await forceSynthesis('scheduled_2h');
        });
    });

    // Screenshot pipeline — DISABLED.
    // Mac Mini is a headless server — its screen is always an idle terminal.
    // All screen capture is handled by the MacBook vision client via /api/guardian/vision.
    // registerIntervalJob('screenshot_pipeline', 60 * 1000, async () => {
    //     const session = getActiveGuardianSession();
    //     if (!session) return;
    //     if (isMacbookClientConnected()) return;
    //     await captureAndAnalyze();
    // });

    // Continuity guardian — every 30 minutes
    registerIntervalJob('continuity_guardian', 30 * 60 * 1000, async () => {
        await runAdaptiveSchedulerJob('continuity_guardian', async () => {
            await runContinuityCheck();
        });
    });

    // Achievement engine - runs every 10 minutes
    registerIntervalJob('achievement_engine', 10 * 60 * 1000, async () => {
        await fetchSchedulerEndpoint(`${baseUrl}/api/gamification/engine`, { method: 'POST' });
    });

    // Weekly review — Sunday evening, aligned to the current evening reflection window.
    registerAdaptiveDailyTimeJob('weekly_review', resolveEveningRelativeTime({
        jobName: 'weekly review',
        leadMinutes: 45,
        earliestMinutes: 18 * 60 + 30,
        latestMinutes: 22 * 60 + 30,
    }), async () => {
        const dayOfWeek = new Date().getDay();
        if (dayOfWeek === 0) { // Sunday
            await fetchSchedulerEndpoint(`${baseUrl}/api/weekly`, { method: 'POST' });
            // Also send rich weekly HTML email
            try {
                const { sendWeeklyEmail } = await import('./notifications');
                await sendWeeklyEmail();
            } catch (err) {
                console.error('[Scheduler] Weekly email failed:', err);
            }
        }
    });

    // Stuck task detection — runs nightly at 23:50
    // Flags tasks in doing/today that haven't had a guardian session in 3+ days
    registerDailyJob('stuck_task_detection', '23:50', async () => {
        try {
            const { getDb } = await import('./db');
            const db = getDb();
            const threeDaysAgo = new Date(Date.now() - 3 * 86400_000).toISOString();

            // Tasks active for 3+ days without being marked done
            const stuckTasks = db.prepare(`
                SELECT t.id, t.title
                FROM tasks t
                WHERE t.status IN ('doing', 'todo')
                  AND t.blocked_since IS NULL
                  AND t.created_at < ?
            `).all(threeDaysAgo) as { id: number; title: string }[];

            if (stuckTasks.length > 0) {
                const now = new Date().toISOString();
                const update = db.prepare(`UPDATE tasks SET blocked_since = ? WHERE id = ?`);
                const updateMany = db.transaction((tasks: typeof stuckTasks) => {
                    for (const t of tasks) update.run(now, t.id);
                });
                updateMany(stuckTasks);
                console.log(`[Scheduler] stuck_task_detection: flagged ${stuckTasks.length} tasks — ${stuckTasks.map(t => t.title).join(', ')}`);
            } else {
                console.log('[Scheduler] stuck_task_detection: no stuck tasks');
            }
        } catch (err) {
            console.error('[Scheduler] stuck_task_detection failed:', err);
        }
    });

    // Goal health — runs nightly at 23:45, updates velocity + health_status for all active goals
    registerDailyJob('goal_health', '23:45', async () => {
        const { updateGoalHealth } = await import('./goal-health');
        const result = updateGoalHealth();
        console.log(`[Scheduler] goal_health: updated ${result.updated} goals`);
        if (result.summary.length > 0) {
            console.log('[Scheduler] goal_health issues:', result.summary.join('; '));
        }
    });

    // Next-day plan refresh — regenerates tomorrow's focus blocks after the adaptive evening reflection window.
    registerAdaptiveNextDayPlanRefreshJob(async () => {
        return runAdaptiveSchedulerJob('next_day_plan_refresh', async () => {
            const { generateNextDayPlan } = await import('./next-day-planner');
            const planDate = tomorrowIst();
            const plan = await generateNextDayPlan({
                planDate,
                syncCalendar: true,
                regenerate: true,
            });
            console.log(`[Scheduler] next_day_plan_refresh: generated ${plan.sessions.length} focus block(s) for ${planDate}`);
        });
    });

    // Memory consolidation — runs nightly at 02:30 (merge duplicates, purge stale)
    registerDailyJob('memory_consolidation', '02:30', async () => {
        await consolidateFacts();
    });

    // Daily morning check-in — fires in an adaptive window after the user's wake estimate.
    // Wake estimate comes from yesterday's evening check-in. Fallback uses learned morning timing.
    // Uses a polling approach: every minute we check if we're in the wake window.
    registerIntervalJob('morning_checkin', 60 * 1000, async () => {
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const morningWindow = resolveMorningCheckinWindow();

        // Only fire inside the window
        if (nowMinutes < morningWindow.startMinutes || nowMinutes >= morningWindow.endMinutes) return;

        // Deduplicate: sendMorningCheckin() already checks if already sent today
        console.log(`[Scheduler] morning_checkin window: ${morningWindow.reason}`);
        await runAdaptiveSchedulerJob('morning_checkin', async () => {
            await sendMorningCheckin();
        });
    });

    // Evening reflection — user override or learned evening time from recent session endings.
    // Reminder timing is re-resolved every minute so late nights and new sleep plans affect today.
    const eveningTime = resolveEveningReflectionTime();
    registerAdaptiveEveningReminderJob(async () => {
        await runAdaptiveSchedulerJob('evening_reminder', async () => {
            const reminder = composeEveningPlanningReminder();
            if (!reminder.shouldSend) {
                console.log(`[Scheduler] evening_reminder adaptive skip: ${reminder.reason}`);
                return;
            }
            await sendTelegram(`${reminder.message}\n\n<i>${reminder.reason}</i>`, 'HTML');
        });
    });

    registerDailyJob('evening_reflection', eveningTime, async () => {
        await sendEveningReflection();
    });

    // Nightly Database Backup — runs every day at 03:00
    registerDailyJob('db_backup', '03:00', async () => {
        await fetchSchedulerEndpoint(`${baseUrl}/api/cron?action=backup`, { method: 'POST' });
    });

    // Log rotation — runs nightly at 04:00, keeps logs under 10 MB each
    registerDailyJob('log_rotation', '04:00', async () => {
        const fs = await import('fs');
        const path = await import('path');

        const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per log file
        const logsDir = path.join(process.cwd(), 'logs');

        let rotated = 0;
        let skipped = 0;

        try {
            if (!fs.existsSync(logsDir)) {
                console.log('[Scheduler] log_rotation: logs/ directory not found, skipping');
                return;
            }

            const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
            for (const file of files) {
                const filePath = path.join(logsDir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.size <= MAX_BYTES) { skipped++; continue; }

                    // Read, trim to last MAX_BYTES worth of content (keep newest lines)
                    const content = fs.readFileSync(filePath, 'utf8');
                    const trimmed = content.slice(-MAX_BYTES);
                    // Align to the next newline so we don't start mid-line
                    const firstNewline = trimmed.indexOf('\n');
                    const clean = firstNewline >= 0 ? trimmed.slice(firstNewline + 1) : trimmed;
                    fs.writeFileSync(filePath, clean, 'utf8');
                    rotated++;
                    console.log(`[Scheduler] log_rotation: trimmed ${file} from ${Math.round(stat.size / 1024)}KB to ${Math.round(clean.length / 1024)}KB`);
                } catch (fileErr) {
                    console.error(`[Scheduler] log_rotation: failed on ${file}:`, fileErr);
                }
            }
            console.log(`[Scheduler] log_rotation: done — ${rotated} rotated, ${skipped} under limit`);
        } catch (err) {
            console.error('[Scheduler] log_rotation failed:', err);
        }
    });


    // Guardian policy optimization — runs nightly at 03:30, off hot path, skipped during active sessions
    registerDailyJob('guardian_optimize', '03:30', async () => {
        const res = await fetchSchedulerEndpoint(`${baseUrl}/api/guardian/optimize`, { method: 'POST' });
        if (res.status === 409) {
            console.log('[Scheduler] guardian_optimize skipped — active session in progress');
        } else if (!res.ok) {
            console.error('[Scheduler] guardian_optimize failed:', await res.text());
        }
    });

    // Weekly Data Archiving (Lossless Compression) - runs every Sunday at 02:00
    registerDailyJob('data_archiving', '02:00', async () => {
        const dayOfWeek = new Date().getDay();
        if (dayOfWeek === 0) { // Sunday
            await fetchSchedulerEndpoint(`${baseUrl}/api/cron?action=archive`, { method: 'POST' });
        }
    });

    // Override follow-up poll — every 5 minutes
    registerIntervalJob('override_followup_poll', 5 * 60 * 1000, async () => {
        const db = getDb();
        const now = new Date().toISOString();
        // Only send follow-ups scheduled within the last 2 hours — anything older is stale
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const pending = db.prepare(`
            SELECT * FROM override_follow_ups
            WHERE sent = 0 AND follow_up_at <= ?
            ORDER BY follow_up_at ASC
            LIMIT 5
        `).all(now) as Array<{
            id: number;
            session_id: string;
            override_url: string;
            override_reason: string;
            follow_up_at: string;
        }>;

        for (const f of pending) {
            // Skip stale follow-ups silently — just mark sent so they don't reappear
            if (f.follow_up_at < twoHoursAgo) {
                db.prepare(`UPDATE override_follow_ups SET sent = 1, sent_at = ? WHERE id = ?`)
                  .run(new Date().toISOString(), f.id);
                console.log(`[Scheduler] Discarding stale override follow-up id=${f.id} (scheduled ${f.follow_up_at})`);
                continue;
            }
            try {
                const domain = new URL(f.override_url).hostname.replace('www.', '');
                await sendTelegram(
                    composeOverrideFollowUpMessage({ domain, reason: f.override_reason }),
                    'HTML'
                );
                db.prepare(`UPDATE override_follow_ups SET sent = 1, sent_at = ? WHERE id = ?`)
                  .run(new Date().toISOString(), f.id);
            } catch (err) {
                console.error('[Scheduler] override_followup_poll failed for id', f.id, err);
            }
        }
    });

    // Morning UIL synthesis — before the learned/declared wake pickup window.
    registerAdaptiveDailyTimeJob('morning_uil_synthesis', resolveWakeRelativeTime({
        jobName: 'morning UIL synthesis',
        offsetMinutes: -20,
        earliestMinutes: 5 * 60 + 45,
        latestMinutes: 10 * 60 + 30,
    }), async () => {
        try {
            // Trigger intelligence synthesis if function exists
            const { forceSynthesis } = await import('./intelligence');
            if (typeof forceSynthesis === 'function') {
                await forceSynthesis('morning_adaptive');
            }
            console.log('[Scheduler] Morning UIL synthesis complete');
        } catch (err) {
            console.error('[Scheduler] morning_uil_synthesis failed:', err);
        }
    });

    // Streak cliff detection — day 4 of strong streak, before evening reflection.
    registerAdaptiveDailyTimeJob('streak_cliff_detection', resolveEveningRelativeTime({
        jobName: 'streak cliff detection',
        leadMinutes: 75,
        earliestMinutes: 18 * 60 + 30,
        latestMinutes: 22 * 60,
    }), async () => {
        try {
            const db = getDb();

            const sessionDays = db.prepare(`
                SELECT DISTINCT date(completed_at) as day
                FROM guardian_session_summaries
                WHERE completed_at >= datetime('now', '-7 days')
                ORDER BY day DESC
            `).all() as Array<{ day: string }>;

            let streak = 0;
            for (let i = 0; i < sessionDays.length; i++) {
                const expected = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
                if (sessionDays[i]?.day === expected) {
                    streak++;
                } else {
                    break;
                }
            }

            if (streak === 4) {
                const today = new Date().toISOString().slice(0, 10);
                const alreadySent = getSetting('streak_cliff_sent_date') === today;
                if (!alreadySent) {
                    await sendTelegram(
                        composeStreakCliffMessage(streak),
                        'HTML'
                    );
                    setSetting('streak_cliff_sent_date', today);
                }
            }
        } catch (err) {
            console.error('[Scheduler] streak_cliff_detection failed:', err);
        }
    });

    // Weekly reckoning — Sunday evening, before the weekly review.
    registerAdaptiveDailyTimeJob('weekly_reckoning', resolveEveningRelativeTime({
        jobName: 'weekly reckoning',
        leadMinutes: 90,
        earliestMinutes: 18 * 60,
        latestMinutes: 22 * 60,
    }), async () => {
        const dayOfWeek = new Date().getDay(); // 0 = Sunday
        if (dayOfWeek !== 0) return;
        await sendWeeklyReckoning();
    });

    // Weekly open loops audit — Monday morning after the wake window settles.
    registerAdaptiveDailyTimeJob('open_loops_audit', resolveWakeRelativeTime({
        jobName: 'open loops audit',
        offsetMinutes: 75,
        earliestMinutes: 7 * 60,
        latestMinutes: 12 * 60,
    }), async () => {
        const dayOfWeek = new Date().getDay(); // 1 = Monday
        if (dayOfWeek !== 1) return;
        await sendOpenLoopsAudit();
    });

    // Monthly pattern letter — first evening of the month, tied to reflection timing.
    registerAdaptiveDailyTimeJob('monthly_pattern_letter', resolveEveningRelativeTime({
        jobName: 'monthly pattern letter',
        leadMinutes: 120,
        earliestMinutes: 18 * 60,
        latestMinutes: 22 * 60,
    }), async () => {
        const dayOfMonth = new Date().getDate();
        if (dayOfMonth !== 1) return;
        await sendMonthlyPatternLetter();
    });

    console.log(`[Scheduler] ${jobs.size} jobs registered`);
}

/**
 * Register a job that runs once daily at a specific time (HH:MM).
 */
function registerDailyJob(name: string, time: string, fn: () => Promise<void>) {
    const job: ScheduledJob = {
        name,
        schedule: `daily at ${time}`,
        lastRun: null,
        nextRun: getNextRunTime(time),
        enabled: true,
        running: false,
    };
    jobs.set(name, job);

    // Check every minute if it's time to run
    const timer = setInterval(async () => {
        const now = new Date();
        const [h, m] = time.split(':').map(Number);

        if (now.getHours() === h && now.getMinutes() === m && !job.running) {
            // Only run once per day
            const today = todayIst();
            if (job.lastRun && istDateForTimestamp(job.lastRun) === today) return;

            job.running = true;
            console.log(`[Scheduler] Running ${name}...`);
            try {
                await fn();
                job.lastRun = schedulerRunTimestamp();
                job.nextRun = getNextRunTime(time);
                console.log(`[Scheduler] ${name} completed`);
            } catch (err) {
                console.error(`[Scheduler] ${name} failed:`, err);
            }
            job.running = false;
        }
    }, 60 * 1000); // Check every minute

    timers.set(name, timer);
}

/**
 * Register the evening planning reminder as a dynamic daily window.
 * Unlike fixed daily jobs, this recalculates against latest sleep/reflection signals
 * every minute so same-day changes can move the reminder.
 */
function registerAdaptiveEveningReminderJob(fn: () => Promise<void>) {
    const name = 'evening_reminder';
    const initial = resolveEveningReminderTime();
    const sentKey = 'scheduler_evening_reminder_last_sent_date';
    const job: ScheduledJob = {
        name,
        schedule: `adaptive daily near ${initial.time}`,
        lastRun: null,
        nextRun: nextRunIsoForLocalTime(initial.time),
        enabled: true,
        running: false,
    };
    jobs.set(name, job);

    const timer = setInterval(async () => {
        if (job.running) return;
        const target = resolveEveningReminderTime();
        job.schedule = `adaptive daily near ${target.time}`;
        job.nextRun = nextRunIsoForLocalTime(target.time);

        if (!isInsideMinuteWindow(currentLocalMinutes(), target.time, 2)) return;

        const today = todayIst();
        if (getSetting(sentKey) === today) return;

        job.running = true;
        console.log(`[Scheduler] Running ${name} at adaptive target ${target.time}: ${target.reason}`);
        try {
            await fn();
            setSetting(sentKey, today);
            job.lastRun = schedulerRunTimestamp();
            job.nextRun = nextRunIsoForLocalTime(target.time);
            console.log(`[Scheduler] ${name} completed`);
        } catch (err) {
            console.error(`[Scheduler] ${name} failed:`, err);
        }
        job.running = false;
    }, 60 * 1000);

    timers.set(name, timer);
}

/**
 * Refresh tomorrow's plan after evening reflection using the latest sleep, mood,
 * intention, calendar, feedback, and task-time state.
 */
function registerAdaptiveNextDayPlanRefreshJob(fn: () => Promise<boolean>) {
    const name = 'next_day_plan_refresh';
    const initial = resolveNextDayPlanRefreshTime();
    const sentKey = 'scheduler_next_day_plan_refresh_last_sent_date';
    const job: ScheduledJob = {
        name,
        schedule: `adaptive daily near ${initial.time}`,
        lastRun: null,
        nextRun: nextRunIsoForLocalTime(initial.time),
        enabled: true,
        running: false,
    };
    jobs.set(name, job);

    const timer = setInterval(async () => {
        if (job.running) return;
        const target = resolveNextDayPlanRefreshTime();
        job.schedule = `adaptive daily near ${target.time}`;
        job.nextRun = nextRunIsoForLocalTime(target.time);

        if (!isInsideMinuteWindow(currentLocalMinutes(), target.time, 2)) return;

        const today = todayIst();
        if (getSetting(sentKey) === today) return;

        job.running = true;
        console.log(`[Scheduler] Running ${name} at adaptive target ${target.time}: ${target.reason}`);
        try {
            const didRun = await fn();
            if (didRun) {
                setSetting(sentKey, today);
                job.lastRun = schedulerRunTimestamp();
                job.nextRun = nextRunIsoForLocalTime(target.time);
                console.log(`[Scheduler] ${name} completed`);
            }
        } catch (err) {
            console.error(`[Scheduler] ${name} failed:`, err);
        }
        job.running = false;
    }, 60 * 1000);

    timers.set(name, timer);
}

/**
 * Register a job that runs at a fixed interval.
 */
function registerIntervalJob(name: string, intervalMs: number, fn: () => Promise<void>) {
    const hours = Math.round(intervalMs / (60 * 60 * 1000));
    const minutes = Math.round(intervalMs / (60 * 1000));
    const scheduleStr = hours >= 1 ? `every ${hours}h` : `every ${minutes}m`;

    const job: ScheduledJob = {
        name,
        schedule: scheduleStr,
        lastRun: null,
        nextRun: new Date(Date.now() + intervalMs).toISOString(),
        enabled: true,
        running: false,
    };
    jobs.set(name, job);

    // Run once at startup (after 10 seconds to let server warm up)
    setTimeout(async () => {
        if (!job.running) {
            job.running = true;
            try {
                await fn();
                job.lastRun = schedulerRunTimestamp();
            } catch (err) {
                console.error(`[Scheduler] ${name} initial run failed:`, err);
            }
            job.running = false;
        }
    }, 10000);

    const timer = setInterval(async () => {
        if (job.running) return;
        job.running = true;
        console.log(`[Scheduler] Running ${name}...`);
        try {
            await fn();
            job.lastRun = schedulerRunTimestamp();
            job.nextRun = new Date(Date.now() + intervalMs).toISOString();
            console.log(`[Scheduler] ${name} completed`);
        } catch (err) {
            console.error(`[Scheduler] ${name} failed:`, err);
        }
        job.running = false;
    }, intervalMs);

    timers.set(name, timer);
}

/**
 * Calculate next run time for a daily job at HH:MM.
 */
function getNextRunTime(time: string): string {
    const [h, m] = time.split(':').map(Number);
    const next = new Date();
    next.setHours(h, m, 0, 0);
    if (next.getTime() <= Date.now()) {
        next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
}

/**
 * Manually trigger a specific job.
 */
export async function triggerJob(name: string, baseUrl: string = 'http://localhost:3000'): Promise<{ success: boolean; error?: string }> {
    const job = jobs.get(name);
    if (!job) return { success: false, error: `Job '${name}' not found` };
    if (job.running) return { success: false, error: `Job '${name}' is already running` };

    // Trigger the appropriate endpoint
    try {
        switch (name) {
            case 'morning_brief':
                await fetchSchedulerEndpoint(`${baseUrl}/api/summary?type=morning`);
                break;
            case 'daily_summary':
                await fetchSchedulerEndpoint(`${baseUrl}/api/summary?type=daily&date=${new Date(Date.now() + 19800000).toISOString().slice(0, 10)}`);
                break;
            case 'deep_analysis':
                await fetchSchedulerEndpoint(`${baseUrl}/api/behavior`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                break;
            case 'github_sync':
                await fetchSchedulerEndpoint(`${baseUrl}/api/github`, { method: 'POST' });
                break;
            case 'calendar_sync':
                await fetchSchedulerEndpoint(`${baseUrl}/api/calendar`, { method: 'POST' });
                break;
            case 'screen_time':
                await fetchSchedulerEndpoint(`${baseUrl}/api/screentime`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                break;
            case 'alert_engine':
                await fetchSchedulerEndpoint(`${baseUrl}/api/alerts/engine`, { method: 'POST' });
                break;
            case 'weekly_review':
                await fetchSchedulerEndpoint(`${baseUrl}/api/weekly`, { method: 'POST' });
                break;
            default:
                return { success: false, error: `Unknown job: ${name}` };
        }
        job.lastRun = schedulerRunTimestamp();
        return { success: true };
    } catch (err) {
        return { success: false, error: String(err) };
    }
}

/**
 * Get status of all scheduled jobs.
 */
export function getSchedulerStatus(): {
    initialized: boolean;
    jobs: ScheduledJob[];
} {
    return {
        initialized: schedulerState.initialized,
        jobs: Array.from(jobs.values()),
    };
}
