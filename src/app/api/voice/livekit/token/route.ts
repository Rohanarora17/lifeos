import { NextResponse } from 'next/server';
import { createGuardianVoiceToken, isLiveKitConfigured } from '@/lib/livekit';
import { getGuardianSession } from '@/lib/guardian-runtime';
import { acquireGuardianVoiceLease } from '@/lib/guardian-voice-limits';

function isSameOriginRequest(req: Request) {
  const origin = req.headers.get('origin');
  if (!origin) return false;

  try {
    return origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  try {
    if (!isSameOriginRequest(req)) {
      return NextResponse.json({ error: 'Voice token requests must come from this LifeOS origin' }, { status: 403 });
    }

    if (!isLiveKitConfigured()) {
      return NextResponse.json(
        { error: 'LiveKit is not configured on this server' },
        { status: 503 }
      );
    }

    const body = await req.json();
    const sessionId = body.sessionId as string | undefined;

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }

    const session = getGuardianSession(sessionId);
    if (!session || session.state !== 'ACTIVE') {
      return NextResponse.json({ error: 'An active guardian session is required for realtime voice' }, { status: 409 });
    }

    const lease = acquireGuardianVoiceLease(sessionId);
    if (!lease.allowed) {
      return NextResponse.json({
        error: 'Live Guardian limit reached',
        reason: lease.reason,
        retryAfterSeconds: lease.retryAfterSeconds,
      }, { status: 429, headers: { 'Retry-After': String(lease.retryAfterSeconds) } });
    }

    const token = await createGuardianVoiceToken({
      sessionId,
      // Room metadata comes from the server-owned session, never caller input.
      targetTitle: session.targetTitle,
    });

    return NextResponse.json({
      ...token,
      interruptionHandling: true,
      semanticTurnDetection: true,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
