#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-planning-evening-'));
const dbPath = path.join(tempDir, 'lifeos.db');
process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';
process.env.LIFEOS_FAKE_GOOGLE_CALENDAR = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
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

function todayIst() {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function istDate(planDate, time) {
  return new Date(`${planDate}T${time}:00+05:30`);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000);
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const { composeEveningPlanningReminder } = require('../src/lib/notifications.ts');
const {
  generateNextDayPlan,
  updatePlannedFocusSession,
} = require('../src/lib/next-day-planner.ts');
const {
  endGuardianSession,
  startGuardianSession,
} = require('../src/lib/guardian-runtime.ts');
const { getTaskTimeProgress } = require('../src/lib/task-time-sessions.ts');

async function main() {
  const db = getDb();
  const planDate = addDays(todayIst(), 1);
  setSetting('morning_brief_time', '08:30');

  const taskResult = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Read distributed systems paper', 'todo', 'high', 'research', 'distributed systems', 'medium', 70, ?
    )
  `).run(planDate);
  const taskId = Number(taskResult.lastInsertRowid);

  db.prepare(`
    INSERT INTO calendar_events (id, title, description, start_time, end_time, location)
    VALUES ('planning_evening_busy', 'Morning appointment', 'Fixed commitment before focus', ?, ?, 'Clinic')
  `).run(
    istDate(planDate, '09:00').toISOString(),
    istDate(planDate, '10:00').toISOString()
  );

  db.prepare(`
    INSERT INTO daily_plans (plan_date, sleep_time, status)
    VALUES (?, '02:00', 'draft')
  `).run(planDate);

  const draftReminder = composeEveningPlanningReminder();
  assert(draftReminder.shouldSend === true, 'Expected draft evening reminder to send.');
  assert(draftReminder.message.includes('Tomorrow has a draft'), 'Expected reminder to recognize existing draft.');
  assert(draftReminder.message.includes('wake estimate'), 'Expected reminder to ask for missing wake estimate.');
  assert(draftReminder.message.includes("tomorrow's main target"), 'Expected reminder to ask for tomorrow main target.');
  assert(draftReminder.message.includes('Morning appointment'), 'Expected reminder to include tomorrow calendar context.');
  assert(draftReminder.reason.includes('missing'), 'Expected reminder reason to cite missing fields.');

  const payload = await generateNextDayPlan({
    planDate,
    sleepTime: '02:00',
    wakeEstimate: '10:30',
    mood: 'medium',
    energy: 'medium',
    eveningNotes: 'Could not sleep until 2am, so tomorrow should start after the morning appointment.',
    tomorrowIntention: 'Read distributed systems paper and capture unclear concepts',
    selectedTaskIds: [taskId],
    syncCalendar: true,
    regenerate: true,
  });

  assert(payload.calendarConfigured === true, 'Expected fake Google Calendar mode to be configured.');
  assert(payload.plan.sleep_time === '02:00', 'Expected late sleep time to persist.');
  assert(payload.plan.wake_estimate === '10:30', 'Expected shifted wake estimate to persist.');
  assert(payload.plan.tomorrow_intention.includes('distributed systems'), 'Expected tomorrow intention to persist.');
  assert(payload.sessions.length >= 1, 'Expected planning evening to create focus sessions.');
  assert(payload.sessions.every(session => session.calendar_status === 'created'), 'Expected generated sessions to create calendar events.');
  assert(payload.sessions.every(session => session.calendar_event_id?.startsWith('fake_gcal_')), 'Expected fake calendar event ids on sessions.');

  const first = payload.sessions[0];
  assert(first.task_id === taskId, `Expected planned session to target task ${taskId}, got ${first.task_id}.`);
  assert(new Date(first.planned_start) >= istDate(planDate, '10:30'), 'Expected first focus block after shifted wake estimate.');
  assert(
    !(new Date(first.planned_start) < istDate(planDate, '10:00') && new Date(first.planned_end) > istDate(planDate, '09:00')),
    'Expected first focus block not to overlap the morning appointment.'
  );

  const reviewReminder = composeEveningPlanningReminder();
  assert(reviewReminder.shouldSend === true, 'Expected evening reminder to still be available for review.');
  assert(reviewReminder.message.includes('planned focus block'), 'Expected reminder to switch from intake to planned-block review.');
  assert(reviewReminder.message.includes(first.title), 'Expected reminder to name the first planned focus block.');
  assert(
    reviewReminder.reason.includes('asks only for changes') || reviewReminder.reason.includes('anchored to existing next-day plan'),
    'Expected reminder reason to anchor to existing next-day plan.'
  );

  const movedStart = addMinutes(istDate(planDate, '13:00'), 0);
  const movedEnd = addMinutes(movedStart, first.duration_minutes + 10);
  const originalEventId = first.calendar_event_id;
  const updated = await updatePlannedFocusSession(first.id, {
    title: `${first.title} adjusted after evening review`,
    plannedStart: movedStart.toISOString(),
    plannedEnd: movedEnd.toISOString(),
    syncCalendar: true,
  });

  assert(updated, 'Expected planned session edit to return updated row.');
  assert(updated.calendar_event_id === originalEventId, 'Expected edit to retain the calendar event id.');
  assert(updated.calendar_status === 'synced', `Expected edit to sync calendar event, got ${updated.calendar_status}.`);
  assert(updated.title.endsWith('evening review'), 'Expected edited title to persist.');
  assert(new Date(updated.planned_start).getTime() === movedStart.getTime(), 'Expected edited start time to persist.');
  assert(updated.duration_minutes === first.duration_minutes + 10, 'Expected edited duration to persist.');

  const softWatch = db.prepare(`
    SELECT target_title, intended_start_at, planned_minutes, calendar_event_id
    FROM soft_watch_commitments
    WHERE id = ?
  `).get(first.soft_watch_id);
  assert(softWatch.target_title === updated.title, 'Expected soft watch title to sync with edit.');
  assert(softWatch.intended_start_at === movedStart.getTime(), 'Expected soft watch start to sync with edit.');
  assert(softWatch.planned_minutes === updated.duration_minutes, 'Expected soft watch duration to sync with edit.');
  assert(softWatch.calendar_event_id === originalEventId, 'Expected soft watch to retain calendar event id.');

  const originalDateNow = Date.now;
  Date.now = () => movedStart.getTime();
  let started;
  try {
    started = startGuardianSession({
      topic: updated.title,
      durationMinutes: updated.duration_minutes,
      mood: 'medium',
    });
  } finally {
    Date.now = originalDateNow;
  }
  assert(started?.sessionId, 'Expected edited planning-evening Guardian session to start.');

  const locked = db.prepare(`
    SELECT status, locked_in_session_id
    FROM soft_watch_commitments
    WHERE id = ?
  `).get(first.soft_watch_id);
  assert(locked.status === 'locked_in', `Expected edited soft watch locked_in, got ${locked.status}.`);
  assert(locked.locked_in_session_id === started.sessionId, 'Expected edited soft watch to lock to the started session.');

  Date.now = () => movedStart.getTime() + updated.duration_minutes * 60_000;
  try {
    const ended = endGuardianSession(started.sessionId);
    assert(ended?.state === 'COMPLETE', `Expected edited planning session complete, got ${ended?.state}.`);
  } finally {
    Date.now = originalDateNow;
  }

  const completedSession = db.prepare(`
    SELECT status
    FROM planned_focus_sessions
    WHERE id = ?
  `).get(updated.id);
  assert(completedSession.status === 'completed', `Expected edited planned session completed, got ${completedSession.status}.`);

  const completedTask = await waitFor(() => {
    const row = db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get(taskId);
    return row.status === 'done' ? row : null;
  }, 'Expected edited planning-evening focus minutes to complete the linked task.');
  const progress = getTaskTimeProgress(taskId);
  assert(progress.creditedMinutes === updated.duration_minutes, `Expected ${updated.duration_minutes} credited minutes, got ${progress.creditedMinutes}.`);
  assert(progress.remainingMinutes === 0, `Expected no remaining planning task minutes, got ${progress.remainingMinutes}.`);
  assert(Boolean(completedTask.completed_at), 'Expected planning-evening task completion timestamp.');

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'planning evening collects missing details, schedules tomorrow, keeps edits synced, and completes linked time',
    planDate,
    draftReminder: draftReminder.reason,
    sessionsCreated: payload.sessions.length,
    firstSessionTitle: first.title,
    updatedSessionId: updated.id,
    retainedCalendarEventId: originalEventId,
    creditedMinutes: progress.creditedMinutes,
    taskStatus: completedTask.status,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
