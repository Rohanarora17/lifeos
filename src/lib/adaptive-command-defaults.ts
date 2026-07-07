import { getIntelligenceProfile } from './intelligence';
import { getDb } from './db';
import type { PersonalizationSnapshot } from './personalization-context';

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
  const explicit = Number(explicitMinutes);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(5, Math.min(240, Math.round(explicit)));
  }

  const profile = getIntelligenceProfile();
  const learned =
    profile.adaptiveThresholds?.sessionDurationSweetSpot ||
    profile.optimalSessionMinutes ||
    recentSessionMedianMinutes() ||
    45;

  return Math.max(15, Math.min(180, Math.round(learned)));
}

export function getAdaptiveSessionMinutesLabel(explicitMinutes?: unknown): string {
  const minutes = getAdaptiveSessionMinutes(explicitMinutes);
  return explicitMinutes === undefined || explicitMinutes === null || explicitMinutes === ''
    ? `${minutes}m learned default`
    : `${minutes}m`;
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
