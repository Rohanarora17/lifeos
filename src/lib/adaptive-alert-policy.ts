import type { Alert, Severity } from './notifications';
import type { PersonalizationSnapshot } from './personalization-context';

export interface AdaptiveAlertCenterPolicy {
  posture: 'normal' | 'quiet' | 'urgent_only';
  reason: string;
  emptyState: string;
  visibleSeverities: Severity[];
  quietedCount: number;
  summary: string;
}

function severityRank(severity: string): number {
  if (severity === 'urgent') return 3;
  if (severity === 'warning') return 2;
  return 1;
}

function derivePosture(snapshot: PersonalizationSnapshot): Pick<AdaptiveAlertCenterPolicy, 'posture' | 'reason' | 'visibleSeverities' | 'emptyState'> {
  if (snapshot.feedback.alertFatigueLevel === 'high' && snapshot.moment.mode !== 'deadline_pressure') {
    return {
      posture: 'urgent_only',
      reason: `recent alert volume is high (${snapshot.feedback.recentAlerts} in 2h), so only urgent alerts should break through`,
      visibleSeverities: ['urgent'],
      emptyState: 'Quieting non-urgent notifications for now',
    };
  }

  if (snapshot.moment.mode === 'protect_focus') {
    return {
      posture: 'urgent_only',
      reason: 'active focus is worth protecting, so routine notifications stay out of the way',
      visibleSeverities: ['urgent'],
      emptyState: 'No routine notifications during this focus window',
    };
  }

  if (snapshot.moment.mode === 'recovery') {
    return {
      posture: 'quiet',
      reason: 'energy or mood is low, so only useful reminders should stay visible',
      visibleSeverities: ['warning', 'urgent'],
      emptyState: 'Only important nudges right now',
    };
  }

  if (snapshot.moment.mode === 'planning') {
    return {
      posture: 'quiet',
      reason: 'this is a planning/reflection window, so informational alerts are de-emphasized',
      visibleSeverities: ['warning', 'urgent'],
      emptyState: 'Nothing needs attention before planning',
    };
  }

  return {
    posture: 'normal',
    reason: snapshot.moment.guidance,
    visibleSeverities: ['info', 'warning', 'urgent'],
    emptyState: 'No new notifications',
  };
}

function summarize(snapshot: PersonalizationSnapshot, visibleCount: number, quietedCount: number, posture: AdaptiveAlertCenterPolicy['posture']): string {
  const pieces = [
    `${visibleCount} visible`,
    quietedCount > 0 ? `${quietedCount} quieted` : null,
    `mode ${snapshot.moment.mode}`,
    `alerts ${snapshot.feedback.alertFatigueLevel}`,
  ].filter(Boolean);

  if (posture === 'urgent_only') pieces.push('urgent only');
  return pieces.join(' · ');
}

export function buildAdaptiveAlertCenterPolicy(
  alerts: Alert[],
  snapshot: PersonalizationSnapshot
): { visibleAlerts: Alert[]; policy: AdaptiveAlertCenterPolicy } {
  const posture = derivePosture(snapshot);
  const visible = alerts
    .filter(alert => posture.visibleSeverities.includes(alert.severity))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  const quietedCount = Math.max(0, alerts.length - visible.length);

  return {
    visibleAlerts: visible,
    policy: {
      ...posture,
      quietedCount,
      summary: summarize(snapshot, visible.length, quietedCount, posture.posture),
    },
  };
}
