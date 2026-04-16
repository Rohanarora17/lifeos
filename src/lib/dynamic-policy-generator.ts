import { getGenAI, generateWithFallback } from './ai';
import { MODEL_PRO } from './models';
import { getIntelligenceProfile } from './intelligence';
import { getActiveGuardianPolicyBundle, validatePolicyBundle } from './guardian-optimizer';
import { queryRelevantFacts, searchFactsByText } from './memory';
import type { GuardianPolicyBundle, SessionIntentProfile, WorkMode } from './guardian-types';

const WEIGHT_BOUNDS: [number, number] = [0.05, 0.60];
const MAX_DELTA = 0.10;

const MODE_FALLBACK_SHIFTS: Record<WorkMode, {
  weights: Partial<Record<'continuity' | 'switches' | 'dwell' | 'distractionPenalty' | 'idlePenalty', number>>;
  thresholds: Partial<Record<'idleConcernSeconds' | 'speechCooldownMs' | 'flowSilenceThreshold' | 'distractionRevisitBlockCount' | 'highScatterSpeakThreshold' | 'dwellDepthTargetSeconds', number>>;
}> = {
  deep_work: {
    weights: { continuity: 0.05, switches: 0.05, dwell: 0.05, distractionPenalty: -0.05, idlePenalty: -0.05 },
    thresholds: { idleConcernSeconds: -60, speechCooldownMs: -15000 },
  },
  research: {
    weights: { switches: -0.10, distractionPenalty: 0.05, dwell: -0.05, idlePenalty: -0.05 },
    thresholds: { idleConcernSeconds: 120, distractionRevisitBlockCount: 1, dwellDepthTargetSeconds: -60 },
  },
  urgent_sprint: {
    weights: { distractionPenalty: 0.10, idlePenalty: 0.05, continuity: -0.05, switches: -0.05, dwell: -0.05 },
    thresholds: { speechCooldownMs: -30000, flowSilenceThreshold: -10, distractionRevisitBlockCount: -1 },
  },
  learning: {
    weights: { dwell: 0.10, switches: -0.05, continuity: -0.05 },
    thresholds: { idleConcernSeconds: 180, dwellDepthTargetSeconds: -30 },
  },
  recovery: {
    weights: { idlePenalty: -0.10, distractionPenalty: -0.05, continuity: 0.05, dwell: 0.05 },
    thresholds: { idleConcernSeconds: 300, speechCooldownMs: 60000, dwellDepthTargetSeconds: -60 },
  },
};

export async function generateDynamicPolicy(
  intent: SessionIntentProfile,
): Promise<GuardianPolicyBundle> {
  const base = getActiveGuardianPolicyBundle();
  const uil = getIntelligenceProfile();
  const memoryFacts = loadMemoryFacts(intent.topic);

  const ai = getGenAI();
  if (!ai) return applyFallbackShifts(base, intent.workMode, uil);

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: buildPolicyPrompt(base, intent, uil, memoryFacts),
      config: { responseMimeType: 'application/json', temperature: 0 },
    });

    const raw = JSON.parse((result.text || '').trim());
    delete raw._rationale;
    const validated = validatePolicyBundle(raw) as GuardianPolicyBundle;
    console.log(`[DynamicPolicy] Generated policy v${validated.version} for mode=${intent.workMode}, energy=${intent.energyAtStart}`);
    return validated;
  } catch (err) {
    console.warn('[DynamicPolicy] LLM generation failed, using fallback:', (err as Error).message);
    return applyFallbackShifts(base, intent.workMode, uil);
  }
}

function loadMemoryFacts(topic: string): string {
  try {
    const relevant = queryRelevantFacts({ status: 'active', limit: 10 });
    const topicFacts = searchFactsByText(topic, 10);
    const seen = new Set(relevant.map(f => f.id));
    const all = [...relevant, ...topicFacts.filter(f => !seen.has(f.id))].slice(0, 15);

    if (all.length === 0) return 'No specific memory facts available.';
    return all.map(f => `- [${f.category}/${f.topic}] ${f.content} (conf:${f.confidence.toFixed(2)})`).join('\n');
  } catch {
    return 'No specific memory facts available.';
  }
}

function buildPolicyPrompt(
  base: GuardianPolicyBundle,
  intent: SessionIntentProfile,
  uil: ReturnType<typeof getIntelligenceProfile>,
  memoryFacts: string,
): string {
  const uilThresholds = uil.adaptiveThresholds;

  return `You are a focus-scoring policy optimizer. Generate an optimized GuardianPolicyBundle for this specific session.

SESSION INTENT:
- Work mode: ${intent.workMode}
- Topic: "${intent.topic}"
- Deadline urgency: ${intent.deadlineUrgency}
- Energy level: ${intent.energyAtStart}
- Coaching style: ${intent.coachingStyle}
- Distraction triggers: ${intent.recentDistractionTriggers.join(', ') || 'none known'}
- Avoidance patterns: ${intent.recentAvoidancePatterns.join(', ') || 'none known'}
- Optimal sprint: ${intent.optimalSprintMinutes} min

UIL ADAPTIVE THRESHOLDS (use these as baseline guidance):
- focusDropAlertScore: ${uilThresholds.focusDropAlertScore}
- distractionAlertMinutes: ${uilThresholds.distractionAlertMinutes}
- sessionDurationSweetSpot: ${uilThresholds.sessionDurationSweetSpot}
- cognitiveLoadThreshold: ${uilThresholds.cognitiveLoadThreshold}

KNOWN FACTS ABOUT THIS USER (from long-term memory):
${memoryFacts}

CURRENT BASELINE POLICY:
${JSON.stringify(base, null, 2)}

ADJUSTMENT RULES BY WORK MODE:
- deep_work: Increase dwell weight. Penalize tab switches heavily. Lower idle threshold. Shorter speech cooldown.
- research: Lower tab switch penalty (switching between papers/docs is normal). Increase distraction revisit penalty. Higher idle threshold. Lower dwellDepthTargetSeconds (shorter dwells are ok when switching between docs).
- urgent_sprint: Lower all thresholds for intervention. Shorter speech cooldown. Lower flow silence threshold. Block faster on distraction revisit.
- learning: Increase dwell weight. Tolerate educational YouTube. Higher idle threshold. Lower dwellDepthTargetSeconds slightly.
- recovery: Maximum leniency. Highest idle threshold. Longest speech cooldown. Gentle coaching. Only block on severe distraction revisits. Lower dwellDepthTargetSeconds.

DEADLINE URGENCY MODIFIERS:
- today/overdue: Override workMode with urgent_sprint behavior regardless.
- this_week: Slightly tighter thresholds.

ENERGY MODIFIERS:
- low: Increase idle threshold by 50%. Decrease speech frequency. Use gentle coaching.
- medium: Default behavior.
- high: Tighter thresholds acceptable. User can handle more structure.

UIL THRESHOLD MAPPING:
- focusDropAlertScore → informs lowFocusThreshold
- distractionAlertMinutes → informs idleConcernSeconds (multiply by 60)
- sessionDurationSweetSpot → informs recommended sprint

HARD CONSTRAINTS:
- Weights must sum to exactly 1.0 (tolerance ±0.01)
- Each weight must be in [0.05, 0.60]
- Thresholds must stay within bounds:
  speechCooldownMs: [30000, 300000]
  flowSilenceThreshold: [70, 100]
  distractionRevisitBlockCount: [2, 6]
  distractionTabSwitchBlockCount: [2, 8]
  highScatterSpeakThreshold: [3, 10]
  idleConcernSeconds: [120, 900]
  focusDropSpeakThreshold: [5, 30]
  lowFocusThreshold: [40, 80]
  dwellDepthTargetSeconds: [60, 600]
- redTeamRules must be preserved verbatim
- Do not change retrievalPrompt or sessionPlannerPrompt

Return ONLY a complete JSON GuardianPolicyBundle with ALL fields.`;
}

function applyFallbackShifts(
  base: GuardianPolicyBundle,
  workMode: WorkMode,
  uil: ReturnType<typeof getIntelligenceProfile>,
): GuardianPolicyBundle {
  const policy = structuredClone(base);
  const shifts = MODE_FALLBACK_SHIFTS[workMode];

  for (const [key, delta] of Object.entries(shifts.weights)) {
    if (key in policy.weights) {
      (policy.weights as Record<string, number>)[key] = clampWeight(
        (policy.weights as Record<string, number>)[key] + delta
      );
    }
  }

  for (const [key, delta] of Object.entries(shifts.thresholds)) {
    if (key in policy.thresholds) {
      (policy.thresholds as Record<string, number>)[key] =
        (policy.thresholds as Record<string, number>)[key] + delta;
    }
  }

  if (uil.adaptiveThresholds) {
    const t = uil.adaptiveThresholds;
    if (t.distractionAlertMinutes) {
      policy.thresholds.idleConcernSeconds = t.distractionAlertMinutes * 60;
    }
    if (t.focusDropAlertScore) {
      policy.thresholds.lowFocusThreshold = t.focusDropAlertScore;
    }
  }

  policy.weights = normaliseWeights(policy.weights);
  policy.version = `${base.version}-dynamic-${workMode}`;

  return policy;
}

function clampWeight(v: number): number {
  return Math.max(WEIGHT_BOUNDS[0], Math.min(WEIGHT_BOUNDS[1], v));
}

function normaliseWeights(w: GuardianPolicyBundle['weights']): GuardianPolicyBundle['weights'] {
  const entries = Object.entries(w) as Array<[keyof typeof w, number]>;
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  if (Math.abs(sum - 1.0) < 0.001) return w;
  const norm = Object.fromEntries(entries.map(([k, v]) => [k, v / sum])) as typeof w;
  return norm;
}
