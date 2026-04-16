import { getSetting, setSetting, getDb } from './db';
import {
  sendTelegram,
  formatDailyReport,
  formatMorningBrief,
  MORNING_BRIEF_KEYBOARD,
  DAILY_REPORT_KEYBOARD,
} from './telegram';
import { listUpcomingEvents } from './google-calendar';
import { forceSynthesis, getIntelligenceContext } from './intelligence';
import { consolidateFacts } from './memory-extractor';
import { sendMorningCheckin, sendEveningReflection, getWakeEstimate } from './checkin';
import { captureAndAnalyze } from './screenshot-pipeline';
import { isMacbookClientConnected } from './screen-vision';
import { getActiveGuardianSession } from './guardian-runtime';
import { runContinuityCheck } from './continuity-guardian';
import { sendWeeklyReckoning } from './weekly-reckoning';
import { sendOpenLoopsAudit, sendMonthlyPatternLetter } from './open-loops';
import { getAdaptiveBands } from './adaptive-bands';

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

const jobs: Map<string, ScheduledJob> = new Map();
const timers: Map<string, ReturnType<typeof setInterval>> = new Map();
let initialized = false;

function inferMorningTime(): string {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT AVG(strftime('%H', started_at)) as avg_hour,
             AVG(CAST(strftime('%M', started_at) AS REAL)) as avg_min
      FROM guardian_sessions
      WHERE started_at >= datetime('now', '-14 days')
      LIMIT 50
    `).get() as { avg_hour: number | null; avg_min: number | null } | undefined;
    if (row?.avg_hour != null) {
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

/**
 * Initialize the scheduler with all configured jobs.
 * Safe to call multiple times — will only initialize once.
 */
export function initScheduler(baseUrl: string = 'http://localhost:3000') {
    if (initialized) return;
    initialized = true;

    console.log('[Scheduler] Initializing LifeOS cron jobs...');

    // Morning brief — runs every day at configured time (or learned from user's patterns)
    const morningTimeSetting = getSetting('morning_brief_time');
    const morningTime = morningTimeSetting || inferMorningTime();
    registerDailyJob('morning_brief', morningTime, async () => {
        await fetch(`${baseUrl}/api/summary?type=morning`);
        // Also send morning brief to Telegram
        try {
            const db = getDb();
            const today = new Date().toISOString().slice(0, 10);
            const pending = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('todo','doing')").get() as { c: number }).c;
            const habits = (db.prepare("SELECT COUNT(*) as c FROM habits WHERE archived = 0").get() as { c: number }).c;
            const streak = (db.prepare("SELECT COALESCE(MAX(streak),0) as s FROM habits WHERE archived = 0").get() as { s: number }).s;
            const upcomingEvents = await listUpcomingEvents(12);

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
            }), 'HTML', MORNING_BRIEF_KEYBOARD);
        } catch (err) {
            console.error('[Scheduler] Telegram morning brief failed:', err);
        }
    });

    // Daily summary — runs every day at configured time
    const summaryTimeSetting = getSetting('daily_summary_time');
    const summaryTime = summaryTimeSetting || inferEveningTime();
    registerDailyJob('daily_summary', summaryTime, async () => {
        const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
        await fetch(`${baseUrl}/api/summary?type=daily&date=${today}`);
        // Also send daily report to Telegram
        try {
            const db = getDb();
            const stats = db.prepare(`
                SELECT
                    COALESCE(SUM(CASE WHEN category='productive' THEN duration_seconds END),0) as prod,
                    COALESCE(SUM(CASE WHEN category='distraction' THEN duration_seconds END),0) as dist
                FROM activities WHERE date(started_at,'localtime') = ?
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
        await fetch(`${baseUrl}/api/behavior`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
    });

    // Monthly deep correlation — runs on the 1st of every month at 01:00
    registerDailyJob('monthly_correlation', '01:00', async () => {
        const today = new Date();
        if (today.getDate() === 1) { // Only run on the 1st of the month
            await fetch(`${baseUrl}/api/analytics/insights`, { method: 'POST' });
        }
    });

    // GitHub sync — runs every 2 hours if PAT is configured
    registerIntervalJob('github_sync', 2 * 60 * 60 * 1000, async () => {
        const pat = getSetting('github_pat');
        if (!pat) return;
        await fetch(`${baseUrl}/api/github`, { method: 'POST' });
    });

    // Calendar sync — runs every 4 hours if ICS URL is configured
    registerIntervalJob('calendar_sync', 4 * 60 * 60 * 1000, async () => {
        const icsUrl = getSetting('calendar_ics_url');
        if (!icsUrl) return;
        await fetch(`${baseUrl}/api/calendar`, { method: 'POST' });
    });

    // Screen time collection — runs every 30 minutes
    registerIntervalJob('screen_time', 30 * 60 * 1000, async () => {
        await fetch(`${baseUrl}/api/screentime`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
    });

    // Alert engine — runs every 5 minutes, checks for triggers
    registerIntervalJob('alert_engine', 5 * 60 * 1000, async () => {
        await fetch(`${baseUrl}/api/alerts/engine`, { method: 'POST' });
    });

    // UIL synthesis — runs every 2 hours during active day to keep profile fresh
    registerIntervalJob('uil_synthesis', 2 * 60 * 60 * 1000, async () => {
        console.log('[Scheduler] Running UIL background synthesis...');
        await forceSynthesis('scheduled_2h');
    });

    // Screenshot pipeline — Mac Mini fallback only.
    // Fires every 60 seconds but only runs if:
    //   1. A guardian session is ACTIVE (no capture when idle)
    //   2. The MacBook client is NOT connected (if connected, it handles capture)
    registerIntervalJob('screenshot_pipeline', 60 * 1000, async () => {
        const session = getActiveGuardianSession();
        if (!session) return; // no active session — stay silent
        if (isMacbookClientConnected()) return; // MacBook client is handling capture
        await captureAndAnalyze();
    });

    // Continuity guardian — every 30 minutes
    registerIntervalJob('continuity_guardian', 30 * 60 * 1000, async () => {
        await runContinuityCheck();
    });

    // Achievement engine - runs every 10 minutes
    registerIntervalJob('achievement_engine', 10 * 60 * 1000, async () => {
        await fetch(`${baseUrl}/api/gamification/engine`, { method: 'POST' });
    });

    // Weekly review — runs every Sunday at 21:00
    registerDailyJob('weekly_review', '21:00', async () => {
        const dayOfWeek = new Date().getDay();
        if (dayOfWeek === 0) { // Sunday
            await fetch(`${baseUrl}/api/weekly`, { method: 'POST' });
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

    // Weekly plan refresh — regenerate every Monday at 00:05 using latest weights and goal health
    registerDailyJob('weekly_plan_refresh', '00:05', async () => {
        const day = new Date().getDay(); // 0=Sun, 1=Mon
        if (day !== 1) return; // only on Mondays
        try {
            const { generateWeeklyPlan, saveWeeklyPlan } = await import('./weekly-planner');
            saveWeeklyPlan(generateWeeklyPlan());
            console.log('[Scheduler] weekly_plan_refresh: plan generated for new week');
        } catch (err) {
            console.error('[Scheduler] weekly_plan_refresh failed:', err);
        }
    });

    // Memory consolidation — runs nightly at 02:30 (merge duplicates, purge stale)
    registerDailyJob('memory_consolidation', '02:30', async () => {
        await consolidateFacts();
    });

    // Daily morning check-in — fires within 15 minutes of the user's wake estimate
    // Wake estimate comes from yesterday's evening check-in. Fallback: 08:00.
    // Uses a polling approach: every minute we check if we're in the wake window.
    registerIntervalJob('morning_checkin', 60 * 1000, async () => {
        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        // Determine target window
        const wakeEstimate = getWakeEstimate();
        let windowStart: number;
        if (wakeEstimate) {
            const [wh, wm] = wakeEstimate.split(':').map(Number);
            windowStart = wh * 60 + wm;
        } else {
            const [bh, bm] = inferMorningTime().split(':').map(Number);
            windowStart = bh * 60 + bm;
        }
        const windowEnd = windowStart + 15;

        // Only fire inside the window
        if (nowMinutes < windowStart || nowMinutes >= windowEnd) return;

        // Deduplicate: sendMorningCheckin() already checks if already sent today
        await sendMorningCheckin();
    });

    // Evening reflection — configurable via EVENING_REFLECTION_TIME (default 21:30)
    // Also fires a 15-minute advance reminder to prompt the user to start thinking
    const eveningTime = (process.env.EVENING_REFLECTION_TIME || '21:30').trim();
    const [eveningHour, eveningMin] = eveningTime.split(':').map(Number);
    const reminderMin = eveningMin - 15 < 0 ? eveningMin + 45 : eveningMin - 15;
    const reminderHour = eveningMin - 15 < 0 ? eveningHour - 1 : eveningHour;
    const reminderTime = `${String(reminderHour).padStart(2, '0')}:${String(reminderMin).padStart(2, '0')}`;

    registerDailyJob('evening_reminder', reminderTime, async () => {
        const { sendTelegram: tg } = await import('./telegram');
        await tg(`📝 Evening reflection in 15 minutes.\n\nStart thinking: what did you avoid today, and why?`, 'HTML');
    });

    registerDailyJob('evening_reflection', eveningTime, async () => {
        await sendEveningReflection();
    });

    // Nightly Database Backup — runs every day at 03:00
    registerDailyJob('db_backup', '03:00', async () => {
        await fetch(`${baseUrl}/api/cron?action=backup`, { method: 'POST' });
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
        const res = await fetch(`${baseUrl}/api/guardian/optimize`, { method: 'POST' });
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
            await fetch(`${baseUrl}/api/cron?action=archive`, { method: 'POST' });
        }
    });

    // Override follow-up poll — every 5 minutes
    registerIntervalJob('override_followup_poll', 5 * 60 * 1000, async () => {
        const db = getDb();
        const now = new Date().toISOString();
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
            try {
                const domain = new URL(f.override_url).hostname.replace('www.', '');
                await sendTelegram(
                    `<b>Override check-in</b>\n\nYou visited <code>${domain}</code> 20 min ago.\nReason you gave: "${f.override_reason || 'none'}"\n\nWas it worth it? Reply yes/no or what actually happened.`,
                    'HTML'
                );
                db.prepare(`UPDATE override_follow_ups SET sent = 1, sent_at = ? WHERE id = ?`)
                  .run(new Date().toISOString(), f.id);
            } catch (err) {
                console.error('[Scheduler] override_followup_poll failed for id', f.id, err);
            }
        }
    });

    // Morning UIL synthesis — before Rohan picks up his phone
    registerDailyJob('morning_uil_synthesis', '07:30', async () => {
        try {
            // Trigger intelligence synthesis if function exists
            const { forceSynthesis } = await import('./intelligence');
            if (typeof forceSynthesis === 'function') {
                await forceSynthesis('morning_7:30');
            }
            console.log('[Scheduler] Morning UIL synthesis complete');
        } catch (err) {
            console.error('[Scheduler] morning_uil_synthesis failed:', err);
        }
    });

    // Streak cliff detection — day 4 of strong streak, fire at 20:00
    registerDailyJob('streak_cliff_detection', '20:00', async () => {
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
                        `You're on day 4. Your strongest stretches look exactly like this. Tomorrow is historically when the slide starts — not because you decide to stop, but because you find reasons. What's the plan for tomorrow morning specifically? Not in general. The first 30 minutes.`,
                        'HTML'
                    );
                    setSetting('streak_cliff_sent_date', today);
                }
            }
        } catch (err) {
            console.error('[Scheduler] streak_cliff_detection failed:', err);
        }
    });

    // Weekly reckoning — Sunday at 20:00
    registerDailyJob('weekly_reckoning', '20:00', async () => {
        const dayOfWeek = new Date().getDay(); // 0 = Sunday
        if (dayOfWeek !== 0) return;
        await sendWeeklyReckoning();
    });

    // Weekly open loops audit — Monday morning at 08:15
    registerDailyJob('open_loops_audit', '08:15', async () => {
        const dayOfWeek = new Date().getDay(); // 1 = Monday
        if (dayOfWeek !== 1) return;
        await sendOpenLoopsAudit();
    });

    // Monthly pattern letter — 1st of each month at 19:00
    registerDailyJob('monthly_pattern_letter', '19:00', async () => {
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
            const today = now.toISOString().slice(0, 10);
            if (job.lastRun?.startsWith(today)) return;

            job.running = true;
            console.log(`[Scheduler] Running ${name}...`);
            try {
                await fn();
                job.lastRun = new Date(Date.now() + 19800000).toISOString();
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
                job.lastRun = new Date(Date.now() + 19800000).toISOString();
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
            job.lastRun = new Date(Date.now() + 19800000).toISOString();
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
                await fetch(`${baseUrl}/api/summary?type=morning`);
                break;
            case 'daily_summary':
                await fetch(`${baseUrl}/api/summary?type=daily&date=${new Date(Date.now() + 19800000).toISOString().slice(0, 10)}`);
                break;
            case 'deep_analysis':
                await fetch(`${baseUrl}/api/behavior`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                break;
            case 'github_sync':
                await fetch(`${baseUrl}/api/github`, { method: 'POST' });
                break;
            case 'calendar_sync':
                await fetch(`${baseUrl}/api/calendar`, { method: 'POST' });
                break;
            case 'screen_time':
                await fetch(`${baseUrl}/api/screentime`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                break;
            case 'alert_engine':
                await fetch(`${baseUrl}/api/alerts/engine`, { method: 'POST' });
                break;
            case 'weekly_review':
                await fetch(`${baseUrl}/api/weekly`, { method: 'POST' });
                break;
            default:
                return { success: false, error: `Unknown job: ${name}` };
        }
        job.lastRun = new Date(Date.now() + 19800000).toISOString();
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
        initialized,
        jobs: Array.from(jobs.values()),
    };
}
