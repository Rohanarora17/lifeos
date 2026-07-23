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

function snapshot(overrides = {}) {
  return {
    surface: 'scheduler',
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
      },
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
    },
    activeSession: null,
    feedback: {
      alertFatigueLevel: 'low',
      recentAlerts: 0,
      helpfulRate: null,
      corrections30d: 0,
    },
    moment: {
      mode: 'normal',
      guidance: 'Balance commitments.',
    },
    intelligenceContext: '',
    memoryContext: '',
    ...overrides,
    today: {
      ...overrides.today,
      ...{
        date: overrides.today?.date ?? '2030-02-01',
        hour: overrides.today?.hour ?? 10,
        dayPhase: overrides.today?.dayPhase ?? 'morning',
        openTasks: overrides.today?.openTasks ?? 2,
        overdueTasks: overrides.today?.overdueTasks ?? 0,
        doingTasks: overrides.today?.doingTasks ?? [],
        uncheckedHabits: overrides.today?.uncheckedHabits ?? [],
        calendarEvents: overrides.today?.calendarEvents ?? [],
        recentDistractionMinutes: overrides.today?.recentDistractionMinutes ?? 0,
        plannedFocus: {
          plannedToday: 0,
          completedToday: 0,
          skippedToday: 0,
          nextTitle: null,
          nextMinutes: null,
          recentFollowThroughRate: null,
          ...overrides.today?.plannedFocus,
        },
      },
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
    moment: {
      mode: 'normal',
      guidance: 'Balance commitments.',
      ...overrides.moment,
    },
  };
}

const { buildAdaptiveCalendarPolicy } = require('../src/lib/adaptive-calendar-policy.ts');

const plannedPolicy = buildAdaptiveCalendarPolicy(snapshot({
  today: {
    plannedFocus: {
      plannedToday: 1,
      completedToday: 0,
      skippedToday: 0,
      nextTitle: 'Study ZK proofs',
      nextMinutes: 50,
      recentFollowThroughRate: 0.4,
    },
  },
}), 'today', 0);
assert(plannedPolicy.emphasis === 'protect_focus', `Expected protect_focus emphasis, got ${plannedPolicy.emphasis}.`);
assert(plannedPolicy.headline.includes('Study ZK proofs'), 'Expected planned focus title in calendar headline.');
assert(plannedPolicy.emptyMessage.includes('Keep the space clear'), 'Expected empty state to protect planned focus.');

const recoveryPolicy = buildAdaptiveCalendarPolicy(snapshot({
  userState: { energy: 'low', mood: 'low' },
  moment: { mode: 'recovery', guidance: 'Use low friction.' },
}), 'today', 2);
assert(recoveryPolicy.emphasis === 'recover', `Expected recover emphasis, got ${recoveryPolicy.emphasis}.`);
assert(recoveryPolicy.subhead.includes('leave buffer'), 'Expected recovery policy to preserve calendar buffer.');

const deadlinePolicy = buildAdaptiveCalendarPolicy(snapshot({
  today: { overdueTasks: 1 },
  moment: { mode: 'deadline_pressure', guidance: 'Prioritize deadline relief.' },
}), 'today', 0);
assert(deadlinePolicy.emphasis === 'plan_focus', `Expected plan_focus emphasis, got ${deadlinePolicy.emphasis}.`);
assert(deadlinePolicy.emptyAction.includes('pressure block'), 'Expected deadline policy to schedule pressure block.');

const planningPolicy = buildAdaptiveCalendarPolicy(snapshot({
  moment: { mode: 'planning', guidance: 'Plan tomorrow.' },
}), 'upcoming', 0);
assert(planningPolicy.emphasis === 'sync_calendar', `Expected sync_calendar emphasis, got ${planningPolicy.emphasis}.`);
assert(planningPolicy.emptyMessage.includes('tomorrow planning'), 'Expected planning policy to mention tomorrow planning.');

console.log(JSON.stringify({
  ok: true,
  scenario: 'calendar policy adapts empty states and header guidance to day context',
  plannedHeadline: plannedPolicy.headline,
  recoverySubhead: recoveryPolicy.subhead,
  deadlineAction: deadlinePolicy.emptyAction,
  planningAction: planningPolicy.emptyAction,
}, null, 2));
