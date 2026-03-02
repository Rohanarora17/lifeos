import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { shouldNudge } from '@/lib/ai';

// Per-domain AI nudge result cache — prevents hammering Gemini on every 30s tick
// Key: `domain|url_prefix` → { shouldNudge, message, cachedAt }
const nudgeCache = new Map<string, { shouldNudge: boolean; message: string; cachedAt: number }>();
const NUDGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — re-evaluate max once per 10 min per domain

// GET: Check if user should be nudged (called by extension every 30s)
export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const domain = searchParams.get('domain') || '';
        const minutes = parseInt(searchParams.get('minutes') || '0');
        const title = searchParams.get('title') || '';
        const url = searchParams.get('url') || '';
        const videoId = searchParams.get('videoId');
        const focusMode = searchParams.get('focusMode') === 'true';
        const focusGoal = searchParams.get('focusGoal') || '';

        if (!domain || minutes === 0) {
            return NextResponse.json({ nudge: false });
        }

        // During focus mode, if below the threshold don't bother calling AI
        const threshold = focusMode ? 3 : 15;
        if (minutes < threshold) {
            return NextResponse.json({ nudge: false });
        }

        // Check in-memory cache — avoid calling AI if we already have a recent result for this domain
        const cacheKey = `${domain}|${url.split('?')[0]}|${focusMode}`;
        const cached = nudgeCache.get(cacheKey);
        if (cached && (Date.now() - cached.cachedAt) < NUDGE_CACHE_TTL_MS) {
            return NextResponse.json({ nudge: cached.shouldNudge, message: cached.message });
        }

        // Call AI nudge check
        const nudgeResult = await shouldNudge(
            url, domain, minutes, title, videoId,
            focusMode ? focusGoal : undefined,
            focusMode ? 3 : undefined  // 3 min threshold during focus vs default 15 min
        );

        // Cache the result for 10 minutes so we don't call AI again on every 30s tick
        nudgeCache.set(cacheKey, {
            shouldNudge: nudgeResult.shouldNudge,
            message: nudgeResult.message,
            cachedAt: Date.now(),
        });

        // Prune old cache entries to prevent unbounded growth
        if (nudgeCache.size > 200) {
            const now = Date.now();
            for (const [k, v] of nudgeCache) {
                if (now - v.cachedAt > NUDGE_CACHE_TTL_MS) nudgeCache.delete(k);
            }
        }

        if (nudgeResult.shouldNudge) {
            // Log the nudge
            const db = getDb();
            db.prepare(
                'INSERT INTO nudge_log (message, domain, duration_minutes) VALUES (?, ?, ?)'
            ).run(nudgeResult.message, domain, minutes);

            // Also send via the alert engine (which emails via Resend)
            const { sendAlert } = await import('@/lib/notifications');
            await sendAlert(
                'focus_drop',
                `${domain} — ${nudgeResult.message}`,
                focusMode ? 'urgent' : 'warning'
            );
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
