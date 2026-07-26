#!/usr/bin/env node

const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function baseSnapshot(overrides = {}) {
  return {
    moment: {
      mode: 'normal',
      guidance: 'Balance the day from current signals.',
      ...(overrides.moment ?? {}),
    },
    today: {
      plannedFocus: {
        nextTitle: null,
        nextMinutes: null,
      },
      overdueTasks: 0,
      ...(overrides.today ?? {}),
    },
    userState: {
      energy: 'medium',
      mood: 'medium',
      nextBestFocusWindow: '10:30',
      standupGoal: null,
      ...(overrides.userState ?? {}),
    },
    feedback: {
      alertFatigueLevel: 'low',
      ...(overrides.feedback ?? {}),
    },
  };
}

const {
  formatTelegramDailyReportMessage,
  formatTelegramMenuMessage,
} = require('../src/lib/telegram-agent.ts');

function report(snapshot) {
  return formatTelegramDailyReportMessage({
    today: '2030-07-25',
    avgFocus: 82,
    sessions: 2,
    totalMinutes: 75,
    tasksDone: 1,
    tasksTotal: 3,
    habitsDone: 2,
    habitsTotal: 4,
    snapshot,
  });
}

function main() {
  const planned = baseSnapshot({
    today: {
      plannedFocus: {
        nextTitle: 'Study <ZK> rollups',
        nextMinutes: 45,
      },
      overdueTasks: 0,
    },
  });
  const plannedMenu = formatTelegramMenuMessage(planned);
  const plannedReport = report(planned);
  assert(plannedMenu.includes('Next planned focus'), 'Expected menu to mention planned focus.');
  assert(plannedMenu.includes('Study &lt;ZK&gt; rollups'), 'Expected menu to HTML-escape planned focus title.');
  assert(plannedReport.includes('Study &lt;ZK&gt; rollups'), 'Expected report to carry planned focus context.');
  assert(!plannedMenu.includes('What would you like to do?'), 'Expected menu to avoid the old static prompt.');

  const deadline = baseSnapshot({
    moment: {
      mode: 'deadline_pressure',
      guidance: 'Prioritize concrete deadline relief.',
    },
    today: {
      plannedFocus: { nextTitle: null, nextMinutes: null },
      overdueTasks: 2,
    },
  });
  const deadlineMenu = formatTelegramMenuMessage(deadline);
  const deadlineReport = report(deadline);
  assert(deadlineMenu.includes('/tasks'), 'Expected deadline menu to steer to ranked tasks.');
  assert(deadlineMenu.includes('deadline-relief'), 'Expected deadline menu to cite deadline relief.');
  assert(deadlineReport.includes('reduce deadline pressure'), 'Expected report to recommend deadline relief next.');

  const recovery = baseSnapshot({
    moment: {
      mode: 'recovery',
      guidance: 'Use low-friction recommendations.',
    },
    userState: {
      energy: 'low',
      mood: 'low',
      nextBestFocusWindow: '11:00',
      standupGoal: null,
    },
  });
  const recoveryMenu = formatTelegramMenuMessage(recovery);
  const recoveryReport = report(recovery);
  assert(recoveryMenu.includes('recovery-safe'), 'Expected recovery menu to bias to smaller work.');
  assert(recoveryMenu.includes('low energy'), 'Expected recovery menu to expose current energy.');
  assert(recoveryReport.includes('keep tomorrow lighter'), 'Expected report to preserve recovery context.');

  console.log(JSON.stringify({
    ok: true,
    scenario: 'telegram menu and report entrypoints adapt to current day context',
    plannedMenu,
    deadlineMenu,
    recoveryMenu,
  }, null, 2));
}

main();
