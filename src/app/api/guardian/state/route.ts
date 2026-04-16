import { NextResponse } from 'next/server';
import { getGuardianContext, getGuardianSession } from '@/lib/guardian-runtime';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sessionId = url.searchParams.get('sessionId');

    if (sessionId) {
      const session = getGuardianSession(sessionId);
      if (!session) {
        return NextResponse.json({ error: 'Session not found' }, { status: 404 });
      }
      return NextResponse.json({
        sessionId: session.sessionId,
        state: session.state,
        targetTitle: session.targetTitle,
        focusScore: session.focusScoreHistory[session.focusScoreHistory.length - 1] ?? null,
        elapsed: Math.round((Date.now() - session.startedAt) / 60000),
        durationMinutes: session.durationMinutes,
        blockedCount: session.blockedCount,
        overrideCount: session.overrideCount,
        activeOverrides: session.activeOverrides,
        intentProfile: session.intentProfile,
        sessionPolicy: session.sessionPolicy ? {
          version: session.sessionPolicy.version,
          weights: session.sessionPolicy.weights,
          thresholds: session.sessionPolicy.thresholds,
        } : null,
        energyComposite: session.energyComposite,
      });
    }

    const context = getGuardianContext();
    return NextResponse.json(context);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
