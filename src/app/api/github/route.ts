import { NextResponse } from 'next/server';
import { syncGitHubActivity, getGitHubActivity, getGitHubStats } from '@/lib/github';

// GET — Fetch GitHub activity from DB
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action') || 'recent';

    if (action === 'stats') {
        const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);
        return NextResponse.json(getGitHubStats(date));
    }

    const days = parseInt(searchParams.get('days') || '7');
    const activity = getGitHubActivity(days);
    return NextResponse.json({ activity });
}

// POST — Trigger GitHub sync
export async function POST() {
    const result = await syncGitHubActivity();
    return NextResponse.json(result);
}
