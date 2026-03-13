import { NextRequest } from 'next/server';
import { addClient, removeClient } from '@/lib/sse';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const clientId = crypto.randomUUID();

    const stream = new ReadableStream({
        start(controller) {
            addClient({ id: clientId, controller });

            // Send initial ping
            controller.enqueue(new TextEncoder().encode('event: ping\\ndata: "connected"\\n\\n'));

            // Heartbeat loop to keep connection alive
            const interval = setInterval(() => {
                try {
                    controller.enqueue(new TextEncoder().encode(': heartbeat\\n\\n'));
                } catch {
                    clearInterval(interval);
                    removeClient(clientId);
                }
            }, 10000);

            request.signal.addEventListener('abort', () => {
                clearInterval(interval);
                removeClient(clientId);
            });
        },
        cancel() {
            removeClient(clientId);
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*', // Allow extension to connect
        },
    });
}
