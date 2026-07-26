import { NextRequest, NextResponse } from 'next/server';
import {
  getActiveCoachMode,
  getActiveCoachPolicy,
  getCombinedPlannerBias,
  setActiveCoachMode,
  type ActiveCoachMode,
} from '@/lib/cognitive-active-coach';
import {
  ensureCognitiveExperimentOffer,
  getCognitiveExperimentState,
  proposeCognitiveExperiment,
  respondToCognitiveExperiment,
} from '@/lib/cognitive-experiments';
import { computeCognitiveTraits, setCognitiveTraitStance } from '@/lib/cognitive-traits';
import { getCognitiveTrajectory } from '@/lib/cognitive-self-answer';
import { getFeedbackLearningSummary } from '@/lib/feedback-learning';
import { getIntelligenceProfile } from '@/lib/intelligence';
import { buildPersonalizationSnapshot } from '@/lib/personalization-context';
import { buildSelfModel } from '@/lib/self-model';

function buildModelPayload() {
  const snapshot = buildPersonalizationSnapshot({
    surface: 'self_model',
    maxInsights: 4,
    includeThresholds: true,
    includeMemoryFacts: 8,
  });
  const profile = getIntelligenceProfile();
  const feedbackFacts = getFeedbackLearningSummary(20);
  const cognitiveTraits = computeCognitiveTraits({ windowDays: 45 });
  const experimentState = ensureCognitiveExperimentOffer(cognitiveTraits);
  const activeCoach = getActiveCoachPolicy({ traits: cognitiveTraits, snapshot });
  const plannerBias = getCombinedPlannerBias({ traits: cognitiveTraits, snapshot });
  const trajectory = getCognitiveTrajectory({ historyLimit: 90 });
  const selfModel = buildSelfModel({ snapshot, profile, feedbackFacts, cognitiveTraits });

  return {
    generatedAt: snapshot.generatedAt,
    selfModel,
    cognitiveTraits,
    hypotheses: cognitiveTraits.hypotheses,
    pressureProfile: cognitiveTraits.pressureProfile,
    trajectory,
    experiments: experimentState,
    activeCoach,
    plannerBias: {
      source: plannerBias.source,
      active: plannerBias.active,
      kind: plannerBias.kind,
      applyToNonUrgent: plannerBias.applyToNonUrgent,
      guidance: plannerBias.guidance,
      scoreBoost: plannerBias.scoreBoost,
      preferredActivationMinutes: plannerBias.preferredActivationMinutes,
    },
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
  };
}

export async function GET() {
  return NextResponse.json(buildModelPayload());
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      action?: string;
      traitId?: string;
      stance?: string;
      note?: string;
      experimentId?: string;
      response?: 'accepted' | 'declined' | 'completed' | 'cancelled';
      force?: boolean;
      mode?: ActiveCoachMode;
    };

    const action = body.action || 'set_stance';

    if (action === 'set_stance') {
      if (!body.traitId || !body.stance) {
        return NextResponse.json({ error: 'traitId and stance are required' }, { status: 400 });
      }
      const result = setCognitiveTraitStance({
        traitId: body.traitId,
        stance: body.stance,
        note: body.note,
      });
      return NextResponse.json({
        ok: true,
        action,
        traitId: result.traitId,
        stance: result.stance,
        trait: result.trait,
        factId: result.factId,
        cognitiveTraits: result.bundle,
        hypotheses: result.bundle.hypotheses,
        pressureProfile: result.bundle.pressureProfile,
        experiments: getCognitiveExperimentState(),
        activeCoach: getActiveCoachPolicy({ traits: result.bundle }),
        model: buildModelPayload(),
      });
    }

    if (action === 'propose_experiment') {
      const proposed = proposeCognitiveExperiment({ force: Boolean(body.force) });
      return NextResponse.json({
        ok: true,
        action,
        created: proposed.created,
        experiment: proposed.experiment,
        experiments: proposed.state,
        model: buildModelPayload(),
      });
    }

    if (action === 'respond_experiment') {
      if (!body.experimentId || !body.response) {
        return NextResponse.json({ error: 'experimentId and response are required' }, { status: 400 });
      }
      const result = respondToCognitiveExperiment({
        experimentId: body.experimentId,
        response: body.response,
        note: body.note,
      });
      return NextResponse.json({
        ok: true,
        action,
        experiment: result.experiment,
        experiments: result.state,
        model: buildModelPayload(),
      });
    }

    if (action === 'set_active_coach_mode') {
      const mode = body.mode === 'off' ? 'off' : 'auto';
      setActiveCoachMode(mode);
      return NextResponse.json({
        ok: true,
        action,
        mode: getActiveCoachMode(),
        activeCoach: getActiveCoachPolicy(),
        model: buildModelPayload(),
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update personalization model';
    const status = /Unknown|required|Only offered|Only accepted/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
