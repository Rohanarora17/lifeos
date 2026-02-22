import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { shouldNudge } from '@/lib/ai';

// GET: Check if user should be nudged (called by extension)
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const domain = searchParams.get('domain') || '';
        const minutes = parseInt(searchParams.get('minutes') || '0');
        const title = searchParams.get('title') || '';
        const url = searchParams.get('url') || '';
        const videoId = searchParams.get('videoId');

        if (!domain || minutes === 0) {
            return NextResponse.json({ nudge: false });
        }

        const nudgeResult = await shouldNudge(url, domain, minutes, title, videoId);

        if (nudgeResult.shouldNudge) {
            // Log the nudge
            const db = getDb();
            db.prepare(
                'INSERT INTO nudge_log (message, domain, duration_minutes) VALUES (?, ?, ?)'
            ).run(nudgeResult.message, domain, minutes);
        }

        return NextResponse.json({
            nudge: nudgeResult.shouldNudge,
            message: nudgeResult.message,
        });
    } catch (error) {
        console.error('Nudge GET error:', error);
        return NextResponse.json({ nudge: false });
    }
}

// POST: Acknowledge a nudge
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { nudge_id } = body;

        if (nudge_id) {
            const db = getDb();
            db.prepare('UPDATE nudge_log SET acknowledged = 1 WHERE id = ?').run(nudge_id);
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Nudge POST error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
