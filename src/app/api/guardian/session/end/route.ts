import { NextResponse } from 'next/server';
import { endGuardianSession, pauseGuardianSession, resumeGuardianSession } from '@/lib/guardian-runtime';
import { clearVoiceHistory } from '@/lib/guardian-voice';
import { releaseGuardianVoiceLease } from '@/lib/guardian-voice-limits';
import { finalizeGuardianEvidenceSession } from '@/lib/guardian-evidence-store';
import { recordGuardianShadowReport } from '@/lib/guardian-evidence-shadow';

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

    const evidence = await finalizeGuardianEvidenceSession(sessionId);
    const result = endGuardianSession(sessionId);
    const shadowReport = result ? recordGuardianShadowReport(result) : null;
    clearVoiceHistory(sessionId);
    releaseGuardianVoiceLease(sessionId);
    return NextResponse.json({ success: true, session: result, evidence, shadowReport });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
