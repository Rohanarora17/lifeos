#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-next-day-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function istDate(planDate, time) {
  return new Date(`${planDate}T${time}:00+05:30`);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function parseRule(session) {
  return JSON.parse(session.rule_json);
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const {
  cancelPlannedFocusSession,
  generateNextDayPlan,
  updatePlannedFocusSession,
} = require('../src/lib/next-day-planner.ts');

async function main() {
  const db = getDb();
  const planDate = '2030-02-05';
  setSetting('morning_brief_time', '09:00');

  const zkTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Read ZK research paper', 'todo', 'critical', 'research', 'zero knowledge', 'high', 90, ?
    )
  `).run(planDate);
  const mathTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Math Academy probability drills', 'todo', 'high', 'math', 'probability', 'medium', 60, ?
    )
  `).run(planDate);
  const zkTaskId = Number(zkTask.lastInsertRowid);
  const mathTaskId = Number(mathTask.lastInsertRowid);

  db.prepare(`
    INSERT INTO calendar_events (id, title, description, start_time, end_time, location)
    VALUES ('calendar_busy_1', 'Existing meeting', 'Do not schedule focus here', ?, ?, 'Meet')
  `).run(
    istDate(planDate, '10:00').toISOString(),
    istDate(planDate, '11:00').toISOString()
  );

  const payload = await generateNextDayPlan({
    planDate,
    sleepTime: '23:30',
    wakeEstimate: '09:00',
    mood: 'medium',
    energy: 'high',
    eveningNotes: 'Late night yesterday, but tomorrow has a clean midday work window.',
    tomorrowIntention: 'Study zks and finish math academy drills',
    selectedTaskIds: [zkTaskId, mathTaskId],
    syncCalendar: true,
    regenerate: true,
  });

  assert(payload.plan, 'Expected a daily plan to be created.');
  assert(payload.plan.plan_date === planDate, `Expected plan date ${planDate}, got ${payload.plan.plan_date}.`);
  assert(payload.plan.sleep_time === '23:30', 'Expected sleep time to persist on the plan.');
  assert(payload.plan.wake_estimate === '09:00', 'Expected wake estimate to persist on the plan.');
  assert(payload.plan.tomorrow_intention.includes('Study zks'), 'Expected tomorrow intention to persist on the plan.');
  assert(payload.sessions.length >= 2, `Expected at least two planned sessions, got ${payload.sessions.length}.`);
  assert(payload.calendarConfigured === false, 'Fresh verifier DB should not report Google Calendar OAuth as configured.');

  const checkin = db.prepare(`
    SELECT sleep_time, wake_estimate, mood, energy, day_events, tomorrow_intention, raw_transcript
    FROM daily_checkins
    WHERE checkin_type = 'evening'
    ORDER BY id DESC
    LIMIT 1
  `).get();
  assert(checkin.sleep_time === '23:30', 'Expected evening check-in to capture sleep time.');
  assert(checkin.wake_estimate === '09:00', 'Expected evening check-in to capture wake estimate.');
  assert(checkin.energy === 'high', 'Expected evening check-in to capture energy.');
  assert(checkin.tomorrow_intention.includes('finish math academy'), 'Expected evening check-in to capture tomorrow intention.');
  assert(checkin.raw_transcript.includes('Planning date: 2030-02-05'), 'Expected check-in transcript to record planning date.');

  const sessionsByTask = new Map();
  for (const session of payload.sessions) {
    if (!sessionsByTask.has(session.task_id)) sessionsByTask.set(session.task_id, []);
    sessionsByTask.get(session.task_id).push(session);
    const start = new Date(session.planned_start);
    const end = new Date(session.planned_end);
    const busyStart = istDate(planDate, '10:00');
    const busyEnd = istDate(planDate, '11:00');
    assert(!(start < busyEnd && end > busyStart), `Session ${session.title} overlaps existing calendar event.`);
    assert(session.calendar_status === 'not_configured', 'Expected calendar status to stay not_configured without OAuth.');
    assert(session.reward_xp > 0, 'Expected planned session to have adaptive XP.');
    assert(session.reward_coins > 0, 'Expected planned session to have adaptive coins.');
  }

  assert(sessionsByTask.has(zkTaskId), 'Expected ZK task to receive at least one planned focus session.');
  assert(sessionsByTask.has(mathTaskId), 'Expected math task to receive at least one planned focus session.');

  const zkRules = sessionsByTask.get(zkTaskId).map(parseRule);
  const mathRules = sessionsByTask.get(mathTaskId).map(parseRule);
  assert(zkRules.some(rule => rule.mode === 'research_reading'), 'Expected ZK research task to use research_reading rules.');
  assert(zkRules.some(rule => rule.tools.includes('ChatGPT')), 'Expected research rules to include ChatGPT for concept follow-up.');
  assert(mathRules.some(rule => rule.mode === 'problem_practice'), 'Expected Math Academy task to use problem_practice rules.');
  assert(mathRules.some(rule => rule.tools.includes('Math Academy')), 'Expected math rules to include Math Academy.');

  const softWatchCount = db.prepare(`
    SELECT COUNT(*) as count
    FROM soft_watch_commitments
    WHERE source = 'next_day_plan' AND status = 'pending'
  `).get().count;
  assert(softWatchCount === payload.sessions.length, `Expected one pending soft watch per session, got ${softWatchCount}.`);

  const firstSession = payload.sessions[0];
  const movedStart = addMinutes(new Date(firstSession.planned_start), 45);
  const movedEnd = addMinutes(movedStart, firstSession.duration_minutes + 5);
  const updated = await updatePlannedFocusSession(firstSession.id, {
    title: `${firstSession.title} - revised`,
    plannedStart: movedStart.toISOString(),
    plannedEnd: movedEnd.toISOString(),
    syncCalendar: true,
  });
  assert(updated, 'Expected planned focus session update to return a row.');
  assert(updated.title.endsWith('- revised'), 'Expected updated session title to persist.');
  assert(updated.duration_minutes === firstSession.duration_minutes + 5, 'Expected updated duration to persist.');
  assert(updated.calendar_status === 'not_configured', 'Expected calendar status to remain not_configured after sync attempt without OAuth.');

  const updatedSoftWatch = db.prepare(`
    SELECT target_title, intended_start_at, planned_minutes, calendar_event_id
    FROM soft_watch_commitments
    WHERE id = ?
  `).get(firstSession.soft_watch_id);
  assert(updatedSoftWatch.target_title === updated.title, 'Expected soft watch title to stay in sync with session edit.');
  assert(updatedSoftWatch.intended_start_at === movedStart.getTime(), 'Expected soft watch start time to stay in sync with session edit.');
  assert(updatedSoftWatch.planned_minutes === updated.duration_minutes, 'Expected soft watch duration to stay in sync with session edit.');
  assert(updatedSoftWatch.calendar_event_id === null, 'Expected soft watch calendar event to stay empty without OAuth.');

  const cancelTarget = payload.sessions.find(session => session.id !== firstSession.id);
  assert(cancelTarget, 'Expected another session to cancel.');
  const cancelled = await cancelPlannedFocusSession(cancelTarget.id, true);
  assert(cancelled === true, 'Expected cancellation to succeed.');
  const cancelledRow = db.prepare('SELECT status, calendar_status FROM planned_focus_sessions WHERE id = ?').get(cancelTarget.id);
  const cancelledSoftWatch = db.prepare('SELECT status FROM soft_watch_commitments WHERE id = ?').get(cancelTarget.soft_watch_id);
  assert(cancelledRow.status === 'cancelled', 'Expected planned session status to become cancelled.');
  assert(cancelledSoftWatch.status === 'dismissed', 'Expected cancelled session soft watch to be dismissed.');

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'next-day planner persists adaptive sessions and keeps backend edits in sync',
    planDate,
    sessionsCreated: payload.sessions.length,
    sessionTypes: Array.from(new Set(payload.sessions.map(session => session.session_type))).sort(),
    updatedSessionId: updated.id,
    cancelledSessionId: cancelTarget.id,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
