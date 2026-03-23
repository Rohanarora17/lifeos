import { NextResponse } from 'next/server';
import { processGuardianVoiceCommand } from '@/lib/guardian-voice';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const transcript = body.transcript as string | undefined;
    const sessionId = body.sessionId as string | undefined;

    if (!transcript) {
      return NextResponse.json({ error: 'Missing transcript' }, { status: 400 });
    }

    const result = await processGuardianVoiceCommand({
      transcript,
      sessionId,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
