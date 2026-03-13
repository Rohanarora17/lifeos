import { NextResponse } from 'next/server';
import { activeSessions, sessionEmitter } from '@/lib/session-state';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { sessionId, url, title, dwellSeconds, idleSeconds, type } = body;

        const session = activeSessions.get(sessionId);
        if (!session || session.state !== 'ACTIVE') {
            return NextResponse.json({ success: false, reason: 'Session not active' });
        }

        if (type === 'tab_navigation') {
            session.tabEventLog.push({ url, title, timestamp: Date.now(), dwellSeconds });
            // Quick classification mock for Phase 1
            const isDistraction = url.includes('youtube.com') || url.includes('twitter.com') || url.includes('reddit.com');
            const classification = isDistraction ? 'distraction' : 'on_topic';

            return NextResponse.json({ success: true, classified: classification });
        }

        if (type === 'idle_state' && idleSeconds) {
            session.tabEventLog.push({ url: 'lifeos://idle', title: 'Idle', timestamp: Date.now(), idleSeconds });
        }

        return NextResponse.json({ success: true });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
