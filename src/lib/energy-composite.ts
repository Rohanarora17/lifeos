/**
 * Energy Composite
 *
 * Computes a [0–100] energy estimate from four signals:
 *   composite = w_standup * standup_mood
 *             + w_time_of_day * time_of_day_prior
 *             + w_focus_quality * recent_focus_quality
 *             + w_circadian * circadian_prior
 *
 * All sub-scores are normalised to [0, 1] before weighting.
 * Per-user weights are read from guardian_semantic_profiles; defaults mirror the
 * design spec (0.30 / 0.25 / 0.25 / 0.20).
 */

import { getDb, getSetting } from '@/lib/db';

export interface EnergyComponents {
  standup_mood: number;        // [0,1]
  time_of_day_prior: number;   // [0,1]
  recent_focus_quality: number;// [0,1]
  circadian_prior: number;     // [0,1]
  composite_score: number;     // [0,100]
  weights: {
    standup: number;
    time_of_day: number;
    focus_quality: number;
    circadian: number;
  };
}

interface WeightRow {
  energy_weight_standup: number;
  energy_weight_time_of_day: number;
  energy_weight_focus_quality: number;
  energy_weight_circadian: number;
}

/** Return the most recently updated semantic profile row, or defaults. */
function loadWeights(): WeightRow {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT energy_weight_standup,
             energy_weight_time_of_day,
             energy_weight_focus_quality,
             energy_weight_circadian
      FROM guardian_semantic_profiles
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as WeightRow | undefined;
    if (row) return row;
  } catch { /* table may not yet exist in dev */ }
  return {
    energy_weight_standup: 0.30,
    energy_weight_time_of_day: 0.25,
    energy_weight_focus_quality: 0.25,
    energy_weight_circadian: 0.20,
  };
}

/** Normalise weights so they always sum to 1.0 (guards against drift from calibration). */
function normaliseWeights(w: WeightRow): WeightRow {
  const total = w.energy_weight_standup + w.energy_weight_time_of_day +
                w.energy_weight_focus_quality + w.energy_weight_circadian;
  if (total === 0) return { energy_weight_standup: 0.25, energy_weight_time_of_day: 0.25, energy_weight_focus_quality: 0.25, energy_weight_circadian: 0.25 };
  return {
    energy_weight_standup:    w.energy_weight_standup    / total,
    energy_weight_time_of_day: w.energy_weight_time_of_day / total,
    energy_weight_focus_quality: w.energy_weight_focus_quality / total,
    energy_weight_circadian:  w.energy_weight_circadian  / total,
  };
}

/** Map mood string → [0,1]. */
function moodToScore(mood: string | null | undefined): number {
  switch ((mood ?? '').toLowerCase()) {
    case 'high':   return 1.0;
    case 'medium': return 0.6;
    case 'low':    return 0.3;
    default:       return 0.6; // unknown → treat as neutral
  }
}

/**
 * Historical average focus quality for this hour-of-day bucket (±1h window)
 * from guardian_session_summaries, normalised to [0,1].
 */
function computeTimeOfDayPrior(hourNow: number): number {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT average_focus_score / 100.0 as ratio
      FROM guardian_session_summaries
      WHERE started_at IS NOT NULL
        AND CAST(strftime('%H', started_at) AS INTEGER) BETWEEN ? AND ?
      ORDER BY started_at DESC
      LIMIT 30
    `).all(Math.max(0, hourNow - 1), Math.min(23, hourNow + 1)) as
      { ratio: number }[];

    if (rows.length === 0) return 0.6;
    return rows.reduce((s, r) => s + (r.ratio || 0), 0) / rows.length;
  } catch {
    return 0.6;
  }
}

/**
 * recent_focus_quality = mean(focus_score * (1 - distraction_event_ratio)) over last 3 sessions.
 * Removes circularity: discipline signal, not energy itself.
 */
function computeRecentFocusQuality(): number {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT average_focus_score, distraction_events, productive_events, neutral_events
      FROM guardian_session_summaries
      WHERE elapsed_minutes > 0
      ORDER BY started_at DESC
      LIMIT 3
    `).all() as {
      average_focus_score: number;
      distraction_events: number;
      productive_events: number;
      neutral_events: number;
    }[];

    if (rows.length === 0) return 0.6;

    const qualities = rows.map(r => {
      const focusScore = Math.min(1, (r.average_focus_score || 0) / 100);
      const totalEvents = (r.productive_events || 0) + (r.distraction_events || 0) + (r.neutral_events || 0);
      const distractionRatio = totalEvents > 0 ? Math.min(1, (r.distraction_events || 0) / totalEvents) : 0;
      return focusScore * (1 - distractionRatio);
    });
    return qualities.reduce((s, v) => s + v, 0) / qualities.length;
  } catch {
    return 0.6;
  }
}

/**
 * Circadian prior: historical average productive ratio for this day-of-week.
 */
function computeCircadianPrior(dayOfWeek: number): number {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT productive_minutes, distraction_minutes, neutral_minutes
      FROM daily_scores
      WHERE CAST(strftime('%w', date) AS INTEGER) = ?
      ORDER BY date DESC
      LIMIT 8
    `).all(dayOfWeek) as
      { productive_minutes: number; distraction_minutes: number; neutral_minutes: number }[];

    if (rows.length === 0) return 0.6;

    const ratios = rows.map(r => {
      const total = (r.productive_minutes || 0) + (r.distraction_minutes || 0) + (r.neutral_minutes || 0);
      return total > 0 ? (r.productive_minutes || 0) / total : 0.5;
    });
    return ratios.reduce((s, v) => s + v, 0) / ratios.length;
  } catch {
    return 0.6;
  }
}

/**
 * Main export — computes the energy composite and all sub-components.
 * Reads standup mood from today's settings key; all priors from DB history.
 */
export function computeEnergyComposite(): EnergyComponents {
  const now = new Date();
  const hourNow = now.getHours();
  const dayOfWeek = now.getDay();

  const todayMood = getSetting('standup_mood_today');
  const rawWeights = normaliseWeights(loadWeights());

  const standup_mood       = moodToScore(todayMood);
  const time_of_day_prior  = computeTimeOfDayPrior(hourNow);
  const recent_focus_quality = computeRecentFocusQuality();
  const circadian_prior    = computeCircadianPrior(dayOfWeek);

  const composite = (
    rawWeights.energy_weight_standup    * standup_mood +
    rawWeights.energy_weight_time_of_day * time_of_day_prior +
    rawWeights.energy_weight_focus_quality * recent_focus_quality +
    rawWeights.energy_weight_circadian  * circadian_prior
  );

  return {
    standup_mood,
    time_of_day_prior,
    recent_focus_quality,
    circadian_prior,
    composite_score: Math.round(composite * 100),
    weights: {
      standup:       rawWeights.energy_weight_standup,
      time_of_day:   rawWeights.energy_weight_time_of_day,
      focus_quality: rawWeights.energy_weight_focus_quality,
      circadian:     rawWeights.energy_weight_circadian,
    },
  };
}

/**
 * Persist an energy reading to DB for calibration history.
 * sessionId is optional — pass when called at session start.
 */
export function recordEnergyReading(components: EnergyComponents, sessionId?: string): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO energy_readings
        (standup_mood, time_of_day_prior, recent_focus_quality, circadian_prior, composite_score, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      components.standup_mood,
      components.time_of_day_prior,
      components.recent_focus_quality,
      components.circadian_prior,
      components.composite_score,
      sessionId ?? null,
    );
  } catch { /* non-fatal */ }
}
