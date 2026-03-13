import { NextResponse } from 'next/server';
import { startSession, getSession, pauseSession, resumeSession, endSession, activeSessions } from '@/lib/session-state';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { action, intent, sessionId } = body;

        let resSession = null;

        if (action === 'start') {
            resSession = startSession(intent || {});
        } else if (action === 'pause' && sessionId) {
            pauseSession(sessionId);
            resSession = getSession(sessionId);
        } else if (action === 'resume' && sessionId) {
            resumeSession(sessionId);
            resSession = getSession(sessionId);
        } else if (action === 'end' && sessionId) {
            endSession(sessionId);
            resSession = getSession(sessionId);
        }

        return NextResponse.json({ success: true, session: resSession });
    } catch (error) {
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}

export async function GET() {
    const sessions = Array.from(activeSessions.values());
    return NextResponse.json({ sessions });
}
