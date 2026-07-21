import { getDb } from '@/lib/db';
import { getGenAI, generateWithFallback } from '@/lib/ai';
import { MODEL_PRO } from '@/lib/models';
import { insertFact } from '@/lib/memory';
import type { GuardianPolicyBundle, LLMCalibrationSignal, SessionIntentProfile } from '@/lib/guardian-types';
import { getAdaptiveBands } from '@/lib/adaptive-bands';
import { recordExplicitFeedbackLearning, type ExplicitFeedback } from '@/lib/feedback-learning';

const LEARNING_RATE = 0.02;
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 0.60;
const MAX_LLM_DELTA = 0.10;

export interface SessionMetrics {
  system_energy_composite: number | null;
  system_focus_score: number | null;
  system_distraction_events: number | null;
  system_tab_switch_count: number | null;
  system_idle_minutes: number | null;
  system_intervention_count: number | null;
  system_override_count: number | null;
  elapsed_minutes: number | null;
  planned_minutes: number | null;
}

export interface CalibrationSignals {
  energy_over_estimated: boolean;
  energy_under_estimated: boolean;
  focus_over_estimated: boolean;
  focus_under_estimated: boolean;
  session_too_long: boolean;
  session_too_short: boolean;
  felt_distracted: boolean;
  felt_focused: boolean;
  self_awareness_score: number;
}

interface ProfileRow {
  id: number;
  energy_weight_standup: number;
  energy_weight_time_of_day: number;
  energy_weight_focus_quality: number;
  energy_weight_circadian: number;
  focus_weight_continuity: number;
  focus_weight_tab_switches: number;
  focus_weight_dwell: number;
  focus_weight_distraction_revisit: number;
  focus_weight_idle: number;
  calibration_accuracy: number | null;
  calibration_sessions_count: number;
}

const WEIGHT_KEY_MAP: Record<string, string> = {
  continuity: 'focus_weight_continuity',
  switches: 'focus_weight_tab_switches',
  dwell: 'focus_weight_dwell',
  distractionPenalty: 'focus_weight_distraction_revisit',
  idlePenalty: 'focus_weight_idle',
};

export function extractSignals(rawText: string, metrics: SessionMetrics): CalibrationSignals {
  const text = rawText.toLowerCase();

  const highEnergyWords = /\b(energized|energetic|fired up|focused|sharp|alert|in the zone|flow|great energy|high energy)\b/;
  const lowEnergyWords = /\b(tired|exhausted|low energy|drained|sluggish|heavy|unfocused|brain fog|sleepy)\b/;
  const overestimateEnergyPhrases = /\b(thought (i'?d|i would) be (more|better)|expected (more|higher)|system was (wrong|off|too optimistic))\b/;
  const underestimateEnergyPhrases = /\b(more energy than (expected|predicted)|surprised (myself|me)|felt (better|stronger) than)\b/;

  const userFeltHigh = highEnergyWords.test(text);
  const userFeltLow = lowEnergyWords.test(text);
  const explicitOver = overestimateEnergyPhrases.test(text);
  const explicitUnder = underestimateEnergyPhrases.test(text);

  const systemEnergyHigh = (metrics.system_energy_composite ?? 50) >= 65;
  const systemEnergyLow = (metrics.system_energy_composite ?? 50) < 35;

  const energy_over_estimated = explicitOver || (systemEnergyHigh && userFeltLow);
  const energy_under_estimated = explicitUnder || (systemEnergyLow && userFeltHigh);

  const distractedWords = /\b(distracted|scattered|couldn'?t focus|kept checking|off task|wandered|rabbit hole|doom.?scroll)\b/;
  const focusedWords = /\b(focused|deep work|in the zone|got a lot done|productive|knocked it out|made progress)\b/;

  const felt_distracted = distractedWords.test(text);
  const felt_focused = focusedWords.test(text);

  const focusBands = getAdaptiveBands();
  const systemFocusScore = metrics.system_focus_score ?? focusBands.focusNeutral;
  const systemFocusGood = systemFocusScore >= focusBands.focusGood;
  const systemFocusPoor = systemFocusScore < focusBands.focusNeutral;

  const focus_over_estimated = systemFocusGood && felt_distracted;
  const focus_under_estimated = systemFocusPoor && felt_focused;

  const session_too_long = /\b(too long|ran out of (energy|steam)|exhausted (by|before)|should have stopped|overextended)\b/.test(text);
  const session_too_short = /\b(too short|cut off|wished (i|it) had more time|needed more time|want(ed)? longer)\b/.test(text);

  let specificity = 0;
  if (rawText.length > 50) specificity += 0.2;
  if (rawText.length > 150) specificity += 0.2;
  if (/\d/.test(text)) specificity += 0.1;
  if (userFeltHigh || userFeltLow) specificity += 0.2;
  if (felt_distracted || felt_focused) specificity += 0.2;
  if (session_too_long || session_too_short) specificity += 0.1;
  const self_awareness_score = Math.min(1, specificity);

  return {
    energy_over_estimated,
    energy_under_estimated,
    focus_over_estimated,
    focus_under_estimated,
    session_too_long,
    session_too_short,
    felt_distracted,
    felt_focused,
    self_awareness_score,
  };
}

export async function extractLLMCalibrationSignals(
  rawText: string,
  metrics: SessionMetrics,
  intentProfile: SessionIntentProfile | null,
  sessionPolicy: GuardianPolicyBundle | null,
): Promise<LLMCalibrationSignal | null> {
  const ai = getGenAI();
  if (!ai) return null;

  const topic = intentProfile?.topic ?? 'unknown';
  const workMode = intentProfile?.workMode ?? 'deep_work';
  const energy = intentProfile?.energyAtStart ?? 'medium';
  const elapsed = metrics.elapsed_minutes ?? 0;
  const planned = metrics.planned_minutes ?? 0;

  const policySection = sessionPolicy
    ? `POLICY USED FOR THIS SESSION:
- Tab switch weight: ${sessionPolicy.weights.switches}
- Continuity weight: ${sessionPolicy.weights.continuity}
- Dwell weight: ${sessionPolicy.weights.dwell}
- Distraction revisit penalty weight: ${sessionPolicy.weights.distractionPenalty}
- Idle penalty weight: ${sessionPolicy.weights.idlePenalty}
- Idle concern threshold: ${sessionPolicy.thresholds.idleConcernSeconds}s
- Block after N distraction revisits: ${sessionPolicy.thresholds.distractionRevisitBlockCount}
- Dwell depth target: ${sessionPolicy.thresholds.dwellDepthTargetSeconds}s`
    : 'No session-specific policy was used (default policy applied).';

  try {
    const result = await generateWithFallback(ai, {
      model: MODEL_PRO,
      contents: `You are calibrating a focus guardian AI. The user just finished a session and gave free-text feedback. Analyze whether the system's scoring and intervention behavior was fair given the session context.

SESSION CONTEXT:
- Topic: "${topic}"
- Work mode: ${workMode}
- Energy at start: ${energy}
- Duration: ${elapsed} min (planned: ${planned} min)

SYSTEM MEASUREMENTS:
- Focus score: ${metrics.system_focus_score ?? 50}/100
- Energy composite: ${metrics.system_energy_composite ?? 50}/100
- Distraction events: ${metrics.system_distraction_events ?? 0}
- Interventions: ${metrics.system_intervention_count ?? 0}
- Overrides: ${metrics.system_override_count ?? 0}

${policySection}

USER FEEDBACK: "${rawText}"

Analyze:
1. Was the focus score fair for this type of work? (e.g., tab switching is normal for research but bad for writing — was it penalized appropriately?)
2. Were interventions too frequent or too rare?
3. Was the energy estimate accurate?
4. Did the work mode classification match what the user actually did?
5. What specific weight or threshold adjustments would make scoring fairer?

Return ONLY valid JSON matching this schema:
{
  "focusOverEstimated": boolean,
  "focusUnderEstimated": boolean,
  "energyOverEstimated": boolean,
  "energyUnderEstimated": boolean,
  "workModeMismatch": boolean,
  "suggestedWorkMode": "deep_work" | "research" | "urgent_sprint" | "learning" | "recovery" | null,
  "specificComplaints": ["string"],
  "weightAdjustments": [{"component": "continuity"|"switches"|"dwell"|"distractionPenalty"|"idlePenalty", "delta": number, "reason": "string"}],
  "thresholdAdjustments": [{"threshold": "string", "suggestedValue": number, "reason": "string"}],
  "overallSessionQuality": "excellent"|"good"|"mediocre"|"poor",
  "selfAwarenessScore": number
}`,
      config: { responseMimeType: 'application/json', temperature: 0 },
    });

    const parsed = JSON.parse((result.text || '').trim()) as LLMCalibrationSignal;
    if (typeof parsed.focusOverEstimated === 'boolean') return parsed;
    return null;
  } catch (err) {
    console.warn('[Calibration] LLM extraction failed:', (err as Error).message);
    return null;
  }
}

function clamp(val: number): number {
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, val));
}

function normalise(weights: Record<string, number>): Record<string, number> {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights;
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / sum]));
}

function ensureProfile(db: ReturnType<typeof getDb>): ProfileRow {
  const existing = db.prepare(`SELECT * FROM guardian_semantic_profiles ORDER BY updated_at DESC LIMIT 1`).get() as ProfileRow | undefined;
  if (existing) return existing;

  db.prepare(`
    INSERT INTO guardian_semantic_profiles
      (energy_weight_standup, energy_weight_time_of_day, energy_weight_focus_quality, energy_weight_circadian,
       focus_weight_continuity, focus_weight_tab_switches, focus_weight_dwell,
       focus_weight_distraction_revisit, focus_weight_idle,
       calibration_accuracy, calibration_sessions_count)
    VALUES (0.30, 0.25, 0.25, 0.20, 0.35, 0.25, 0.20, 0.15, 0.05, NULL, 0)
  `).run();
  return db.prepare(`SELECT * FROM guardian_semantic_profiles ORDER BY id DESC LIMIT 1`).get() as ProfileRow;
}

export interface CalibrationResult {
  feedbackId: number;
  signals: CalibrationSignals;
  llmSignal: LLMCalibrationSignal | null;
  adjustments: Array<{ component: string; previous: number; next: number; reason: string }>;
  newAccuracy: number | null;
  evalCaseCreated: boolean;
}

function sessionFeedbackSignal(input: {
  regexSignals: CalibrationSignals;
  llmSignal: LLMCalibrationSignal | null;
  focusOver: boolean;
  focusUnder: boolean;
  energyOver: boolean;
  energyUnder: boolean;
}): ExplicitFeedback {
  if (input.llmSignal?.workModeMismatch || input.focusOver || input.energyOver) return 'wrong';
  if (input.regexSignals.session_too_long || input.regexSignals.session_too_short) return 'not_helpful';
  if (input.llmSignal?.overallSessionQuality === 'poor' || input.llmSignal?.overallSessionQuality === 'mediocre') return 'not_helpful';
  if (input.focusUnder || input.energyUnder || input.regexSignals.felt_focused) return 'helpful';
  if (input.llmSignal?.overallSessionQuality === 'excellent' || input.llmSignal?.overallSessionQuality === 'good') return 'helpful';
  return 'helpful';
}

function loadSessionFeedbackSubject(db: ReturnType<typeof getDb>, sessionId: string, intentProfile: SessionIntentProfile | null): string {
  if (intentProfile?.topic) return `${intentProfile.topic} (${intentProfile.workMode})`;
  try {
    const row = db.prepare(`
      SELECT target_title, goal_title
      FROM guardian_session_summaries
      WHERE session_id = ?
    `).get(sessionId) as { target_title: string | null; goal_title: string | null } | undefined;
    return [row?.target_title, row?.goal_title].filter(Boolean).join(' / ') || sessionId;
  } catch {
    return sessionId;
  }
}

export async function processSessionFeedback(
  sessionId: string,
  rawText: string,
  metrics: SessionMetrics,
  intentProfile: SessionIntentProfile | null = null,
  sessionPolicy: GuardianPolicyBundle | null = null,
): Promise<CalibrationResult> {
  const db = getDb();

  const regexSignals = extractSignals(rawText, metrics);
  let llmSignal: LLMCalibrationSignal | null = null;

  if (rawText.length >= 10) {
    llmSignal = await extractLLMCalibrationSignals(rawText, metrics, intentProfile, sessionPolicy);
  }

  const useLLM = llmSignal !== null;
  const focusOver = useLLM ? llmSignal!.focusOverEstimated : regexSignals.focus_over_estimated;
  const focusUnder = useLLM ? llmSignal!.focusUnderEstimated : regexSignals.focus_under_estimated;
  const energyOver = useLLM ? llmSignal!.energyOverEstimated : regexSignals.energy_over_estimated;
  const energyUnder = useLLM ? llmSignal!.energyUnderEstimated : regexSignals.energy_under_estimated;

  const gaps: string[] = [];
  if (energyOver) gaps.push('energy overestimated by system');
  if (energyUnder) gaps.push('energy underestimated by system');
  if (focusOver) gaps.push('focus overestimated by system');
  if (focusUnder) gaps.push('focus underestimated by system');
  if (regexSignals.session_too_long) gaps.push('session too long');
  if (regexSignals.session_too_short) gaps.push('session too short');

  let prediction_error_energy: number | null = null;
  let prediction_error_focus: number | null = null;

  if (useLLM) {
    const qualityMap: Record<string, number> = { excellent: -1, good: -0.5, mediocre: 0.5, poor: 1 };
    if (energyOver) prediction_error_energy = 1;
    else if (energyUnder) prediction_error_energy = -1;
    if (focusOver) prediction_error_focus = qualityMap[llmSignal!.overallSessionQuality] ?? 1;
    else if (focusUnder) prediction_error_focus = qualityMap[llmSignal!.overallSessionQuality] ?? -1;
  } else {
    if (energyOver) prediction_error_energy = 1;
    else if (energyUnder) prediction_error_energy = -1;
    if (focusOver) prediction_error_focus = 1;
    else if (focusUnder) prediction_error_focus = -1;
  }

  const sessionLengthFit = regexSignals.session_too_long ? 'too_long' : regexSignals.session_too_short ? 'too_short' : 'about_right';

  const feedbackRow = db.prepare(`
    INSERT INTO session_feedback (
      session_id, raw_text,
      system_energy_composite, system_focus_trajectory,
      system_distraction_events, system_intervention_count, system_override_count,
      gap_analysis, prediction_error_energy, prediction_error_focus,
      session_length_fit, self_awareness_score,
      processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    sessionId,
    rawText,
    metrics.system_energy_composite,
    null,
    metrics.system_distraction_events,
    metrics.system_intervention_count,
    metrics.system_override_count,
    gaps.join('; ') || null,
    prediction_error_energy,
    prediction_error_focus,
    sessionLengthFit,
    useLLM ? (llmSignal!.selfAwarenessScore ?? regexSignals.self_awareness_score) : regexSignals.self_awareness_score,
  );
  const feedbackId = feedbackRow.lastInsertRowid as number;

  try {
    recordExplicitFeedbackLearning({
      source: 'session_feedback',
      feedback: sessionFeedbackSignal({
        regexSignals,
        llmSignal,
        focusOver,
        focusUnder,
        energyOver,
        energyUnder,
      }),
      surface: 'guardian_session',
      momentMode: intentProfile?.workMode ?? null,
      reason: rawText,
      subject: loadSessionFeedbackSubject(db, sessionId, intentProfile),
      metadata: {
        sessionId,
        feedbackId,
        gaps,
        sessionLengthFit,
        focusOver,
        focusUnder,
        energyOver,
        energyUnder,
        llmQuality: llmSignal?.overallSessionQuality ?? null,
      },
    });
  } catch {
    // Feedback memory should not block calibration.
  }

  const adjustments: Array<{ component: string; previous: number; next: number; reason: string }> = [];
  const selfAwareness = useLLM ? (llmSignal!.selfAwarenessScore ?? 0) : regexSignals.self_awareness_score;

  if (selfAwareness >= 0.2 || useLLM) {
    const profile = ensureProfile(db);

    const energyWeights = {
      energy_weight_standup: profile.energy_weight_standup,
      energy_weight_time_of_day: profile.energy_weight_time_of_day,
      energy_weight_focus_quality: profile.energy_weight_focus_quality,
      energy_weight_circadian: profile.energy_weight_circadian,
    };

    if (energyOver) {
      energyWeights.energy_weight_standup = clamp(energyWeights.energy_weight_standup - LEARNING_RATE);
      energyWeights.energy_weight_circadian = clamp(energyWeights.energy_weight_circadian + LEARNING_RATE);
      adjustments.push({ component: 'energy_weight_standup', previous: profile.energy_weight_standup, next: energyWeights.energy_weight_standup, reason: 'energy overestimated' });
      adjustments.push({ component: 'energy_weight_circadian', previous: profile.energy_weight_circadian, next: energyWeights.energy_weight_circadian, reason: 'energy overestimated — boost circadian' });
    } else if (energyUnder) {
      energyWeights.energy_weight_standup = clamp(energyWeights.energy_weight_standup + LEARNING_RATE);
      energyWeights.energy_weight_focus_quality = clamp(energyWeights.energy_weight_focus_quality + LEARNING_RATE);
      adjustments.push({ component: 'energy_weight_standup', previous: profile.energy_weight_standup, next: energyWeights.energy_weight_standup, reason: 'energy underestimated — standup is informative' });
      adjustments.push({ component: 'energy_weight_focus_quality', previous: profile.energy_weight_focus_quality, next: energyWeights.energy_weight_focus_quality, reason: 'energy underestimated — boost focus quality signal' });
    }

    const normEnergy = normalise(energyWeights);
    Object.assign(energyWeights, normEnergy);

    const focusWeights: Record<string, number> = {
      focus_weight_continuity: profile.focus_weight_continuity,
      focus_weight_tab_switches: profile.focus_weight_tab_switches,
      focus_weight_dwell: profile.focus_weight_dwell,
      focus_weight_distraction_revisit: profile.focus_weight_distraction_revisit,
      focus_weight_idle: profile.focus_weight_idle,
    };

    if (useLLM && llmSignal!.weightAdjustments.length > 0) {
      for (const adj of llmSignal!.weightAdjustments) {
        const dbKey = WEIGHT_KEY_MAP[adj.component];
        if (dbKey && dbKey in focusWeights) {
          const clampedDelta = Math.max(-MAX_LLM_DELTA, Math.min(MAX_LLM_DELTA, adj.delta));
          const prev = focusWeights[dbKey];
          focusWeights[dbKey] = clamp(prev + clampedDelta);
          adjustments.push({ component: dbKey, previous: prev, next: focusWeights[dbKey], reason: adj.reason });
        }
      }
    } else {
      if (focusOver) {
        focusWeights.focus_weight_distraction_revisit = clamp(focusWeights.focus_weight_distraction_revisit + LEARNING_RATE);
        focusWeights.focus_weight_continuity = clamp(focusWeights.focus_weight_continuity - LEARNING_RATE);
        adjustments.push({ component: 'focus_weight_distraction_revisit', previous: profile.focus_weight_distraction_revisit, next: focusWeights.focus_weight_distraction_revisit, reason: 'focus overestimated — user felt distracted' });
        adjustments.push({ component: 'focus_weight_continuity', previous: profile.focus_weight_continuity, next: focusWeights.focus_weight_continuity, reason: 'focus overestimated — reduce continuity weight' });
      } else if (focusUnder) {
        focusWeights.focus_weight_continuity = clamp(focusWeights.focus_weight_continuity + LEARNING_RATE);
        focusWeights.focus_weight_distraction_revisit = clamp(focusWeights.focus_weight_distraction_revisit - LEARNING_RATE);
        adjustments.push({ component: 'focus_weight_continuity', previous: profile.focus_weight_continuity, next: focusWeights.focus_weight_continuity, reason: 'focus underestimated — user felt focused' });
        adjustments.push({ component: 'focus_weight_distraction_revisit', previous: profile.focus_weight_distraction_revisit, next: focusWeights.focus_weight_distraction_revisit, reason: 'focus underestimated — reduce distraction penalty weight' });
      }
    }

    const normFocus = normalise(focusWeights);
    Object.assign(focusWeights, normFocus);

    db.prepare(`
      UPDATE guardian_semantic_profiles SET
        energy_weight_standup = ?,
        energy_weight_time_of_day = ?,
        energy_weight_focus_quality = ?,
        energy_weight_circadian = ?,
        focus_weight_continuity = ?,
        focus_weight_tab_switches = ?,
        focus_weight_dwell = ?,
        focus_weight_distraction_revisit = ?,
        focus_weight_idle = ?,
        calibration_sessions_count = calibration_sessions_count + 1,
        updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(
      energyWeights.energy_weight_standup,
      energyWeights.energy_weight_time_of_day,
      energyWeights.energy_weight_focus_quality,
      energyWeights.energy_weight_circadian,
      focusWeights.focus_weight_continuity,
      focusWeights.focus_weight_tab_switches,
      focusWeights.focus_weight_dwell,
      focusWeights.focus_weight_distraction_revisit,
      focusWeights.focus_weight_idle,
      profile.id,
    );

    for (const adj of adjustments) {
      db.prepare(`
        INSERT INTO calibration_history (session_feedback_id, component, previous_value, new_value, reason)
        VALUES (?, ?, ?, ?, ?)
      `).run(feedbackId, adj.component, adj.previous, adj.next, adj.reason);
    }

    const errorMagnitudes: number[] = [];
    if (prediction_error_energy !== null) errorMagnitudes.push(Math.abs(prediction_error_energy));
    if (prediction_error_focus !== null) errorMagnitudes.push(Math.abs(prediction_error_focus));

    let newAccuracy: number | null = null;
    if (errorMagnitudes.length > 0) {
      const sessionError = errorMagnitudes.reduce((a, b) => a + b, 0) / errorMagnitudes.length;
      const prevAccuracy = profile.calibration_accuracy ?? 1.0;
      const n = profile.calibration_sessions_count + 1;
      const alpha = Math.min(0.3, 2 / (n + 1));
      const sessionAccuracy = 1 - sessionError;
      newAccuracy = prevAccuracy * (1 - alpha) + sessionAccuracy * alpha;

      db.prepare(`
        UPDATE guardian_semantic_profiles SET calibration_accuracy = ? WHERE id = ?
      `).run(newAccuracy, profile.id);
    }

    // O6E-2: Store calibration corrections as memory facts
    if (useLLM && llmSignal!.workModeMismatch && llmSignal!.suggestedWorkMode && intentProfile) {
      try {
        insertFact({
          category: 'pattern',
          topic: intentProfile.topic,
          content: `Sessions about "${intentProfile.topic}" should be classified as ${llmSignal!.suggestedWorkMode}, not ${intentProfile.workMode}`,
          confidence: 0.8,
          importance: 0.7,
          source: 'calibration_correction',
          sourceEpisodeIds: [],
        });
      } catch { /* non-fatal */ }
    }

    if (useLLM && llmSignal!.specificComplaints.length > 0) {
      try {
        const recurring = llmSignal!.specificComplaints.find(c =>
          /block|guardian|scor|penal/i.test(c)
        );
        if (recurring) {
          insertFact({
            category: 'constraint',
            topic: 'guardian_behavior',
            content: `User reports: "${recurring.slice(0, 120)}" — adjust scoring tolerance`,
            confidence: 0.7,
            importance: 0.6,
            source: 'calibration_correction',
            sourceEpisodeIds: [],
          });
        }
      } catch { /* non-fatal */ }
    }

    // O6C-2: Create eval case from significant mistakes
    let evalCaseCreated = false;
    const isSignificantMistake =
      (focusOver && llmSignal?.specificComplaints?.some(c => /block|incorrect|wrong/i.test(c))) ||
      (focusUnder && llmSignal?.overallSessionQuality === 'poor') ||
      (llmSignal?.workModeMismatch);

    if (isSignificantMistake) {
      try {
        const { extractEvalCaseFromFeedback } = await import('./eval-case-extractor');
        evalCaseCreated = await extractEvalCaseFromFeedback(sessionId, llmSignal!, sessionPolicy);
        if (evalCaseCreated) {
          db.prepare(`
            INSERT INTO calibration_history (session_feedback_id, component, previous_value, new_value, reason)
            VALUES (?, ?, ?, ?, ?)
          `).run(feedbackId, 'eval_case', 0, 1, 'Generated eval case from user feedback');
        }
      } catch { /* non-fatal — extractor may not exist yet */ }
    }

    return { feedbackId, signals: regexSignals, llmSignal, adjustments, newAccuracy, evalCaseCreated };
  }

  return { feedbackId, signals: regexSignals, llmSignal: null, adjustments, newAccuracy: null, evalCaseCreated: false };
}

export function getCalibrationStatus(): {
  accuracy: number | null;
  sessions_count: number;
  recent_adjustments: Array<{
    component: string;
    previous_value: number;
    new_value: number;
    reason: string;
    applied_at: string;
  }>;
} {
  try {
    const db = getDb();
    const profile = db.prepare(`
      SELECT calibration_accuracy, calibration_sessions_count
      FROM guardian_semantic_profiles
      ORDER BY updated_at DESC LIMIT 1
    `).get() as { calibration_accuracy: number | null; calibration_sessions_count: number } | undefined;

    const recent = db.prepare(`
      SELECT component, previous_value, new_value, reason, applied_at
      FROM calibration_history
      ORDER BY applied_at DESC
      LIMIT 20
    `).all() as Array<{
      component: string;
      previous_value: number;
      new_value: number;
      reason: string;
      applied_at: string;
    }>;

    return {
      accuracy: profile?.calibration_accuracy ?? null,
      sessions_count: profile?.calibration_sessions_count ?? 0,
      recent_adjustments: recent,
    };
  } catch {
    return { accuracy: null, sessions_count: 0, recent_adjustments: [] };
  }
}
