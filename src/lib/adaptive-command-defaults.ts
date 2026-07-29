import { getIntelligenceProfile } from './intelligence';
import { getDb } from './db';
import type { PersonalizationSnapshot } from './personalization-context';
import { getLearningPhaseState } from './history-epoch';

function recentSessionMedianMinutes(): number | null {
  try {
    const rows = getDb().prepare(`
      SELECT elapsed_minutes
      FROM guardian_session_summaries
      WHERE elapsed_minutes IS NOT NULL AND elapsed_minutes > 0
      ORDER BY completed_at DESC
      LIMIT 15
    `).all() as Array<{ elapsed_minutes: number }>;
    if (rows.length === 0) return null;
    const values = rows
      .map(row => Math.round(Number(row.elapsed_minutes)))
      .filter(value => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    if (values.length === 0) return null;
    return values[Math.floor(values.length / 2)];
  } catch {
    return null;
  }
}

export function getAdaptiveSessionMinutes(explicitMinutes?: unknown): number {
  return getAdaptiveSessionMinuteDecision(explicitMinutes).minutes;
}

export function getAdaptiveSessionMinuteDecision(
  explicitMinutes?: unknown,
  snapshot?: PersonalizationSnapshot,
): { minutes: number; reason: string; source: 'explicit' | 'adaptive' } {
  const explicit = Number(explicitMinutes);
  if (Number.isFinite(explicit) && explicit > 0) {
    return {
      minutes: Math.max(5, Math.min(240, Math.round(explicit))),
      reason: 'using the duration you explicitly asked for',
      source: 'explicit',
    };
  }

  const learning = getLearningPhaseState();
  if (learning.active) {
    return {
      minutes: 45,
      reason: `default 45m while learning (${learning.postEpochSessions} sessions this run) — not a learned sprint yet`,
      source: 'adaptive',
    };
  }

  const profile = getIntelligenceProfile();
  const learned =
    profile.adaptiveThresholds?.sessionDurationSweetSpot ||
    profile.optimalSessionMinutes ||
    recentSessionMedianMinutes() ||
    45;

  let multiplier = 1;
  const reasons = [`learned ${Math.round(learned)}m baseline`];

  if (snapshot?.moment.mode === 'recovery' || snapshot?.userState.energy === 'low' || snapshot?.userState.mood === 'low') {
    multiplier *= 0.75;
    reasons.push('shortened for recovery/low energy');
  } else if (snapshot?.moment.mode === 'deadline_pressure') {
    multiplier *= 1.1;
    reasons.push('slightly extended for deadline pressure');
  } else if (snapshot?.moment.mode === 'protect_focus') {
    multiplier *= 1.05;
    reasons.push('preserved because this is a strong focus window');
  }

  if (snapshot?.feedback.alertFatigueLevel === 'high') {
    multiplier *= 0.9;
    reasons.push('kept tighter because alert fatigue is high');
  }

  const minutes = Math.max(15, Math.min(180, Math.round(learned * multiplier)));
  return {
    minutes,
    reason: reasons.join('; '),
    source: 'adaptive',
  };
}

export function getAdaptiveSessionMinutesLabel(explicitMinutes?: unknown): string {
  const decision = getAdaptiveSessionMinuteDecision(explicitMinutes);
  return explicitMinutes === undefined || explicitMinutes === null || explicitMinutes === ''
    ? `${decision.minutes}m adaptive default`
    : `${decision.minutes}m`;
}

export function formatCommandMomentLine(snapshot: PersonalizationSnapshot): string {
  const modeLabel: Record<string, string> = {
    protect_focus: 'protect focus',
    deadline_pressure: 'deadline pressure',
    recovery: 'recovery mode',
    planning: 'planning mode',
    normal: 'balanced mode',
  };
  const mode = modeLabel[snapshot.moment.mode] || snapshot.moment.mode;
  const goal = snapshot.userState.standupGoal
    ? ` Today: ${snapshot.userState.standupGoal.slice(0, 80)}.`
    : '';
  const pressure = snapshot.today.overdueTasks > 0
    ? ` ${snapshot.today.overdueTasks} overdue task${snapshot.today.overdueTasks === 1 ? '' : 's'}.`
    : '';
  return `Mode: ${mode}.${goal}${pressure}`;
}
