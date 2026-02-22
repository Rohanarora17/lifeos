import { NextResponse } from 'next/server';
import { initScheduler, getSchedulerStatus, triggerJob } from '@/lib/scheduler';

// Ensure scheduler is initialized on first API call
let schedulerStarted = false;
function ensureScheduler() {
    if (!schedulerStarted) {
        initScheduler();
        schedulerStarted = true;
    }
}

// GET — Scheduler status
export async function GET() {
    ensureScheduler();
    return NextResponse.json(getSchedulerStatus());
}

// POST — Trigger a specific job manually
export async function POST(request: Request) {
    ensureScheduler();
    const body = await request.json().catch(() => ({}));
    const jobName = body.job;

    if (!jobName) {
        return NextResponse.json({ error: 'Missing "job" field' }, { status: 400 });
    }

    const result = await triggerJob(jobName);
    return NextResponse.json(result);
}
