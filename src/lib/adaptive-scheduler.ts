import type { PersonalizationSnapshot } from './personalization-context';

export type AdaptiveJobName =
  | 'alert_engine'
  | 'uil_synthesis'
  | 'continuity_guardian'
  | 'morning_checkin'
  | 'evening_reminder'
  | 'next_day_plan_refresh'
  | 'deep_analysis'
  | 'weekly_reckoning'
  | string;

export interface AdaptiveScheduleDecision {
  run: boolean;
  reason: string;
}

export function decideAdaptiveJobRun(
  jobName: AdaptiveJobName,
  snapshot: PersonalizationSnapshot,
): AdaptiveScheduleDecision {
  const hasDeadlinePressure =
    snapshot.moment.mode === 'deadline_pressure' ||
    snapshot.today.overdueTasks > 0;
  const inFocusSession = snapshot.activeSession !== null;
  const alertFatigueHigh = snapshot.feedback.alertFatigueLevel === 'high';

  if (jobName === 'uil_synthesis') {
    if (snapshot.moment.mode === 'protect_focus') {
      return { run: false, reason: 'deferred UIL synthesis to protect active focus' };
    }
    return { run: true, reason: `UIL synthesis allowed in ${snapshot.moment.mode}` };
  }

  if (jobName === 'continuity_guardian') {
    if (inFocusSession) {
      return { run: false, reason: 'active Guardian session already owns interventions' };
    }
    if (alertFatigueHigh && !hasDeadlinePressure) {
      return { run: false, reason: 'recent alert fatigue is high and no deadline pressure is present' };
    }
    if (snapshot.moment.mode === 'recovery' && snapshot.today.hour < 12) {
      return { run: false, reason: 'morning recovery mode: avoid proactive continuity nudges' };
    }
    return { run: true, reason: `continuity check allowed in ${snapshot.moment.mode}` };
  }

  if (jobName === 'alert_engine') {
    if (alertFatigueHigh && !hasDeadlinePressure && !inFocusSession) {
      return { run: false, reason: 'skipped alert engine cycle due to alert fatigue without urgent context' };
    }
    return { run: true, reason: `alert engine allowed; mode=${snapshot.moment.mode}` };
  }

  if (jobName === 'morning_checkin') {
    if (inFocusSession && snapshot.moment.mode === 'protect_focus') {
      return { run: false, reason: 'morning check-in deferred while active focus is protected' };
    }
    return { run: true, reason: `morning check-in allowed in ${snapshot.moment.mode}` };
  }

  if (jobName === 'evening_reminder') {
    if (alertFatigueHigh && snapshot.today.openTasks === 0) {
      return { run: false, reason: 'evening reminder skipped because alert fatigue is high and there is no open-task pressure' };
    }
    return { run: true, reason: `evening reminder allowed in ${snapshot.moment.mode}` };
  }

  if (jobName === 'next_day_plan_refresh') {
    if (inFocusSession && snapshot.moment.mode === 'protect_focus') {
      return { run: false, reason: 'next-day plan refresh deferred while active focus is protected' };
    }
    return { run: true, reason: `next-day plan refresh allowed in ${snapshot.moment.mode}` };
  }

  if (jobName === 'deep_analysis') {
    if (inFocusSession) {
      return { run: false, reason: 'deep analysis deferred during active session' };
    }
    return { run: true, reason: `deep analysis allowed in ${snapshot.moment.mode}` };
  }

  return { run: true, reason: 'no adaptive gate for this job' };
}
