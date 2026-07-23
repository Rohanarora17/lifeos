#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-calendar-sync-'));
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

function istDate(planDate, time) {
  return new Date(`${planDate}T${time}:00+05:30`);
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const {
  cancelPlannedFocusSession,
  generateNextDayPlan,
  updatePlannedFocusSession,
} = require('../src/lib/next-day-planner.ts');

async function main() {
  const db = getDb();
  const planDate = '2030-03-12';
  setSetting('morning_brief_time', '08:30');

  const taskResult = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Implement calendar sync smoke test', 'todo', 'critical', 'coding', 'LifeOS', 'medium', 100, ?
    )
  `).run(planDate);
  const taskId = Number(taskResult.lastInsertRowid);

  const payload = await generateNextDayPlan({
    planDate,
    sleepTime: '00:30',
    wakeEstimate: '08:30',
    mood: 'medium',
    energy: 'medium',
    eveningNotes: 'Need calendar-backed focus blocks tomorrow.',
    tomorrowIntention: 'Implement calendar sync smoke test',
    selectedTaskIds: [taskId],
    syncCalendar: true,
    regenerate: true,
  });

  assert(payload.calendarConfigured === true, 'Expected fake Google Calendar mode to report configured.');
  assert(payload.sessions.length >= 1, 'Expected planner to create at least one session.');
  assert(payload.sessions.every(session => session.calendar_status === 'created'), 'Expected every generated session to create a calendar event.');
  assert(payload.sessions.every(session => session.calendar_event_id?.startsWith('fake_gcal_')), 'Expected generated sessions to store fake calendar event ids.');

  const createdSoftWatches = db.prepare(`
    SELECT calendar_event_id
    FROM soft_watch_commitments
    WHERE source = 'next_day_plan'
    ORDER BY id ASC
  `).all();
  assert(createdSoftWatches.length === payload.sessions.length, 'Expected one soft watch for every synced planned session.');
  assert(createdSoftWatches.every(row => row.calendar_event_id?.startsWith('fake_gcal_')), 'Expected soft watches to store calendar event ids after create.');

  const firstSession = payload.sessions[0];
  const originalEventId = firstSession.calendar_event_id;
  const movedStart = addMinutes(istDate(planDate, '13:00'), 0);
  const movedEnd = addMinutes(movedStart, firstSession.duration_minutes + 10);
  const updated = await updatePlannedFocusSession(firstSession.id, {
    title: `${firstSession.title} rescheduled`,
    plannedStart: movedStart.toISOString(),
    plannedEnd: movedEnd.toISOString(),
    syncCalendar: true,
  });

  assert(updated, 'Expected session update to return a row.');
  assert(updated.calendar_event_id === originalEventId, 'Expected update to retain the same calendar event id.');
  assert(updated.calendar_status === 'synced', `Expected update to mark calendar synced, got ${updated.calendar_status}.`);
  assert(updated.title.endsWith('rescheduled'), 'Expected updated title to persist.');
  assert(new Date(updated.planned_start).getTime() === movedStart.getTime(), 'Expected updated start time to persist.');

  const updatedSoftWatch = db.prepare(`
    SELECT target_title, intended_start_at, planned_minutes, calendar_event_id
    FROM soft_watch_commitments
    WHERE id = ?
  `).get(firstSession.soft_watch_id);
  assert(updatedSoftWatch.target_title === updated.title, 'Expected soft watch title to follow update.');
  assert(updatedSoftWatch.intended_start_at === movedStart.getTime(), 'Expected soft watch start time to follow update.');
  assert(updatedSoftWatch.planned_minutes === updated.duration_minutes, 'Expected soft watch duration to follow update.');
  assert(updatedSoftWatch.calendar_event_id === originalEventId, 'Expected soft watch calendar id to remain linked after update.');

  const cancelTarget = payload.sessions.find(session => session.id !== firstSession.id) ?? firstSession;
  const cancelled = await cancelPlannedFocusSession(cancelTarget.id, true);
  assert(cancelled === true, 'Expected synced planned session cancellation to succeed.');
  const cancelledRow = db.prepare('SELECT status, calendar_status FROM planned_focus_sessions WHERE id = ?').get(cancelTarget.id);
  const cancelledSoftWatch = db.prepare('SELECT status FROM soft_watch_commitments WHERE id = ?').get(cancelTarget.soft_watch_id);
  assert(cancelledRow.status === 'cancelled', 'Expected cancelled session status to persist.');
  assert(cancelledRow.calendar_status === 'deleted', `Expected cancelled synced session calendar_status deleted, got ${cancelledRow.calendar_status}.`);
  assert(cancelledSoftWatch.status === 'dismissed', 'Expected cancelled synced session soft watch to be dismissed.');

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'planner calendar create update delete stays in sync',
    planDate,
    sessionsCreated: payload.sessions.length,
    updatedSessionId: updated.id,
    retainedCalendarEventId: originalEventId,
    cancelledSessionId: cancelTarget.id,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
