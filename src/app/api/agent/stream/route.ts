import { NextResponse } from 'next/server';
import { activeSessions, sessionEmitter } from '@/lib/session-state';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const sessionId = searchParams.get('sessionId');

    if (!sessionId) {
        return new Response('Missing sessionId', { status: 400 });
    }

    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();

            const onEvent = (eventSessionId: string, eventData: any) => {
                if (eventSessionId === sessionId) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(eventData)}\n\n`));
                }
            };

            sessionEmitter.on('agent_event', onEvent);

            req.signal.addEventListener('abort', () => {
                sessionEmitter.off('agent_event', onEvent);
                controller.close();
            });
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
        },
    });
}
