import { NextResponse } from 'next/server';
import { tickGuardianSession } from '@/lib/guardian-runtime';
import { normalizeGuardianEventInput } from '@/lib/guardian-events';

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const event = normalizeGuardianEventInput(body);

    if (!event) {
      return NextResponse.json({ error: 'Malformed guardian event payload' }, { status: 400 });
    }

    const result = await tickGuardianSession(event.sessionId, event);
    if (!result.session) {
      return NextResponse.json({ error: 'Guardian session is not active' }, { status: 409 });
    }

    return NextResponse.json({
      success: true,
      decision: result.decision,
      commands: result.commands,
      session: result.session,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
