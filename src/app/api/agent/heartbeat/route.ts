import { NextResponse } from 'next/server';
import { tickAgentLoop } from '@/lib/agent-loop';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { sessionId } = body;

        if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });

        const result = await tickAgentLoop(sessionId);
        if (!result) return NextResponse.json({ error: 'Session not active' }, { status: 404 });

        return NextResponse.json(result);
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
