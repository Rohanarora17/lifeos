import { NextResponse } from 'next/server';
import { tickGuardianSession } from '@/lib/guardian-runtime';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { sessionId } = body;

        if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });

        const result = await tickGuardianSession(sessionId, { sessionId, type: 'heartbeat', timestamp: Date.now() });
        if (!result.session) return NextResponse.json({ error: 'Guardian session is not active' }, { status: 409 });

        return NextResponse.json({
            success: true,
            focusScore: result.session.focusScoreHistory[result.session.focusScoreHistory.length - 1] ?? 100,
            trend: 'stable',
            actionTaken: result.decision.type,
            decision: result.decision,
            commands: result.commands,
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
