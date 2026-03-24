import { NextResponse } from 'next/server';
import { endGuardianSession, getGuardianSession, pauseGuardianSession, resumeGuardianSession } from '@/lib/guardian-runtime';
import { clearVoiceHistory } from '@/lib/guardian-voice';

export async function POST(req: Request) {
  try {
    const { sessionId, action } = await req.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
    }

    if (action === 'pause') {
      return NextResponse.json({ success: true, session: pauseGuardianSession(sessionId) });
    }

    if (action === 'resume') {
      return NextResponse.json({ success: true, session: resumeGuardianSession(sessionId) });
    }

    const result = endGuardianSession(sessionId);
    clearVoiceHistory(sessionId);
    return NextResponse.json({ success: true, session: result });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
