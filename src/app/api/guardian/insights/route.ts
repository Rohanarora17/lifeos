import { NextResponse } from 'next/server';
import { getIntelligenceProfile } from '@/lib/intelligence';
import { getActiveGuardianSession } from '@/lib/guardian-runtime';
import { getDb } from '@/lib/db';
import { getAdaptiveSessionMinutes } from '@/lib/adaptive-command-defaults';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { getAdaptiveTaskRecommendations } from '@/lib/adaptive-task-recommendations';
import {
  buildAssessmentClaim,
  canDriveDecision,
  containsRelativeDateLanguage,
} from '@/lib/assessment-claim';

export const dynamic = 'force-dynamic';

/**
 * GET /api/guardian/insights
 *
 * Returns a lightweight UIL snapshot for the Extension sidebar and Dashboard:
 * - active session state (elapsed, remaining, focus score, state)
 * - top coaching insights from the current UIL profile
 * - next best focus window
 * - today's habit completion rate
 * - focus trend + coaching style
 *
 * Designed for polling every 30s from the extension sidebar.
 */
export async function GET() {
  try {
    const profile = getIntelligenceProfile();
    const session = getActiveGuardianSession();
    const focusScore = session?.focusScoreHistory?.at(-1) ?? null;
    const personalization = buildPersonalizationSnapshot({
      surface: 'guidance',
      maxInsights: 2,
      includeMemoryFacts: 3,
      activeSession: session ? {
        sessionId: session.sessionId,
        targetTitle: session.targetTitle,
        focusScore,
        elapsedMinutes: Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000)),
      } : null,
    });
    const recommendedTasks = getAdaptiveTaskRecommendations(personalization, 3);
    const db = getDb();
    const profileEvidence = db.prepare(`
      SELECT
        COUNT(*) AS sample_count,
        COUNT(DISTINCT date(completed_at)) AS distinct_days,
        MIN(completed_at) AS observed_start,
        MAX(completed_at) AS observed_end
      FROM guardian_session_summaries
    `).get() as {
      sample_count: number;
      distinct_days: number;
      observed_start: string | null;
      observed_end: string | null;
    };
    const computedAt = new Date(profile.synthesizedAt || 0).toISOString();
    const expiresAt = new Date((profile.synthesizedAt || 0) + 24 * 60 * 60 * 1_000).toISOString();
    const commonClaim = {
      sampleSize: profile.version === 0 ? 0 : profileEvidence.sample_count,
      distinctDays: profile.version === 0 ? 0 : profileEvidence.distinct_days,
      evidenceReferences: profile.version === 0
        ? []
        : ['guardian_session_summaries:aggregate'],
      observationStart: profileEvidence.observed_start,
      observationEnd: profileEvidence.observed_end,
      computedAt,
      expiresAt,
      algorithmVersion: 'guardian-insights-claims-v1',
      modelVersion: profile.version === 0 ? null : `uil-profile-v${profile.version}`,
      userStance: 'unreviewed' as const,
    };
    const focusTrendClaim = buildAssessmentClaim({
      ...commonClaim,
      id: 'focus_trend',
      value: profile.focusTrend,
      valueValid: ['improving', 'declining', 'stable'].includes(profile.focusTrend),
      strength: 'decision',
    });
    const focusWindowClaim = buildAssessmentClaim({
      ...commonClaim,
      id: 'next_best_focus_window',
      value: profile.nextBestFocusWindow || null,
      strength: 'decision',
    });
    const coachingStyleClaim = buildAssessmentClaim({
      ...commonClaim,
      id: 'preferred_coaching_style',
      value: profile.preferredCoachingStyle,
      valueValid: ['direct', 'balanced', 'gentle'].includes(profile.preferredCoachingStyle),
      strength: 'identity',
    });
    const profileFresh = Date.now() < Date.parse(expiresAt);
    const supportedNarratives = profileFresh && canDriveDecision(focusTrendClaim)
      ? (profile.coachingInsights || [])
        .filter(item => !containsRelativeDateLanguage(item))
        .slice(0, 3)
      : [];

    // Today's habit completion
    let habitRate: number | null = null;
    try {
      const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
      const row = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN hc.completed = 1 THEN 1 ELSE 0 END) as done
        FROM habits h
        LEFT JOIN habit_checkins hc ON hc.habit_id = h.id AND hc.date = ?
        WHERE h.archived = 0
      `).get(today) as { total: number; done: number } | undefined;
      if (row && row.total > 0) {
        habitRate = Math.round((row.done / row.total) * 100);
      }
    } catch { /* non-fatal */ }

    // Active session summary
    let sessionData: Record<string, unknown> | null = null;
    if (session) {
      const elapsed = Math.max(0, Math.round((Date.now() - session.startedAt) / 60_000));
      const remaining = Math.max(0, session.durationMinutes - elapsed);
      const focusScore = session.focusScoreHistory?.at(-1) ?? 100;
      sessionData = {
        sessionId: session.sessionId,
        topic: session.targetTitle,
        elapsed,
        remaining,
        durationMinutes: session.durationMinutes,
        focusScore,
        state: session.state,
        classification: session.currentClassification,
      };
    }

    return NextResponse.json({
      session: sessionData,
      profile: {
        coachingInsights: supportedNarratives,
        nextBestFocusWindow: canDriveDecision(focusWindowClaim)
          ? focusWindowClaim.value
          : null,
        focusTrend: canDriveDecision(focusTrendClaim)
          ? focusTrendClaim.value
          : null,
        preferredCoachingStyle: canDriveDecision(coachingStyleClaim)
          ? coachingStyleClaim.value
          : null,
        weeklyProgressSummary: profileFresh
          && canDriveDecision(focusTrendClaim)
          && !containsRelativeDateLanguage(profile.weeklyProgressSummary)
            ? profile.weeklyProgressSummary
            : null,
        claims: {
          focusTrend: focusTrendClaim,
          nextBestFocusWindow: focusWindowClaim,
          preferredCoachingStyle: coachingStyleClaim,
        },
      },
      habits: {
        completionRate: habitRate,
      },
      personalization: {
        mode: personalization.moment.mode,
        guidance: personalization.moment.guidance,
        recommendedSessionMinutes: getAdaptiveSessionMinutes(),
        energy: personalization.userState.energy,
        mood: personalization.userState.mood,
        standupGoal: personalization.userState.standupGoal,
        alertFatigueLevel: personalization.feedback.alertFatigueLevel,
        recentAlerts: personalization.feedback.recentAlerts,
        nextBestFocusWindow: personalization.userState.nextBestFocusWindow,
        plannedFocus: personalization.today.plannedFocus,
      },
      recommendedTasks,
      generatedAt: Date.now(),
    });
  } catch (err) {
    console.error('[Insights API] Error:', err);
    return NextResponse.json({ error: 'Failed to load insights' }, { status: 500 });
  }
}
