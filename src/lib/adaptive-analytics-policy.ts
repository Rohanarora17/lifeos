import type { PersonalizationSnapshot } from './personalization-context';

export interface AnalyticsTrendDay {
  date: string;
  xp_earned?: number | null;
  productive_minutes?: number | null;
  distraction_minutes?: number | null;
  tasks_completed?: number | null;
  habits_completed?: number | null;
}

export interface AdaptiveAnalyticsDay {
  date: string;
  posture: 'stretch' | 'steady' | 'minimum' | 'recovery';
  productiveTargetMinutes: number;
  distractionBudgetMinutes: number;
  productivityRatio: number;
  capacityFit: 'above_capacity' | 'on_track' | 'under_capacity' | 'insufficient_signal';
  reason: string;
}

export interface AdaptiveAnalyticsPolicy {
  mode: PersonalizationSnapshot['moment']['mode'];
  lensTitle: string;
  lensSummary: string;
  primaryMetric: 'capacity_fit' | 'deadline_relief' | 'recovery_stability' | 'focus_protection' | 'tomorrow_setup';
  productiveTargetMinutes: number;
  distractionBudgetMinutes: number;
  xpBaseline: number;
  plannedFocus: PersonalizationSnapshot['today']['plannedFocus'];
  analysisWindowDays: number;
  days: AdaptiveAnalyticsDay[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function modeLens(snapshot: PersonalizationSnapshot): Pick<AdaptiveAnalyticsPolicy, 'lensTitle' | 'lensSummary' | 'primaryMetric'> {
  if (snapshot.moment.mode === 'recovery') {
    return {
      lensTitle: 'Capacity, not guilt',
      lensSummary: 'Today should be read against energy and mood. Minimum viable progress counts when recovery is active.',
      primaryMetric: 'recovery_stability',
    };
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    return {
      lensTitle: 'Deadline relief first',
      lensSummary: 'Charts should emphasize whether time went toward useful pressure relief, not just raw activity.',
      primaryMetric: 'deadline_relief',
    };
  }
  if (snapshot.moment.mode === 'protect_focus') {
    return {
      lensTitle: 'Protect the signal',
      lensSummary: 'Strong focus is the scarce state. Analytics should explain what preserved or interrupted it.',
      primaryMetric: 'focus_protection',
    };
  }
  if (snapshot.moment.mode === 'planning') {
    return {
      lensTitle: 'Use today to plan tomorrow',
      lensSummary: 'The most useful pattern is what tomorrow should inherit, avoid, or schedule differently.',
      primaryMetric: 'tomorrow_setup',
    };
  }
  return {
    lensTitle: 'Personal baseline view',
    lensSummary: 'Compare each day against your learned capacity instead of a generic productivity ideal.',
    primaryMetric: 'capacity_fit',
  };
}

function postureFor(snapshot: PersonalizationSnapshot, ratio: number, productiveMinutes: number, target: number): AdaptiveAnalyticsDay['posture'] {
  if (snapshot.moment.mode === 'recovery' || snapshot.userState.energy === 'low') return 'recovery';
  if (productiveMinutes >= target * 1.1 && ratio >= 0.7) return 'stretch';
  if (productiveMinutes >= target * 0.65 && ratio >= 0.5) return 'steady';
  return 'minimum';
}

function capacityFit(productiveMinutes: number, target: number, totalMinutes: number): AdaptiveAnalyticsDay['capacityFit'] {
  if (totalMinutes <= 0) return 'insufficient_signal';
  if (productiveMinutes >= target * 1.15) return 'above_capacity';
  if (productiveMinutes >= target * 0.65) return 'on_track';
  return 'under_capacity';
}

function reasonFor(day: AnalyticsTrendDay, target: number, ratio: number, snapshot: PersonalizationSnapshot): string {
  const productive = Math.round(Number(day.productive_minutes ?? 0));
  const distraction = Math.round(Number(day.distraction_minutes ?? 0));
  if (productive + distraction === 0) return 'Not enough tracked activity to judge this day.';
  if (snapshot.moment.mode === 'recovery') {
    return `${productive}m productive against a ${target}m recovery-adjusted target; low-output days should inform capacity.`;
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    return `${productive}m productive with ${distraction}m distraction; judge this by deadline relief, not volume alone.`;
  }
  if (ratio < 0.5 && distraction > productive) {
    return `${distraction}m distraction outweighed ${productive}m productive time, so the useful question is what triggered the drift.`;
  }
  return `${productive}m productive against a ${target}m learned target.`;
}

export function buildAdaptiveAnalyticsPolicy(input: {
  snapshot: PersonalizationSnapshot;
  weekTrend: AnalyticsTrendDay[];
  dailyCapacityMinutes: number;
  recommendedSessionMinutes: number;
}): AdaptiveAnalyticsPolicy {
  const snapshot = input.snapshot;
  const lens = modeLens(snapshot);
  const productiveHistory = input.weekTrend
    .map(day => Number(day.productive_minutes ?? 0))
    .filter(value => value > 0);
  const distractionHistory = input.weekTrend
    .map(day => Number(day.distraction_minutes ?? 0))
    .filter(value => value > 0);
  const xpHistory = input.weekTrend
    .map(day => Number(day.xp_earned ?? 0))
    .filter(value => value > 0);

  let target = average(productiveHistory) || input.dailyCapacityMinutes || input.recommendedSessionMinutes;
  if (snapshot.moment.mode === 'recovery') target *= 0.7;
  else if (snapshot.moment.mode === 'deadline_pressure') target *= 1.1;
  else if (snapshot.moment.mode === 'planning') target *= 0.8;
  if (snapshot.userState.energy === 'low') target *= 0.85;

  const productiveTargetMinutes = Math.round(clamp(target, Math.max(15, input.recommendedSessionMinutes * 0.5), Math.max(30, input.dailyCapacityMinutes * 1.5)));
  const distractionBudgetBase = average(distractionHistory) || Math.max(10, productiveTargetMinutes * 0.25);
  const distractionBudgetMinutes = Math.round(clamp(
    snapshot.moment.mode === 'recovery' ? distractionBudgetBase * 1.2 : distractionBudgetBase,
    10,
    Math.max(15, productiveTargetMinutes),
  ));
  const xpBaseline = Math.round(average(xpHistory));

  return {
    mode: snapshot.moment.mode,
    ...lens,
    productiveTargetMinutes,
    distractionBudgetMinutes,
    xpBaseline,
    plannedFocus: snapshot.today.plannedFocus,
    analysisWindowDays: Math.max(1, input.weekTrend.length),
    days: input.weekTrend.map(day => {
      const productive = Number(day.productive_minutes ?? 0);
      const distraction = Number(day.distraction_minutes ?? 0);
      const total = productive + distraction;
      const ratio = total > 0 ? productive / total : 0;
      return {
        date: day.date,
        posture: postureFor(snapshot, ratio, productive, productiveTargetMinutes),
        productiveTargetMinutes,
        distractionBudgetMinutes,
        productivityRatio: Math.round(ratio * 100) / 100,
        capacityFit: capacityFit(productive, productiveTargetMinutes, total),
        reason: reasonFor(day, productiveTargetMinutes, ratio, snapshot),
      };
    }),
  };
}
