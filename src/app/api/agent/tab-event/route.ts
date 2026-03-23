import { NextResponse } from 'next/server';
import { tickGuardianSession } from '@/lib/guardian-runtime';
import { normalizeGuardianEventInput } from '@/lib/guardian-events';

export async function POST(req: Request) {
    try {
        const body = await req.json() as Record<string, unknown>;
        const event = normalizeGuardianEventInput({
            sessionId: body.sessionId,
            type: body.type === 'idle_state' ? 'idle' : 'tab',
            timestamp: typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
            url: body.url,
            title: body.title,
            dwellSeconds: body.dwellSeconds,
            idleSeconds: body.idleSeconds,
        });

        if (!event) {
            return NextResponse.json({ error: 'Malformed guardian event payload' }, { status: 400 });
        }

        const result = await tickGuardianSession(event.sessionId, event);
        if (!result.session) {
            return NextResponse.json({ error: 'Guardian session is not active' }, { status: 409 });
        }

        return NextResponse.json({
            success: true,
            classified: result.session?.currentClassification || 'unknown',
            commands: result.commands,
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
