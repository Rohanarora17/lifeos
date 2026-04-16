import { getDb } from './db';
import { getIntelligenceProfile } from './intelligence';

export interface AdaptiveBands {
  energyHigh: number;
  energyMedium: number;
  energyLow: number;
  focusExcellent: number;
  focusGood: number;
  focusNeutral: number;
  focusPoor: number;
  dailyCapacityMinutes: number;
  habitAtRiskDays: number;
  goalOnTrackVelocity: number;
  goalAtRiskVelocity: number;
  cognitiveLoadClear: number;
  cognitiveLoadModerate: number;
  deepWorkMinMinutes: number;
  flowMinMinutes: number;
  contextSwitchCostMinutes: number;
  stableFlowMaxTabSwitches: number;
  sessionGapMinutes: number;
  sessionMinDurationMinutes: number;
  fragmentedSwitchesPerHour: number;
  focusDeepWeight: number;
  focusFlowWeight: number;
  focusFragWeight: number;
  focusSwitchWeight: number;
}

const DEFAULT_BANDS: AdaptiveBands = {
  energyHigh: 65,
  energyMedium: 35,
  energyLow: 20,
  focusExcellent: 85,
  focusGood: 70,
  focusNeutral: 50,
  focusPoor: 35,
  dailyCapacityMinutes: 90,
  habitAtRiskDays: 3,
  goalOnTrackVelocity: 0.8,
  goalAtRiskVelocity: 0.6,
  cognitiveLoadClear: 70,
  cognitiveLoadModerate: 40,
  deepWorkMinMinutes: 25,
  flowMinMinutes: 45,
  contextSwitchCostMinutes: 23,
  stableFlowMaxTabSwitches: 2,
  sessionGapMinutes: 5,
  sessionMinDurationMinutes: 2,
  fragmentedSwitchesPerHour: 20,
  focusDeepWeight: 40,
  focusFlowWeight: 20,
  focusFragWeight: 20,
  focusSwitchWeight: 20,
};

let cachedBands: AdaptiveBands | null = null;
let bandsCacheTs = 0;
const BANDS_CACHE_TTL = 15 * 60 * 1000;

export function getAdaptiveBands(): AdaptiveBands {
  if (cachedBands && Date.now() - bandsCacheTs < BANDS_CACHE_TTL) return cachedBands;

  const bands = computeAdaptiveBands();
  cachedBands = bands;
  bandsCacheTs = Date.now();
  return bands;
}

function computeAdaptiveBands(): AdaptiveBands {
  const bands = { ...DEFAULT_BANDS };
  const uil = getIntelligenceProfile();

  try {
    const db = getDb();

    const energyRows = db.prepare(`
      SELECT composite_score FROM energy_readings
      WHERE timestamp >= datetime('now', '-30 days')
      ORDER BY timestamp DESC LIMIT 100
    `).all() as Array<{ composite_score: number }>;

    if (energyRows.length >= 10) {
      const scores = energyRows.map(r => r.composite_score).sort((a, b) => a - b);
      bands.energyHigh = percentile(scores, 70);
      bands.energyMedium = percentile(scores, 30);
      bands.energyLow = percentile(scores, 10);

      bands.focusExcellent = Math.min(95, percentile(scores, 85));
      bands.focusGood = Math.min(80, percentile(scores, 60));
      bands.focusNeutral = Math.min(65, percentile(scores, 40));
      bands.focusPoor = Math.min(50, percentile(scores, 20));
    }

    const sessionRows = db.prepare(`
      SELECT elapsed_minutes, average_focus_score
      FROM guardian_session_summaries
      WHERE completed_at >= datetime('now', '-30 days')
      ORDER BY completed_at DESC LIMIT 30
    `).all() as Array<{ elapsed_minutes: number; average_focus_score: number }>;

    if (sessionRows.length >= 5) {
      const durations = sessionRows.map(r => r.elapsed_minutes).sort((a, b) => a - b);
      bands.dailyCapacityMinutes = Math.round(percentile(durations, 75) * 3);
      bands.deepWorkMinMinutes = Math.round(percentile(durations, 40));
      bands.flowMinMinutes = Math.round(percentile(durations, 70));
    }

    const focusScores = sessionRows.map(r => r.average_focus_score).filter(s => s > 0).sort((a, b) => a - b);
    if (focusScores.length >= 5) {
      bands.focusExcellent = percentile(focusScores, 80);
      bands.focusGood = percentile(focusScores, 60);
      bands.focusNeutral = percentile(focusScores, 40);
      bands.focusPoor = percentile(focusScores, 20);
    }
  } catch { /* non-fatal — use defaults */ }

  if (uil.adaptiveThresholds) {
    const t = uil.adaptiveThresholds;
    if (t.cognitiveLoadThreshold) bands.cognitiveLoadClear = t.cognitiveLoadThreshold + 10;
    if (t.sessionDurationSweetSpot) bands.dailyCapacityMinutes = t.sessionDurationSweetSpot * 2;
    if (t.habitRiskDays) bands.habitAtRiskDays = t.habitRiskDays;
  }

  return bands;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
  return sorted[idx];
}

export function classifyEnergy(score: number): 'high' | 'medium' | 'low' {
  const bands = getAdaptiveBands();
  if (score >= bands.energyHigh) return 'high';
  if (score >= bands.energyMedium) return 'medium';
  return 'low';
}

export function classifyFocus(score: number): 'excellent' | 'good' | 'neutral' | 'poor' {
  const bands = getAdaptiveBands();
  if (score >= bands.focusExcellent) return 'excellent';
  if (score >= bands.focusGood) return 'good';
  if (score >= bands.focusNeutral) return 'neutral';
  return 'poor';
}

export function classifyCognitiveLoad(bandwidth: number): 'clear' | 'moderate' | 'overloaded' {
  const bands = getAdaptiveBands();
  if (bandwidth >= bands.cognitiveLoadClear) return 'clear';
  if (bandwidth >= bands.cognitiveLoadModerate) return 'moderate';
  return 'overloaded';
}

export function classifyGoalHealth(velocity: number): 'on_track' | 'at_risk' | 'off_track' {
  const bands = getAdaptiveBands();
  if (velocity >= bands.goalOnTrackVelocity) return 'on_track';
  if (velocity >= bands.goalAtRiskVelocity) return 'at_risk';
  return 'off_track';
}

export function invalidateBandsCache(): void {
  cachedBands = null;
  bandsCacheTs = 0;
}
