#!/usr/bin/env node

const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function baseSnapshot(overrides = {}) {
  return {
    surface: 'analytics',
    generatedAt: '2030-02-01T10:00:00.000Z',
    today: {
      date: '2030-02-01',
      hour: 10,
      dayPhase: 'morning',
      openTasks: 2,
      overdueTasks: 0,
      doingTasks: [],
      uncheckedHabits: [],
      calendarEvents: [],
      recentDistractionMinutes: 0,
      plannedFocus: {
        plannedToday: 0,
        completedToday: 0,
        skippedToday: 0,
        nextTitle: null,
        nextMinutes: null,
        recentFollowThroughRate: null,
        ...overrides.today?.plannedFocus,
      },
      ...overrides.today,
    },
    userState: {
      narrative: '',
      standupGoal: null,
      mood: 'medium',
      energy: 'medium',
      coachingStyle: 'balanced',
      focusTrend: 'stable',
      peakFocusHours: [10, 15],
      nextBestFocusWindow: '10:00-12:00',
      ...overrides.userState,
    },
    activeSession: overrides.activeSession ?? null,
    feedback: {
      alertFatigueLevel: 'low',
      recentAlerts: 0,
      helpfulRate: null,
      corrections30d: 0,
      ...overrides.feedback,
    },
    moment: {
      mode: 'normal',
      guidance: 'Balance commitments.',
      ...overrides.moment,
    },
    intelligenceContext: '',
    memoryContext: '',
  };
}

const stats = {
  productive_minutes: 45,
  distraction_minutes: 20,
  neutral_minutes: 8,
  total_minutes: 73,
  total_activities: 12,
};

const { buildAdaptiveActivityPolicy } = require('../src/lib/adaptive-activity-policy.ts');

const planned = buildAdaptiveActivityPolicy(baseSnapshot({
  today: {
    plannedFocus: {
      plannedToday: 1,
      completedToday: 0,
      skippedToday: 0,
      nextTitle: 'Read ZK paper',
      nextMinutes: 50,
      recentFollowThroughRate: 0.4,
    },
  },
}), stats);
assert(planned.posture === 'protect_focus', `Expected protect_focus posture, got ${planned.posture}.`);
assert(planned.headline.includes('Read ZK paper'), 'Expected planned task title in activity headline.');
assert(planned.productiveLabel === 'Useful for plan', 'Expected planned focus metric label.');

const recovery = buildAdaptiveActivityPolicy(baseSnapshot({
  userState: { energy: 'low', mood: 'low' },
  moment: { mode: 'recovery', guidance: 'Use low friction.' },
}), stats);
assert(recovery.posture === 'recovery_capacity', `Expected recovery posture, got ${recovery.posture}.`);
assert(recovery.interpretation.includes('Low-capacity days'), 'Expected recovery interpretation.');

const deadline = buildAdaptiveActivityPolicy(baseSnapshot({
  today: { overdueTasks: 1 },
  moment: { mode: 'deadline_pressure', guidance: 'Prioritize pressure relief.' },
}), stats);
assert(deadline.posture === 'deadline_relief', `Expected deadline posture, got ${deadline.posture}.`);
assert(deadline.distractionLabel === 'Pressure leak', 'Expected deadline distraction label.');

const planning = buildAdaptiveActivityPolicy(baseSnapshot({
  moment: { mode: 'planning', guidance: 'Plan tomorrow.' },
}), null);
assert(planning.posture === 'planning_signal', `Expected planning posture, got ${planning.posture}.`);
assert(planning.emptyMessage.includes('tomorrow planning'), 'Expected planning empty state to mention tomorrow planning.');

console.log(JSON.stringify({
  ok: true,
  scenario: 'activity policy adapts labels and empty states to day context',
  plannedHeadline: planned.headline,
  recoveryHeadline: recovery.headline,
  deadlineLabel: deadline.distractionLabel,
  planningEmpty: planning.emptyTitle,
}, null, 2));
