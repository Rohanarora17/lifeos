import type { PersonalizationSnapshot } from './personalization-context';

export interface AdaptiveInsightsPolicy {
  mode: PersonalizationSnapshot['moment']['mode'];
  guidance: string;
  energy: PersonalizationSnapshot['userState']['energy'];
  mood: PersonalizationSnapshot['userState']['mood'];
  focusTrend: PersonalizationSnapshot['userState']['focusTrend'];
  alertFatigueLevel: PersonalizationSnapshot['feedback']['alertFatigueLevel'];
  nextBestFocusWindow: string;
  lensTitle: string;
  lensSummary: string;
  recommendedAnalysis: string;
  insightTone: 'gentle' | 'direct' | 'urgent' | 'reflective';
  interpretationRules: string[];
  currentSignals: {
    openTasks: number;
    overdueTasks: number;
    recentDistractionMinutes: number;
    uncheckedHabits: number;
    activeSession: boolean;
  };
}

function modePolicy(snapshot: PersonalizationSnapshot): Pick<
  AdaptiveInsightsPolicy,
  'lensTitle' | 'lensSummary' | 'recommendedAnalysis' | 'insightTone' | 'interpretationRules'
> {
  if (snapshot.moment.mode === 'protect_focus') {
    return {
      lensTitle: 'Protect the work already in motion',
      lensSummary: 'Insights should stay brief and highlight patterns that preserve the current focus block.',
      recommendedAnalysis: 'Look for focus-window repeatability, interruption sources, and low-noise next actions.',
      insightTone: 'direct',
      interpretationRules: [
        'Treat strong focus as a scarce state to protect, not as permission to add more work.',
        'Prefer one actionable pattern over broad reflection while focus is active.',
        'De-prioritize curiosity-only insights until the session ends.',
      ],
    };
  }

  if (snapshot.moment.mode === 'deadline_pressure') {
    return {
      lensTitle: 'Reduce deadline risk first',
      lensSummary: 'Insights should explain what is blocking commitments and which pattern will unblock the day fastest.',
      recommendedAnalysis: 'Prioritize overdue tasks, distraction spikes, and mismatches between peak hours and deadline work.',
      insightTone: 'urgent',
      interpretationRules: [
        'Rank deadline relief above habit optimization or general productivity advice.',
        'Call out patterns that threaten overdue or in-progress work.',
        'Convert observations into the smallest useful next action.',
      ],
    };
  }

  if (snapshot.moment.mode === 'recovery') {
    return {
      lensTitle: 'Read low output as capacity data',
      lensSummary: 'Insights should separate true avoidance from low-energy recovery signals.',
      recommendedAnalysis: 'Find minimum viable progress patterns, recovery-friendly focus windows, and overload triggers.',
      insightTone: 'gentle',
      interpretationRules: [
        'Do not punish low output when energy or mood is low.',
        'Prefer low-friction actions and recovery-preserving routines.',
        'Surface overload patterns before recommending more intensity.',
      ],
    };
  }

  if (snapshot.moment.mode === 'planning') {
    return {
      lensTitle: 'Turn patterns into tomorrow setup',
      lensSummary: 'Insights should favor review, cleanup, and setup decisions over fresh pressure.',
      recommendedAnalysis: 'Look for tomorrow planning cues, unfinished loops, and best first-task candidates.',
      insightTone: 'reflective',
      interpretationRules: [
        'Use today as evidence for tomorrow instead of pushing late-day intensity.',
        'Highlight repeatable setup choices and cleanup opportunities.',
        'Prefer reflection and sequencing over intervention.',
      ],
    };
  }

  return {
    lensTitle: 'Balance momentum with context',
    lensSummary: 'Insights should weigh today, recent feedback, goals, energy, and learned focus windows together.',
    recommendedAnalysis: 'Compare recent behavior against personal baselines and current commitments.',
    insightTone: snapshot.userState.coachingStyle === 'gentle' ? 'gentle' : 'direct',
    interpretationRules: [
      'Avoid generic productivity advice when personal data can explain the pattern.',
      'Compare behavior against this person’s baseline, not a universal ideal.',
      'Tie insights to goals, current tasks, habits, or learned focus windows when available.',
    ],
  };
}

export function buildAdaptiveInsightsPolicy(
  snapshot: PersonalizationSnapshot,
): AdaptiveInsightsPolicy {
  const policy = modePolicy(snapshot);

  return {
    mode: snapshot.moment.mode,
    guidance: snapshot.moment.guidance,
    energy: snapshot.userState.energy,
    mood: snapshot.userState.mood,
    focusTrend: snapshot.userState.focusTrend,
    alertFatigueLevel: snapshot.feedback.alertFatigueLevel,
    nextBestFocusWindow: snapshot.userState.nextBestFocusWindow,
    currentSignals: {
      openTasks: snapshot.today.openTasks,
      overdueTasks: snapshot.today.overdueTasks,
      recentDistractionMinutes: snapshot.today.recentDistractionMinutes,
      uncheckedHabits: snapshot.today.uncheckedHabits.length,
      activeSession: snapshot.activeSession !== null,
    },
    ...policy,
  };
}
