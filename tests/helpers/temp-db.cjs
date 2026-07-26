'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

const root = path.resolve(__dirname, '../..');

/**
 * Isolate every test file on its own SQLite DB + clear lib module cache.
 * These are real runtime tests against better-sqlite3 + production lib code.
 */
function createIsolatedDb(prefix = 'lifeos-test-') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(tempDir, 'lifeos.db');

  process.env.LIFEOS_DB_PATH = dbPath;
  process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';
  process.env.LIFEOS_FAKE_GOOGLE_CALENDAR = '1';
  process.env.LIFEOS_TTS_PROVIDER = 'disabled';

  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}src${path.sep}lib${path.sep}`)) {
      delete require.cache[key];
    }
  }

  registerTypescript(root);

  const { getDb, setSetting } = require('../../src/lib/db.ts');
  const db = getDb();

  return {
    root,
    tempDir,
    dbPath,
    db,
    setSetting,
    requireLib(relativeFromSrcLib) {
      // e.g. 'cognitive-traits.ts'
      return require(path.join(root, 'src/lib', relativeFromSrcLib));
    },
  };
}

function seedPressureLinkedSessions(db, count = 7, opts = {}) {
  const allowOverdue = opts.allowOverdue === true;
  const specs = [];
  for (let i = 0; i < count; i++) {
    // Majority near-deadline with high focus; minority far with lower focus.
    // Default avoids overdue tasks so moment.mode stays off deadline_pressure
    // (active coach suppresses rewiring on true deadline days).
    const near = i < Math.max(4, count - 2);
    let dueOffset = near ? (i % 3) : 12 + i;
    if (near && allowOverdue && i % 4 === 0) dueOffset = -1;
    specs.push({
      title: near ? `Crisis work ${i}` : `Early buffer ${i}`,
      dueOffset,
      createOffset: near ? -(10 + i) : -2,
      creditOffset: near ? Math.min(dueOffset, i % 2) : 0,
      focus: near ? 88 + (i % 4) : 68 + (i % 3),
      minutes: 40 + i,
    });
  }

  const taskIds = [];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const task = db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, due_date, created_at, estimated_minutes)
      VALUES (?, 'doing', 'high', 'study', date('now', ?), datetime('now', ?), ?)
    `).run(s.title, `${s.dueOffset} days`, `${s.createOffset} days`, s.minutes);
    const taskId = Number(task.lastInsertRowid);
    taskIds.push(taskId);
    db.prepare(`
      INSERT INTO task_session_logs (
        task_id, session_id, session_title, credited_minutes, focus_score, credited_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `).run(taskId, `seed-session-${i}-${Date.now()}`, s.title, s.minutes, s.focus, `${s.creditOffset} days`);
  }
  return taskIds;
}

function seedNonUrgentTask(db, opts = {}) {
  const title = opts.title || 'Deep paper synthesis';
  const result = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, energy_required, estimated_minutes, due_date, created_at
    ) VALUES (?, 'todo', 'high', 'research', 'high', ?, date('now', '+14 days'), datetime('now', '-12 days'))
  `).run(title, opts.estimatedMinutes || 90);
  return { id: Number(result.lastInsertRowid), title };
}

function seedSteadyLinkedSessions(db) {
  const specs = [
    { title: 'Early outline', dueOffset: 14, createOffset: -1, creditOffset: 0, focus: 80, minutes: 45 },
    { title: 'Planned study', dueOffset: 12, createOffset: -1, creditOffset: -1, focus: 82, minutes: 50 },
    { title: 'Steady coding', dueOffset: 15, createOffset: 0, creditOffset: 0, focus: 81, minutes: 55 },
    { title: 'Week-ahead reading', dueOffset: 10, createOffset: -2, creditOffset: -2, focus: 79, minutes: 40 },
    { title: 'Buffered writeup', dueOffset: 11, createOffset: -1, creditOffset: 0, focus: 78, minutes: 35 },
    { title: 'Spaced review', dueOffset: 9, createOffset: 0, creditOffset: 0, focus: 77, minutes: 30 },
    { title: 'Fire drill', dueOffset: 1, createOffset: -5, creditOffset: 1, focus: 72, minutes: 30 },
  ];
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const task = db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, due_date, created_at, estimated_minutes)
      VALUES (?, 'doing', 'medium', 'study', date('now', ?), datetime('now', ?), ?)
    `).run(s.title, `${s.dueOffset} days`, `${s.createOffset} days`, s.minutes);
    const taskId = Number(task.lastInsertRowid);
    db.prepare(`
      INSERT INTO task_session_logs (
        task_id, session_id, session_title, credited_minutes, focus_score, credited_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `).run(taskId, `steady-${i}`, s.title, s.minutes, s.focus, `${s.creditOffset} days`);
  }
}

module.exports = {
  root,
  createIsolatedDb,
  seedPressureLinkedSessions,
  seedNonUrgentTask,
  seedSteadyLinkedSessions,
};
