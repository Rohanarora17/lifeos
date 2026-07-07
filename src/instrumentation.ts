// Next.js Instrumentation — runs once on server startup
// Used to initialize the LifeOS cron scheduler

export async function register() {
    // Only run on the server (not Edge runtime)
    if (process.env.LIFEOS_DISABLE_SCHEDULER === 'true') {
        console.log('[Scheduler] Disabled by LIFEOS_DISABLE_SCHEDULER=true');
        return;
    }
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        const { initScheduler } = await import('./lib/scheduler');
        initScheduler('http://localhost:3000');
    }
}
