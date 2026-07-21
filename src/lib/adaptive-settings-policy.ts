import { getAdaptiveBands } from './adaptive-bands';
import { getAdaptiveSessionMinutes } from './adaptive-command-defaults';
import { getAdaptiveRewardPolicy } from './adaptive-rewards';
import type { PersonalizationSnapshot } from './personalization-context';

export interface AdaptiveSettingsPolicy {
  mode: PersonalizationSnapshot['moment']['mode'];
  guidance: string;
  energy: PersonalizationSnapshot['userState']['energy'];
  mood: PersonalizationSnapshot['userState']['mood'];
  alertFatigueLevel: PersonalizationSnapshot['feedback']['alertFatigueLevel'];
  focusTrend: PersonalizationSnapshot['userState']['focusTrend'];
  nextBestFocusWindow: string;
  plannedFocus: PersonalizationSnapshot['today']['plannedFocus'];
  nudgeThresholdMinutes: number;
  nudgeReason: string;
  sessionMinutes: number;
  dailyCapacityMinutes: number;
  focusBands: {
    excellent: number;
    good: number;
    neutral: number;
  };
  rewardMultiplier: number;
  rewardGuidance: string;
  scheduleGuidance: string;
  overrideNote: string;
  recommendedOverrides: Array<{
    key: string;
    value: string;
    label: string;
    reason: string;
    currentValue: string | null;
  }>;
}

function parseMinutes(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function computeNudgeThreshold(
  baseThreshold: number,
  snapshot: PersonalizationSnapshot,
): { threshold: number; reason: string } {
  let threshold = baseThreshold;
  const reasons = [`base override ${baseThreshold}m`];

  if (snapshot.moment.mode === 'deadline_pressure') {
    threshold = Math.max(4, threshold - 4);
    reasons.push('deadline pressure lowers tolerance');
  } else if (snapshot.moment.mode === 'recovery') {
    threshold += 5;
    reasons.push('recovery mode adds patience');
  } else if (snapshot.moment.mode === 'protect_focus') {
    threshold += 4;
    reasons.push('protected focus avoids extra pings');
  } else if (snapshot.moment.mode === 'planning') {
    threshold += 2;
    reasons.push('planning mode allows slower context review');
  }

  if (snapshot.feedback.alertFatigueLevel === 'high') {
    threshold += 5;
    reasons.push('alert fatigue high');
  }

  if (snapshot.today.recentDistractionMinutes >= 30 && snapshot.moment.mode !== 'recovery') {
    threshold = Math.max(4, threshold - 3);
    reasons.push('recent distraction is elevated');
  }

  return {
    threshold: Math.max(3, Math.round(threshold)),
    reason: reasons.join('; '),
  };
}

function scheduleGuidance(snapshot: PersonalizationSnapshot): string {
  if (snapshot.moment.mode === 'protect_focus') {
    return 'Scheduled jobs should stay quiet during active focus unless they reduce risk.';
  }
  if (snapshot.moment.mode === 'deadline_pressure') {
    return 'Scheduler can run deadline-relief checks even when lower-priority reports wait.';
  }
  if (snapshot.moment.mode === 'recovery') {
    return 'Morning and reminder jobs should use gentler timing and avoid piling on.';
  }
  if (snapshot.moment.mode === 'planning') {
    return 'Evening summaries and planning jobs are more useful than new interruptions.';
  }
  return 'Scheduler balances configured times with learned focus, fatigue, and task pressure.';
}

export function buildAdaptiveSettingsPolicy(
  settings: Record<string, string>,
  snapshot: PersonalizationSnapshot,
): AdaptiveSettingsPolicy {
  const bands = getAdaptiveBands();
  const baseNudge = parseMinutes(settings.nudge_threshold_minutes, 15);
  const nudge = computeNudgeThreshold(baseNudge, snapshot);
  const rewards = getAdaptiveRewardPolicy(snapshot);
  const productiveHourXp = Math.max(10, Math.round((30 * rewards.coinMultiplier) / 5) * 5);
  const recommendations: AdaptiveSettingsPolicy['recommendedOverrides'] = [];

  if (String(nudge.threshold) !== String(settings.nudge_threshold_minutes ?? '')) {
    recommendations.push({
      key: 'nudge_threshold_minutes',
      value: String(nudge.threshold),
      label: 'Use current adaptive nudge threshold',
      reason: nudge.reason,
      currentValue: settings.nudge_threshold_minutes ?? null,
    });
  }

  if (String(productiveHourXp) !== String(settings.xp_per_productive_hour ?? '')) {
    recommendations.push({
      key: 'xp_per_productive_hour',
      value: String(productiveHourXp),
      label: 'Align productive-hour XP with reward policy',
      reason: rewards.earningGuidance,
      currentValue: settings.xp_per_productive_hour ?? null,
    });
  }

  if (
    snapshot.today.plannedFocus.nextMinutes &&
    String(snapshot.today.plannedFocus.nextMinutes) !== String(settings.default_focus_minutes ?? '')
  ) {
    recommendations.push({
      key: 'default_focus_minutes',
      value: String(snapshot.today.plannedFocus.nextMinutes),
      label: 'Match default focus length to the next planned block',
      reason: `next planned focus is ${snapshot.today.plannedFocus.nextTitle ?? 'the active plan'} for ${snapshot.today.plannedFocus.nextMinutes}m`,
      currentValue: settings.default_focus_minutes ?? null,
    });
  }

  return {
    mode: snapshot.moment.mode,
    guidance: snapshot.moment.guidance,
    energy: snapshot.userState.energy,
    mood: snapshot.userState.mood,
    alertFatigueLevel: snapshot.feedback.alertFatigueLevel,
    focusTrend: snapshot.userState.focusTrend,
    nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    plannedFocus: snapshot.today.plannedFocus,
    nudgeThresholdMinutes: nudge.threshold,
    nudgeReason: nudge.reason,
    sessionMinutes: getAdaptiveSessionMinutes(),
    dailyCapacityMinutes: Math.round(bands.dailyCapacityMinutes),
    focusBands: {
      excellent: Math.round(bands.focusExcellent),
      good: Math.round(bands.focusGood),
      neutral: Math.round(bands.focusNeutral),
    },
    rewardMultiplier: rewards.coinMultiplier,
    rewardGuidance: rewards.earningGuidance,
    scheduleGuidance: scheduleGuidance(snapshot),
    overrideNote: 'Saved settings are treated as guardrails or manual overrides; runtime policy still adapts by mode, feedback, and recent behavior.',
    recommendedOverrides: recommendations,
  };
}
