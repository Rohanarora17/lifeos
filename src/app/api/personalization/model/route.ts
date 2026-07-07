import { NextResponse } from 'next/server';
import { getFeedbackLearningSummary } from '@/lib/feedback-learning';
import { getIntelligenceProfile } from '@/lib/intelligence';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { buildSelfModel } from '@/lib/self-model';

export async function GET() {
  const snapshot = buildPersonalizationSnapshot({
    surface: 'self_model',
    maxInsights: 4,
    includeThresholds: true,
    includeMemoryFacts: 8,
  });
  const profile = getIntelligenceProfile();
  const feedbackFacts = getFeedbackLearningSummary(20);
  const selfModel = buildSelfModel({ snapshot, profile, feedbackFacts });

  return NextResponse.json({
    generatedAt: snapshot.generatedAt,
    selfModel,
    mode: snapshot.moment.mode,
    guidance: snapshot.moment.guidance,
    state: {
      energy: snapshot.userState.energy,
      mood: snapshot.userState.mood,
      focusTrend: snapshot.userState.focusTrend,
      coachingStyle: snapshot.userState.coachingStyle,
      nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
      narrative: snapshot.userState.narrative,
    },
    feedbackLoop: {
      alertFatigueLevel: snapshot.feedback.alertFatigueLevel,
      recentAlerts: snapshot.feedback.recentAlerts,
      helpfulRate: snapshot.feedback.helpfulRate,
      corrections30d: snapshot.feedback.corrections30d,
      learnedFacts: feedbackFacts,
    },
    intelligence: {
      version: profile.version,
      synthesizedAt: profile.synthesizedAt,
      trigger: profile.trigger,
      adaptiveThresholds: profile.adaptiveThresholds,
      coachingInsights: profile.coachingInsights,
    },
  });
}
