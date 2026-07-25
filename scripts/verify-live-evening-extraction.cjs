#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-live-evening-extraction-'));
const dbPath = path.join(tempDir, 'lifeos.db');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !process.env[key]) process.env[key] = value;
  }
}

process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function hasLiveAiConfig() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.API_KEY);
}

function textIncludes(value, patterns) {
  const lower = (value ?? '').toLowerCase();
  return patterns.some(pattern => lower.includes(pattern));
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const {
  extractEveningCheckinSignalsFromText,
  resolvePlanDateFromEveningCheckin,
} = require('../src/lib/checkin.ts');
const { generateNextDayPlan } = require('../src/lib/next-day-planner.ts');

async function main() {
  assert(
    hasLiveAiConfig(),
    'Live evening extraction verifier requires GEMINI_API_KEY or API_KEY in the environment or .env.'
  );

  const db = getDb();
  const checkinDate = '2030-07-24';
  const planDate = resolvePlanDateFromEveningCheckin({
    checkinDate,
    sleepTime: '02:00',
    now: new Date('2030-07-24T22:15:00+05:30'),
  });

  setSetting('morning_brief_time', '09:00');

  const zkTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, position
    ) VALUES (
      'Study ZK rollups from notes', 'todo', 'high', 'study', 'zero knowledge', 'low', 120, ?, 1
    )
  `).run(planDate);
  const optionalTask = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, position
    ) VALUES (
      'Refactor optional dashboard polish', 'todo', 'medium', 'coding', 'lifeos', 'high', 60, ?, 2
    )
  `).run(addDays(planDate, 3));
  const zkTaskId = Number(zkTask.lastInsertRowid);
  const optionalTaskId = Number(optionalTask.lastInsertRowid);

  const prose = [
    'Today ran late because of family errands and I felt drained.',
    'Mood was low and energy was low by evening.',
    'I am probably sleeping at 02:00 tonight and waking around 10:00 tomorrow.',
    'Tomorrow I want to study ZK rollups for two hours, but start with lighter reading before hard implementation.',
    'Show-up confidence is 6.',
  ].join(' ');

  let extracted;
  try {
    extracted = await extractEveningCheckinSignalsFromText(prose);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('API key not valid') || message.includes('API_KEY_INVALID')) {
      throw new Error(
        'Live Gemini extraction reached the Developer API, but the configured GEMINI_API_KEY/API_KEY is invalid. Provide a valid key before using this verifier as completion evidence.'
      );
    }
    throw error;
  }

  assert(extracted.sleepTime === '02:00', `Expected sleepTime 02:00 from live prose, got ${extracted.sleepTime}.`);
  assert(extracted.wakeEstimate === '10:00', `Expected wakeEstimate 10:00 from live prose, got ${extracted.wakeEstimate}.`);
  assert(extracted.mood === 'low', `Expected low mood from live prose, got ${extracted.mood}.`);
  assert(extracted.energy === 'low', `Expected low energy from live prose, got ${extracted.energy}.`);
  assert(
    textIncludes(extracted.tomorrowIntention, ['zk', 'rollup', 'study']),
    `Expected tomorrow intention to include ZK study intent, got ${extracted.tomorrowIntention}.`
  );
  assert(
    textIncludes(extracted.dayEvents, ['family', 'errand', 'drained', 'late']),
    `Expected day events to retain family/energy context, got ${extracted.dayEvents}.`
  );

  const payload = await generateNextDayPlan({
    planDate,
    sleepTime: extracted.sleepTime,
    wakeEstimate: extracted.wakeEstimate,
    mood: extracted.mood,
    energy: extracted.energy,
    tomorrowIntention: extracted.tomorrowIntention,
    eveningNotes: extracted.dayEvents ? `${extracted.dayEvents}\n\n${prose}` : prose,
    selectedTaskIds: [zkTaskId, optionalTaskId],
    syncCalendar: false,
    regenerate: true,
  });

  assert(payload.plan, 'Expected next-day plan from live extracted prose.');
  assert(payload.plan.sleep_time === '02:00', `Expected plan sleep_time 02:00, got ${payload.plan.sleep_time}.`);
  assert(payload.plan.wake_estimate === '10:00', `Expected plan wake_estimate 10:00, got ${payload.plan.wake_estimate}.`);
  assert(payload.plan.mood === 'low', `Expected plan low mood, got ${payload.plan.mood}.`);
  assert(payload.plan.energy === 'low', `Expected plan low energy, got ${payload.plan.energy}.`);
  assert(payload.personalization.mode === 'recovery', `Expected recovery mode from live extracted low energy, got ${payload.personalization.mode}.`);
  assert(payload.sessions.length >= 1, 'Expected at least one planned focus session from live extracted intention.');
  assert(
    payload.sessions.some(session => session.task_id === zkTaskId),
    'Expected live extracted ZK intention to schedule the ZK study task.'
  );
  assert(
    payload.sessions.every(session => session.task_id !== optionalTaskId),
    'Expected low-energy live extraction to keep optional high-energy work out of the recovery plan.'
  );

  console.log(JSON.stringify({
    ok: true,
    dbPath,
    scenario: 'live Gemini evening prose extraction updates next-day planning',
    checkinDate,
    planDate,
    extracted,
    mode: payload.personalization.mode,
    scheduledSessions: payload.sessions.map(session => ({
      title: session.title,
      minutes: session.duration_minutes,
      taskId: session.task_id,
    })),
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
