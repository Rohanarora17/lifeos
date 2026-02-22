import { getSetting } from './db';

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

/**
 * Initialize the scheduler with all configured jobs.
 * Safe to call multiple times — will only initialize once.
 */
export function initScheduler(baseUrl: string = 'http://localhost:3000') {
    if (initialized) return;
    initialized = true;

    console.log('[Scheduler] Initializing LifeOS cron jobs...');

    // Morning brief — runs every day at configured time
    const morningTime = getSetting('morning_brief_time') || '08:00';
    registerDailyJob('morning_brief', morningTime, async () => {
        await fetch(`${baseUrl}/api/summary?type=morning`);
    });

    // Daily summary — runs every day at configured time
    const summaryTime = getSetting('daily_summary_time') || '23:00';
    registerDailyJob('daily_summary', summaryTime, async () => {
        const today = new Date().toISOString().slice(0, 10);
        await fetch(`${baseUrl}/api/summary?type=daily&date=${today}`);
    });

    // Deep analysis — runs daily at 23:30
    registerDailyJob('deep_analysis', '23:30', async () => {
        await fetch(`${baseUrl}/api/behavior`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
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
                job.lastRun = new Date().toISOString();
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
                job.lastRun = new Date().toISOString();
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
            job.lastRun = new Date().toISOString();
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
                await fetch(`${baseUrl}/api/summary?type=daily&date=${new Date().toISOString().slice(0, 10)}`);
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
            default:
                return { success: false, error: `Unknown job: ${name}` };
        }
        job.lastRun = new Date().toISOString();
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
