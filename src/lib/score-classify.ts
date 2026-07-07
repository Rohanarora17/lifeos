import type { AdaptiveBands } from './adaptive-bands';

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
  entropyLaserMax: 0.2,
  entropyFocusedMax: 0.4,
  entropyScatteredMin: 0.6,
  entropyChaoticMin: 0.8,
  switchesPerHourLaser: 5,
  switchesPerHourFocused: 10,
  switchesPerHourScattered: 20,
  switchesPerHourChaotic: 30,
  nudgeResponseLow: 0.3,
  nudgeResponseHigh: 0.7,
  consistencyClockwork: 0.3,
  consistencyBurst: 0.6,
  goalProgressOnTrack: 0.8,
  deepWorkSessionRatio: 0.3,
  productivityRatioHigh: 0.6,
  productivityRatioMedium: 0.3,
  accuracyHigh: 0.7,
  accuracyMedium: 0.5,
  overrideThreshold: 0.5,
};

let clientBands: AdaptiveBands | null = null;

export function setClientBands(bands: AdaptiveBands): void {
  clientBands = { ...DEFAULT_BANDS, ...bands };
}

function bands(): AdaptiveBands {
  return clientBands ?? DEFAULT_BANDS;
}

export type ScoreTier = 'excellent' | 'good' | 'neutral' | 'poor';

export function classifyScore(score: number): ScoreTier {
  const b = bands();
  if (score >= b.focusExcellent) return 'excellent';
  if (score >= b.focusGood) return 'good';
  if (score >= b.focusNeutral) return 'neutral';
  return 'poor';
}

export function scoreColor(score: number): string {
  const tier = classifyScore(score);
  switch (tier) {
    case 'excellent': return 'var(--accent-green, #22c55e)';
    case 'good': return 'var(--accent-yellow, #f59e0b)';
    case 'neutral': return 'var(--accent-orange, #f97316)';
    case 'poor': return 'var(--accent-red, #ef4444)';
  }
}

export function scoreBadgeBg(score: number): string {
  const tier = classifyScore(score);
  switch (tier) {
    case 'excellent': return 'rgba(34,197,94,0.1)';
    case 'good': return 'rgba(245,158,11,0.1)';
    case 'neutral': return 'rgba(249,115,22,0.1)';
    case 'poor': return 'rgba(239,68,68,0.1)';
  }
}

export function scoreBadgeBorder(score: number): string {
  const tier = classifyScore(score);
  switch (tier) {
    case 'excellent': return 'rgba(34,197,94,0.3)';
    case 'good': return 'rgba(245,158,11,0.3)';
    case 'neutral': return 'rgba(249,115,22,0.3)';
    case 'poor': return 'rgba(239,68,68,0.3)';
  }
}

export function masteryColor(mastery: number): string {
  const b = bands();
  if (mastery >= b.focusExcellent / 100) return '#10b981';
  if (mastery >= b.focusNeutral / 100) return '#f59e0b';
  if (mastery >= b.focusPoor / 100) return '#ef4444';
  return '#475569';
}

export function masteryTier(mastery: number): { label: string; color: string } {
  const b = bands();
  if (mastery >= b.focusExcellent / 100) return { label: `Mastered (${Math.round(b.focusExcellent)}%+)`, color: '#10b981' };
  if (mastery >= b.focusNeutral / 100) return { label: `Progressing (${Math.round(b.focusNeutral)}%+)`, color: '#f59e0b' };
  return { label: 'Needs work', color: '#ef4444' };
}

export function efficacyEmoji(rate: number): string {
  const b = bands();
  if (rate >= b.cognitiveLoadClear) return '\u{1F4AA}';
  if (rate >= b.cognitiveLoadModerate) return '\u{1F4CA}';
  return '\u{1F504}';
}

export function scoreBadgeText(score: number): string {
  const tier = classifyScore(score);
  switch (tier) {
    case 'excellent': return '#22c55e';
    case 'good': return '#f59e0b';
    case 'neutral': return '#f97316';
    case 'poor': return '#ef4444';
  }
}

export function progressColor(progress: number): string {
  const b = bands();
  if (progress >= b.focusExcellent) return 'var(--accent-green, #22c55e)';
  if (progress >= b.focusGood) return 'var(--accent-yellow, #f59e0b)';
  if (progress >= b.focusNeutral) return 'var(--accent-orange, #f97316)';
  return 'var(--accent-red, #ef4444)';
}

export function energyLabel(energy: number): string {
  const b = bands();
  if (energy >= b.energyHigh) return 'High';
  if (energy >= b.energyMedium) return 'Medium';
  return 'Low';
}

export function classifyProductivityRatio(ratio: number): 'high' | 'medium' | 'low' {
  const b = bands();
  if (ratio > b.productivityRatioHigh) return 'high';
  if (ratio > b.productivityRatioMedium) return 'medium';
  return 'low';
}

export function productivityRatioColor(ratio: number): string {
  const tier = classifyProductivityRatio(ratio);
  switch (tier) {
    case 'high': return '#22c55e';
    case 'medium': return '#eab308';
    case 'low': return '#ef4444';
  }
}

export function cognitiveLoadColor(load: 'clear' | 'moderate' | 'overloaded'): string {
  switch (load) {
    case 'clear': return 'var(--accent-green, #22c55e)';
    case 'moderate': return 'var(--accent-yellow, #f59e0b)';
    case 'overloaded': return 'var(--accent-red, #ef4444)';
  }
}
