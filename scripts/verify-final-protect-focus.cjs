#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-final-protect-focus-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function todayIst(baseNow = Date.now()) {
  return new Date(baseNow + 19_800_000).toISOString().slice(0, 10);
}

function istHour(baseNow = Date.now()) {
  return new Date(baseNow + 19_800_000).getHours();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, message, timeoutMs = 6_000) {
  const started = globalThis.performance?.now?.() ?? Date.now();
  while (((globalThis.performance?.now?.() ?? Date.now()) - started) < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(message);
}

function learnedProtectFocusProfile(hour) {
  return {
    version: 7,
    synthesizedAt: Date.now(),
    trigger: 'protect_focus_fixture',
    peakFocusHours: [hour],
    optimalSessionMinutes: 45,
    avgSessionFocusScore: 88,
    focusTrend: 'improving',
    totalFocusMinutesThisWeek: 180,
    energyByHour: { [hour]: 'high' },
    currentEnergyEstimate: 'high',
    energyPattern: `Best protected focus usually lands around ${hour}:00.`,
    topProductiveDomains: ['mathacademy.com', 'arxiv.org'],
    topDistractionDomains: ['youtube.com'],
    distractionTriggers: ['context switching during study blocks'],
    avoidancePatterns: ['opening optional reading before finishing the core proof'],
    strongTopics: ['zero knowledge proofs'],
    frictionTopics: ['unclear proof notation'],
    goalMomentum: {},
    taskCompletionRate: 0.82,
    activeGoalsSummary: ['Finish the ZK study block before optional browsing'],
    nextRecommendedTopic: 'ZK proof mechanics',
    habitStreakSummary: [],
    habitsAtRisk: [],
    standupGoalToday: 'Protect the ZK study block',
    moodToday: 'high',
    calendarEventsToday: [],
    recentStudyTopics: ['ZK proofs'],
    knowledgeGaps: ['pairing-based proof notation'],
    preferredCoachingStyle: 'direct',
    adaptiveThresholds: {
      focusDropAlertScore: 65,
      cognitiveLoadThreshold: 8,
      distractionAlertMinutes: 15,
      sessionDurationSweetSpot: 45,
      habitRiskDays: 2,
      focusGoodThreshold: 78,
      focusExcellentThreshold: 88,
      cognitiveLoadAdvice: 'Protect the active block before adding more tasks.',
      efficacyAdvice: 'Keep the block concrete and finish the planned target.',
    },
    currentNarrative: 'When a planned study block is live, routine nudges should stay out of the way.',
    coachingInsights: ['45 minute study blocks are working better than generic Pomodoros.'],
    nextBestFocusWindow: `${String(hour).padStart(2, '0')}:00`,
    weeklyProgressSummary: 'Protected focus blocks are the strongest learning signal this week.',
  };
}

const { getDb } = require('../src/lib/db.ts');
const { sendAlert } = require('../src/lib/notifications.ts');
const {
  createSoftWatchCommitment,
  endGuardianSession,
  startGuardianSession,
} = require('../src/lib/guardian-runtime.ts');
const { buildPersonalizationSnapshot } = require('../src/lib/personalization-context.ts');
const { getTaskTimeProgress } = require('../src/lib/task-time-sessions.ts');

async function main() {
  const db = getDb();
  const originalDateNow = Date.now;
  const baseNow = originalDateNow();
  const planDate = todayIst(baseNow);
  const peakHour = istHour(baseNow);

  db.prepare(`
    INSERT INTO user_intelligence_profile (profile_json, version, trigger)
    VALUES (?, 7, 'protect_focus_fixture')
  `).run(JSON.stringify(learnedProtectFocusProfile(peakHour)));

  db.prepare(`
    INSERT INTO calendar_events (id, title, start_time, end_time, location)
    VALUES ('calendar-protect-focus', 'Protected ZK study', ?, ?, 'Google Calendar')
  `).run(
    new Date(baseNow - 5 * 60_000).toISOString(),
    new Date(baseNow + 40 * 60_000).toISOString()
  );

  const taskResult = db.prepare(`
    INSERT INTO tasks (title, status, priority, task_type, course, estimated_minutes)
    VALUES ('Study ZK proof mechanics', 'todo', 'high', 'study', 'zero knowledge', 45)
  `).run();
  const taskId = Number(taskResult.lastInsertRowid);

  const planResult = db.prepare(`
    INSERT INTO daily_plans (plan_date, sleep_time, wake_estimate, mood, energy, tomorrow_intention, status)
    VALUES (?, '00:15', '08:45', 'high', 'high', 'Use the best 45m window for ZK study', 'active')
  `).run(planDate);
  const planId = Number(planResult.lastInsertRowid);

  const softWatch = createSoftWatchCommitment({
    targetTitle: 'Study ZK proof mechanics',
    taskId,
    intendedStartAt: baseNow - 5 * 60_000,
    plannedMinutes: 45,
    source: 'calendar',
    calendarEventId: 'calendar-protect-focus',
  });

  db.prepare(`
    INSERT INTO planned_focus_sessions (
      id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
      session_type, rule_json, reward_xp, reward_coins, soft_watch_id, calendar_event_id, status
    ) VALUES (
      'final-protect-focus-session', ?, ?, 'Study ZK proof mechanics', ?, ?, 45,
      'study', '{"mode":"research_reading","chunkMinutes":45}', 60, 30, ?, 'calendar-protect-focus', 'planned'
    )
  `).run(
    planId,
    taskId,
    new Date(baseNow - 5 * 60_000).toISOString(),
    new Date(baseNow + 40 * 60_000).toISOString(),
    softWatch.id
  );

  const originalConsoleLog = console.log;
  const alertLogs = [];
  console.log = (...args) => {
    alertLogs.push(args.join(' '));
    originalConsoleLog(...args);
  };

  const routineSuppressed = await sendAlert(
    'habit_streak',
    'Routine streak check.',
    'warning',
    { key: 'protect_focus_routine_warning', skipAiRewrite: true }
  );
  console.log = originalConsoleLog;

  assert(routineSuppressed === false, 'Expected routine warning alert to suppress during protected planned focus.');
  assert(
    alertLogs.some(line => (
      line.includes('suppressed routine alert during planned focus:')
      && line.includes('Study ZK proof mechanics')
    )),
    'Expected suppression reason to come from planned-focus protection.'
  );

  const routineRow = db.prepare('SELECT * FROM alerts WHERE type = ?').get('protect_focus_routine_warning');
  assert(!routineRow, 'Expected suppressed routine alert not to create an alert row.');

  const taskSent = await sendAlert(
    'task_reminder',
    'Time to study ZK proof mechanics.',
    'warning',
    {
      key: 'protect_focus_task_warning',
      skipAiRewrite: true,
      context: { taskId, title: 'Study ZK proof mechanics' },
    }
  );
  assert(taskSent === true, 'Expected task-specific warning to still send during protected focus.');
  const taskAlert = db.prepare('SELECT * FROM alerts WHERE type = ?').get('protect_focus_task_warning');
  assert(taskAlert, 'Expected task reminder alert row.');
  assert(
    taskAlert.message.includes("already on today's focus plan"),
    'Expected task reminder to link to the existing protected focus block.'
  );
  assert(
    taskAlert.adaptive_reason.includes('linked task reminder to planned focus session'),
    'Expected adaptive reason to explain task reminder focus-plan linking.'
  );

  const started = startGuardianSession({
    topic: 'Study ZK proof mechanics',
    durationMinutes: 45,
    mood: 'high',
  });
  assert(started?.sessionId, 'Expected Guardian session to start.');

  const locked = db.prepare(`
    SELECT status, locked_in_session_id
    FROM soft_watch_commitments
    WHERE id = ?
  `).get(softWatch.id);
  assert(locked.status === 'locked_in', `Expected soft watch locked_in, got ${locked.status}.`);
  assert(locked.locked_in_session_id === started.sessionId, 'Expected soft watch to lock to the active Guardian session.');

  const snapshot = buildPersonalizationSnapshot({
    surface: 'notification',
    includeThresholds: true,
    activeSession: {
      sessionId: started.sessionId,
      targetTitle: started.targetTitle,
      focusScore: 96,
      elapsedMinutes: 20,
    },
  });
  assert(snapshot.moment.mode === 'protect_focus', `Expected protect_focus mode, got ${snapshot.moment.mode}.`);
  assert(
    snapshot.today.plannedFocus.plannedToday === 1
      && snapshot.today.plannedFocus.nextTitle === 'Study ZK proof mechanics',
    'Expected personalization snapshot to include the active planned focus block.'
  );

  Date.now = () => baseNow + 45 * 60_000;
  try {
    const ended = endGuardianSession(started.sessionId);
    assert(ended?.state === 'COMPLETE', `Expected completed Guardian session, got ${ended?.state}.`);
  } finally {
    Date.now = originalDateNow;
  }

  const planned = db.prepare(`
    SELECT status
    FROM planned_focus_sessions
    WHERE id = 'final-protect-focus-session'
  `).get();
  assert(planned.status === 'completed', `Expected planned focus session completed, got ${planned.status}.`);

  const completedTask = await waitFor(() => {
    const row = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get(taskId);
    return row.status === 'done' ? row : null;
  }, 'Expected protected focus minutes to complete the linked task.');

  const progress = getTaskTimeProgress(taskId);
  assert(progress.creditedMinutes === 45, `Expected 45 credited minutes, got ${progress.creditedMinutes}.`);
  assert(progress.remainingMinutes === 0, `Expected no remaining minutes, got ${progress.remainingMinutes}.`);
  assert(Boolean(completedTask.completed_at), 'Expected completed task timestamp.');

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'protect-focus day suppresses routine nudges, links task reminders, enters protect_focus mode, and completes the time-target task',
    peakHour,
    routineSuppressed,
    taskAlertReason: taskAlert.adaptive_reason,
    momentMode: snapshot.moment.mode,
    plannedSessionStatus: planned.status,
    creditedMinutes: progress.creditedMinutes,
    taskStatus: completedTask.status,
  }, null, 2));

  process.exit(0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
