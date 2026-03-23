import { NextResponse } from 'next/server';
import { createGuardianVoiceToken, isLiveKitConfigured } from '@/lib/livekit';

export async function POST(req: Request) {
  try {
    if (!isLiveKitConfigured()) {
      return NextResponse.json(
        { error: 'LiveKit is not configured on this server' },
        { status: 503 }
      );
    }

    const body = await req.json();
    const sessionId = body.sessionId as string | undefined;
    const targetTitle = body.targetTitle as string | undefined;
    const participantName = body.participantName as string | undefined;

    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }

    const token = await createGuardianVoiceToken({
      sessionId,
      targetTitle,
      participantName,
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
