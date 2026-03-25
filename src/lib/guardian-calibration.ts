/**
 * Guardian Calibration
 *
 * Processes post-session user feedback to:
 *   1. Extract calibration signals from free-text (energy accuracy, focus accuracy, length fit)
 *   2. Compute prediction errors vs system readings
 *   3. Nudge per-user energy + focus weights in guardian_semantic_profiles (small LR)
 *   4. Log every weight adjustment to calibration_history
 *   5. Update calibration_accuracy + calibration_sessions_count on the profile
 *
 * The adjustment is purely rule-based (no AI call on the hot path). A lightweight
 * keyword signal extraction reads the user's words, then nudges weights ±LEARNING_RATE,
 * bounded to the allowed min/max per component.
 *
 * Future: can swap signal extraction for an async LLM analysis pass without changing
 * the weight-adjustment or persistence logic below.
 */

import { getDb } from '@/lib/db';

const LEARNING_RATE = 0.02;   // weight delta per signal
const MIN_WEIGHT = 0.05;
const MAX_WEIGHT = 0.60;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  energy_over_estimated: boolean;  // system said high, user felt low
  energy_under_estimated: boolean; // system said low, user felt high
  focus_over_estimated: boolean;   // score showed good but user felt scattered
  focus_under_estimated: boolean;  // score showed poor but user felt focused
  session_too_long: boolean;
  session_too_short: boolean;
  felt_distracted: boolean;
  felt_focused: boolean;
  self_awareness_score: number;    // [0,1] — how coherent was the feedback?
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

// ---------------------------------------------------------------------------
// Signal extraction (keyword heuristic)
// ---------------------------------------------------------------------------

export function extractSignals(rawText: string, metrics: SessionMetrics): CalibrationSignals {
  const text = rawText.toLowerCase();

  // Energy signals
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

  // Focus signals
  const distractedWords = /\b(distracted|scattered|couldn'?t focus|kept checking|off task|wandered|rabbit hole|doom.?scroll)\b/;
  const focusedWords = /\b(focused|deep work|in the zone|got a lot done|productive|knocked it out|made progress)\b/;

  const felt_distracted = distractedWords.test(text);
  const felt_focused = focusedWords.test(text);

  const systemFocusGood = (metrics.system_focus_score ?? 50) >= 70;
  const systemFocusPoor = (metrics.system_focus_score ?? 50) < 50;

  const focus_over_estimated = systemFocusGood && felt_distracted;
  const focus_under_estimated = systemFocusPoor && felt_focused;

  // Session length signals
  const session_too_long = /\b(too long|ran out of (energy|steam)|exhausted (by|before)|should have stopped|overextended)\b/.test(text);
  const session_too_short = /\b(too short|cut off|wished (i|it) had more time|needed more time|want(ed)? longer)\b/.test(text);

  // Self-awareness score: more specific = higher score
  let specificity = 0;
  if (rawText.length > 50) specificity += 0.2;
  if (rawText.length > 150) specificity += 0.2;
  if (/\d/.test(text)) specificity += 0.1; // mentions numbers
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

// ---------------------------------------------------------------------------
// Weight adjustment helpers
// ---------------------------------------------------------------------------

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

  // Bootstrap a profile row with defaults
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

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface CalibrationResult {
  feedbackId: number;
  signals: CalibrationSignals;
  adjustments: Array<{ component: string; previous: number; next: number; reason: string }>;
  newAccuracy: number | null;
}

/**
 * Process one session's feedback text against actual session metrics.
 * Persists to session_feedback + calibration_history + guardian_semantic_profiles.
 */
export function processSessionFeedback(
  sessionId: string,
  rawText: string,
  metrics: SessionMetrics,
): CalibrationResult {
  const db = getDb();
  const signals = extractSignals(rawText, metrics);

  // Build gap_analysis summary
  const gaps: string[] = [];
  if (signals.energy_over_estimated) gaps.push('energy overestimated by system');
  if (signals.energy_under_estimated) gaps.push('energy underestimated by system');
  if (signals.focus_over_estimated) gaps.push('focus overestimated by system');
  if (signals.focus_under_estimated) gaps.push('focus underestimated by system');
  if (signals.session_too_long) gaps.push('session too long');
  if (signals.session_too_short) gaps.push('session too short');

  // Prediction errors
  let prediction_error_energy: number | null = null;
  let prediction_error_focus: number | null = null;
  if (signals.energy_over_estimated) prediction_error_energy = 1;
  else if (signals.energy_under_estimated) prediction_error_energy = -1;
  if (signals.focus_over_estimated) prediction_error_focus = 1;
  else if (signals.focus_under_estimated) prediction_error_focus = -1;

  const sessionLengthFit = signals.session_too_long ? 'too_long' : signals.session_too_short ? 'too_short' : 'about_right';

  // Persist feedback row
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
    signals.self_awareness_score,
  );
  const feedbackId = feedbackRow.lastInsertRowid as number;

  // Skip weight adjustments if feedback is too vague
  const adjustments: Array<{ component: string; previous: number; next: number; reason: string }> = [];
  if (signals.self_awareness_score >= 0.2) {
    const profile = ensureProfile(db);

    // Energy weight adjustments
    const energyWeights = {
      energy_weight_standup: profile.energy_weight_standup,
      energy_weight_time_of_day: profile.energy_weight_time_of_day,
      energy_weight_focus_quality: profile.energy_weight_focus_quality,
      energy_weight_circadian: profile.energy_weight_circadian,
    };

    if (signals.energy_over_estimated) {
      // System overpredicted energy — reduce weight of standup_mood (it may be unreliable)
      energyWeights.energy_weight_standup = clamp(energyWeights.energy_weight_standup - LEARNING_RATE);
      // Increase circadian weight (actual body clock patterns are more reliable)
      energyWeights.energy_weight_circadian = clamp(energyWeights.energy_weight_circadian + LEARNING_RATE);
      adjustments.push({ component: 'energy_weight_standup', previous: profile.energy_weight_standup, next: energyWeights.energy_weight_standup, reason: 'energy overestimated' });
      adjustments.push({ component: 'energy_weight_circadian', previous: profile.energy_weight_circadian, next: energyWeights.energy_weight_circadian, reason: 'energy overestimated — boost circadian' });
    } else if (signals.energy_under_estimated) {
      energyWeights.energy_weight_standup = clamp(energyWeights.energy_weight_standup + LEARNING_RATE);
      energyWeights.energy_weight_focus_quality = clamp(energyWeights.energy_weight_focus_quality + LEARNING_RATE);
      adjustments.push({ component: 'energy_weight_standup', previous: profile.energy_weight_standup, next: energyWeights.energy_weight_standup, reason: 'energy underestimated — standup is informative' });
      adjustments.push({ component: 'energy_weight_focus_quality', previous: profile.energy_weight_focus_quality, next: energyWeights.energy_weight_focus_quality, reason: 'energy underestimated — boost focus quality signal' });
    }

    const normEnergy = normalise(energyWeights);
    Object.assign(energyWeights, normEnergy);

    // Focus weight adjustments
    const focusWeights = {
      focus_weight_continuity: profile.focus_weight_continuity,
      focus_weight_tab_switches: profile.focus_weight_tab_switches,
      focus_weight_dwell: profile.focus_weight_dwell,
      focus_weight_distraction_revisit: profile.focus_weight_distraction_revisit,
      focus_weight_idle: profile.focus_weight_idle,
    };

    if (signals.focus_over_estimated && signals.felt_distracted) {
      // System missed distraction — boost distraction_revisit weight
      focusWeights.focus_weight_distraction_revisit = clamp(focusWeights.focus_weight_distraction_revisit + LEARNING_RATE);
      focusWeights.focus_weight_continuity = clamp(focusWeights.focus_weight_continuity - LEARNING_RATE);
      adjustments.push({ component: 'focus_weight_distraction_revisit', previous: profile.focus_weight_distraction_revisit, next: focusWeights.focus_weight_distraction_revisit, reason: 'focus overestimated — user felt distracted' });
      adjustments.push({ component: 'focus_weight_continuity', previous: profile.focus_weight_continuity, next: focusWeights.focus_weight_continuity, reason: 'focus overestimated — reduce continuity weight' });
    } else if (signals.focus_under_estimated && signals.felt_focused) {
      // System underestimated focus — boost continuity weight
      focusWeights.focus_weight_continuity = clamp(focusWeights.focus_weight_continuity + LEARNING_RATE);
      focusWeights.focus_weight_distraction_revisit = clamp(focusWeights.focus_weight_distraction_revisit - LEARNING_RATE);
      adjustments.push({ component: 'focus_weight_continuity', previous: profile.focus_weight_continuity, next: focusWeights.focus_weight_continuity, reason: 'focus underestimated — user felt focused' });
      adjustments.push({ component: 'focus_weight_distraction_revisit', previous: profile.focus_weight_distraction_revisit, next: focusWeights.focus_weight_distraction_revisit, reason: 'focus underestimated — reduce distraction penalty weight' });
    }

    const normFocus = normalise(focusWeights);
    Object.assign(focusWeights, normFocus);

    // Persist updated profile
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

    // Log each adjustment to calibration_history
    for (const adj of adjustments) {
      db.prepare(`
        INSERT INTO calibration_history (session_feedback_id, component, previous_value, new_value, reason)
        VALUES (?, ?, ?, ?, ?)
      `).run(feedbackId, adj.component, adj.previous, adj.next, adj.reason);
    }

    // Update calibration_accuracy: rolling mean of |prediction_error_energy| and |prediction_error_focus|
    // 0 = perfect prediction, 1 = maximum error
    const errorMagnitudes: number[] = [];
    if (prediction_error_energy !== null) errorMagnitudes.push(Math.abs(prediction_error_energy));
    if (prediction_error_focus !== null) errorMagnitudes.push(Math.abs(prediction_error_focus));

    let newAccuracy: number | null = null;
    if (errorMagnitudes.length > 0) {
      const sessionError = errorMagnitudes.reduce((a, b) => a + b, 0) / errorMagnitudes.length;
      const prevAccuracy = profile.calibration_accuracy ?? 1.0; // start pessimistic
      const n = profile.calibration_sessions_count + 1;
      // Exponential moving average toward accuracy (1 - error)
      const alpha = Math.min(0.3, 2 / (n + 1));
      const sessionAccuracy = 1 - sessionError;
      newAccuracy = prevAccuracy * (1 - alpha) + sessionAccuracy * alpha;

      db.prepare(`
        UPDATE guardian_semantic_profiles SET calibration_accuracy = ? WHERE id = ?
      `).run(newAccuracy, profile.id);
    }

    return { feedbackId, signals, adjustments, newAccuracy };
  }

  return { feedbackId, signals, adjustments, newAccuracy: null };
}

/**
 * Returns the current calibration accuracy and recent history for display.
 */
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
