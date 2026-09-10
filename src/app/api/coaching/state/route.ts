import { NextResponse } from 'next/server';
import { getCoachingState, getRecentCoachingDecisions } from '@/lib/coaching-state';
import { getSessionPerformanceProfile } from '@/lib/coaching-performance';
import { getCurrentCommitment, getInterventionLearningReport } from '@/lib/coaching-commitments';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const requestedLimit = Number(url.searchParams.get('limit') ?? 20);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 20;
    return NextResponse.json({
      success: true,
      state: getCoachingState(),
      performance: getSessionPerformanceProfile(),
      decisions: getRecentCoachingDecisions(limit),
      currentCommitment: getCurrentCommitment(),
      interventionLearning: getInterventionLearningReport(),
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
  }
}
