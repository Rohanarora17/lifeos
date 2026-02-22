import { NextResponse } from 'next/server';
import { collectScreenTime, saveScreenTime, getScreenTime } from '@/lib/screentime';

// GET — Fetch screen time data
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    return NextResponse.json(getScreenTime(date));
}

// POST — Collect and save screen time data
export async function POST(request: Request) {
    const body = await request.json().catch(() => ({}));
    const date = body.date || new Date(Date.now() + 19800000).toISOString().slice(0, 10);

    const entries = collectScreenTime(date);
    const saved = saveScreenTime(entries);

    return NextResponse.json({
        collected: entries.length,
        saved,
        data: getScreenTime(date),
    });
}
