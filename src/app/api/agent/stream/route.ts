import { subscribeToGuardianRuntimeEvents } from '@/lib/guardian-bus';

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

      const onEvent = (eventSessionId: string, eventData: unknown) => {
        if (eventSessionId === sessionId) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(eventData)}\n\n`));
        }
      };

      const unsubscribe = subscribeToGuardianRuntimeEvents(onEvent);

      req.signal.addEventListener('abort', () => {
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
