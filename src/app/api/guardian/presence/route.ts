import { NextResponse } from 'next/server';
import {
  getPendingPresenceCheck,
  resolvePresenceCheck,
  type PresenceResolution,
} from '@/lib/guardian-presence';
import {
  endGuardianSession,
  getGuardianSession,
  pauseGuardianSession,
  resumeGuardianSession,
} from '@/lib/guardian-runtime';
import { clearVoiceHistory } from '@/lib/guardian-voice';
import { releaseGuardianVoiceLease } from '@/lib/guardian-voice-limits';

export async function GET(req: Request) {
  const sessionId = new URL(req.url).searchParams.get('sessionId');
  if (!sessionId) return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  return NextResponse.json({ check: getPendingPresenceCheck(sessionId) });
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as {
      sessionId?: string;
      checkId?: string;
      action?: PresenceResolution;
    };
    if (!body.sessionId || !body.checkId) {
      return NextResponse.json({ error: 'Missing sessionId or checkId' }, { status: 400 });
    }
    if (!body.action || !['still_working', 'break', 'end'].includes(body.action)) {
      return NextResponse.json({ error: 'Invalid presence action' }, { status: 400 });
    }
    const session = getGuardianSession(body.sessionId);
    if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    const resolved = resolvePresenceCheck(body.checkId, body.action, Date.now(), body.sessionId);
    if (!resolved) {
      return NextResponse.json({ error: 'Presence check not found' }, { status: 404 });
    }

    let updatedSession = getGuardianSession(body.sessionId);
    if (body.action === 'still_working' && updatedSession?.pauseReason === 'presence_unconfirmed') {
      updatedSession = resumeGuardianSession(body.sessionId);
    } else if (body.action === 'break') {
      updatedSession = pauseGuardianSession(body.sessionId, 'manual');
    } else if (body.action === 'end') {
      updatedSession = endGuardianSession(body.sessionId);
      clearVoiceHistory(body.sessionId);
      releaseGuardianVoiceLease(body.sessionId);
    }
    return NextResponse.json({ success: true, check: resolved, session: updatedSession });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
