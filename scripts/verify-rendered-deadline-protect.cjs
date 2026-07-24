#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-rendered-deadline-protect-'));
const dbPath = path.join(tempDir, 'lifeos.db');
const port = 4660 + Math.floor(Math.random() * 300);
const baseUrl = `http://127.0.0.1:${port}`;

process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';
process.env.NEXT_TELEMETRY_DISABLED = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function todayIst(baseNow = Date.now()) {
  return new Date(baseNow + 19_800_000).toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function istHour(baseNow = Date.now()) {
  return new Date(baseNow + 19_800_000).getHours();
}

function isoMinutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function pressureProfile(hour) {
  return {
    version: 12,
    synthesizedAt: Date.now(),
    trigger: 'rendered_deadline_protect_fixture',
    peakFocusHours: [hour],
    optimalSessionMinutes: 45,
    avgSessionFocusScore: 88,
    focusTrend: 'improving',
    totalFocusMinutesThisWeek: 210,
    energyByHour: { [hour]: 'high' },
    currentEnergyEstimate: 'high',
    energyPattern: `Strong protected focus usually lands around ${String(hour).padStart(2, '0')}:00.`,
    topProductiveDomains: ['mathacademy.com', 'arxiv.org'],
    topDistractionDomains: ['youtube.com'],
    distractionTriggers: ['opening optional reading while deadlines are unresolved'],
    avoidancePatterns: ['organizing notes before submitting assignments'],
    strongTopics: ['zero knowledge proofs'],
    frictionTopics: ['deadline-heavy proof writeups'],
    goalMomentum: {},
    taskCompletionRate: 0.84,
    activeGoalsSummary: ['Submit the ZK assignment before optional cleanup'],
    nextRecommendedTopic: 'deadline relief for ZK assignment',
    habitStreakSummary: [],
    habitsAtRisk: [],
    standupGoalToday: 'Clear the ZK assignment first',
    moodToday: 'medium',
    calendarEventsToday: [],
    recentStudyTopics: ['ZK assignments'],
    knowledgeGaps: ['proof notation under deadline pressure'],
    preferredCoachingStyle: 'direct',
    adaptiveThresholds: {
      focusDropAlertScore: 65,
      cognitiveLoadThreshold: 8,
      distractionAlertMinutes: 15,
      sessionDurationSweetSpot: 45,
      habitRiskDays: 2,
      focusGoodThreshold: 78,
      focusExcellentThreshold: 88,
      cognitiveLoadAdvice: 'Do the deadline-relief block before opening optional tasks.',
      efficacyAdvice: 'Keep the session concrete and finish the planned target.',
    },
    currentNarrative: 'Deadline pressure is active; the UI should show urgent work before generic suggestions.',
    coachingInsights: ['45 minute ZK blocks are the strongest current signal.'],
    nextBestFocusWindow: `${String(hour).padStart(2, '0')}:00`,
    weeklyProgressSummary: 'Deadline-focused blocks are working better than generic Pomodoros.',
  };
}

const { getDb } = require('../src/lib/db.ts');
const { runAlertEngine } = require('../src/lib/notifications.ts');
const { createSoftWatchCommitment } = require('../src/lib/guardian-runtime.ts');

async function seed() {
  const db = getDb();
  const today = todayIst();
  const overdueDate = addDays(today, -1);
  const peakHour = istHour();

  db.prepare(`
    INSERT INTO user_intelligence_profile (profile_json, version, trigger)
    VALUES (?, 12, 'rendered_deadline_protect_fixture')
  `).run(JSON.stringify(pressureProfile(peakHour)));

  const taskResult = db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date, due_time
    ) VALUES (
      'Submit ZK assignment', 'todo', 'critical', 'assignment', 'zero knowledge', 'high', 60, ?, '18:00'
    )
  `).run(overdueDate);
  const taskId = Number(taskResult.lastInsertRowid);

  db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, course, energy_required, estimated_minutes, due_date
    ) VALUES (
      'Organize optional study notes', 'todo', 'low', 'task', 'general', 'low', 30, ?
    )
  `).run(addDays(today, 7));

  db.prepare(`
    INSERT INTO calendar_events (id, title, start_time, end_time, location)
    VALUES ('rendered-deadline-calendar-block', 'ZK assignment submission block', ?, ?, 'Google Calendar')
  `).run(isoMinutesFromNow(5), isoMinutesFromNow(65));

  const planResult = db.prepare(`
    INSERT INTO daily_plans (plan_date, sleep_time, wake_estimate, mood, energy, tomorrow_intention, status)
    VALUES (?, '23:30', '08:30', 'medium', 'high', 'Clear the ZK assignment before optional cleanup', 'active')
  `).run(today);
  const planId = Number(planResult.lastInsertRowid);

  const softWatch = createSoftWatchCommitment({
    targetTitle: 'Submit ZK assignment',
    taskId,
    intendedStartAt: Date.now() + 5 * 60_000,
    plannedMinutes: 60,
    source: 'planner',
    calendarEventId: 'rendered-deadline-calendar-block',
  });

  db.prepare(`
    INSERT INTO planned_focus_sessions (
      id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
      session_type, rule_json, reward_xp, reward_coins, soft_watch_id, calendar_event_id, calendar_status, status
    ) VALUES (
      'rendered-deadline-pressure-block', ?, ?, 'Submit ZK assignment', ?, ?, 60,
      'assignment',
      '{"mode":"deadline_pressure","guidance":"Use this deadline-relief block before optional cleanup.","tools":["editor","notes"],"rewardReason":"deadline-pressure day rewards concrete task progress because deadline pressure is active"}',
      90, 45, ?, 'rendered-deadline-calendar-block', 'synced', 'planned'
    )
  `).run(
    planId,
    taskId,
    isoMinutesFromNow(5),
    isoMinutesFromNow(65),
    softWatch.id
  );

  await runAlertEngine();

  return { peakHour, taskId };
}

function waitForServer(server, url, timeoutMs = 45_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      if (server.exitCode !== null) {
        clearInterval(timer);
        reject(new Error(`Next dev server exited early with ${server.exitCode}`));
        return;
      }
      try {
        const res = await fetch(`${url}/api/dashboard`);
        if (res.ok) {
          clearInterval(timer);
          resolve();
          return;
        }
      } catch {
        // Keep waiting while Next compiles.
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${url}`));
      }
    }, 500);
  });
}

function stopServer(server) {
  return new Promise(resolve => {
    if (server.exitCode !== null || server.killed) {
      resolve();
      return;
    }
    const kill = signal => {
      try {
        process.kill(-server.pid, signal);
      } catch {
        server.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      if (server.exitCode === null) {
        kill('SIGKILL');
      }
      resolve();
    }, 2_000);
    server.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    kill('SIGTERM');
  });
}

function runPlaywright() {
  const specPath = path.join(tempDir, 'rendered-deadline-protect.spec.cjs');
  const configPath = path.join(tempDir, 'playwright.config.cjs');
  const packageJsonPath = path.join(tempDir, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify({
    private: true,
    devDependencies: {
      '@playwright/test': '1.61.1',
    },
  }, null, 2));

  const install = spawnSync('npm', ['install', '--silent'], {
    cwd: tempDir,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (install.stdout) process.stdout.write(install.stdout);
  if (install.stderr) process.stderr.write(install.stderr);
  assert(install.status === 0, `Failed to install temp Playwright runner with status ${install.status}.`);

  const browserInstall = spawnSync(
    path.join(tempDir, 'node_modules/.bin/playwright'),
    ['install', 'chromium'],
    {
      cwd: tempDir,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }
  );
  if (browserInstall.stdout) process.stdout.write(browserInstall.stdout);
  if (browserInstall.stderr) process.stderr.write(browserInstall.stderr);
  assert(browserInstall.status === 0, `Failed to install Chromium for rendered smoke with status ${browserInstall.status}.`);

  fs.writeFileSync(specPath, `
const { test, expect } = require('@playwright/test');

const baseUrl = process.env.BASE_URL;

test('dashboard and guardian render deadline pressure then protect focus mode', async ({ page, request }) => {
  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Today Mode')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next planned block: Submit ZK assignment' })).toBeVisible();
  await expect(page.getByText('high energy · medium mood')).toBeVisible();
  await expect(page.getByText('1 overdue')).toBeVisible();
  await expect(page.getByText(/Next planned focus: Submit ZK assignment \\(60m\\)/)).toBeVisible();
  await expect(page.getByText(/alerts remain visible because there is deadline pressure/)).toBeVisible();

  await page.goto(baseUrl + '/guardian', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Deadline pressure').first()).toBeVisible();
  await expect(page.getByText(/Prioritize concrete deadline relief/).first()).toBeVisible();
  await expect(page.getByText('Submit ZK assignment').first()).toBeVisible();
  await expect(page.getByText('high fit').first()).toBeVisible();
  await expect(page.getByText('Next planned focus: Submit ZK assignment (1h)')).toBeVisible();

  const start = await request.post(baseUrl + '/api/guardian/session/start', {
    data: {
      topic: 'Submit ZK assignment',
      durationMinutes: 60,
      mood: 'medium',
      source: 'api',
      sessionContext: 'Rendered smoke starts the deadline block so protect-focus mode can be checked.',
    },
  });
  expect(start.ok()).toBeTruthy();

  await page.goto(baseUrl + '/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Today Mode')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stay with Submit ZK assignment' })).toBeVisible();
  await expect(page.getByText('high energy · medium mood')).toBeVisible();
  await expect(page.getByText('quiet')).toBeVisible();
  await expect(page.getByText(/active focus is worth protecting/)).toBeVisible();
  await expect(page.getByText(/Current focus score is 100/)).toBeVisible();

  await page.goto(baseUrl + '/guardian', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Active Session')).toBeVisible();
  await expect(page.getByText('Submit ZK assignment').first()).toBeVisible();
  await expect(page.getByText('Protect focus').first()).toBeVisible();
  await expect(page.getByText('Mode', { exact: true })).toBeVisible();
});
`);
  fs.writeFileSync(configPath, `
module.exports = {
  testDir: ${JSON.stringify(tempDir)},
  testMatch: /rendered-deadline-protect\\.spec\\.cjs/,
  timeout: 60000,
  reporter: 'list',
  use: {
    browserName: 'chromium',
  },
};
`);

  const result = spawnSync(
    path.join(tempDir, 'node_modules/.bin/playwright'),
    ['test', '--config', configPath],
    {
      cwd: tempDir,
      env: {
        ...process.env,
        BASE_URL: baseUrl,
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert(result.status === 0, `Rendered deadline/protect smoke failed with status ${result.status}.`);
}

async function main() {
  const fixture = await seed();
  const server = spawn(
    process.execPath,
    [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: root,
      env: {
        ...process.env,
        LIFEOS_DB_PATH: dbPath,
        LIFEOS_DISABLE_UIL_SYNTHESIS: '1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let serverOutput = '';
  server.stdout.on('data', chunk => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', chunk => {
    serverOutput += chunk.toString();
  });

  try {
    await waitForServer(server, baseUrl);
    runPlaywright();
    console.log(JSON.stringify({
      ok: true,
      dbPath,
      baseUrl,
      scenario: 'rendered dashboard and guardian expose deadline-pressure and protect-focus adaptive states',
      peakHour: fixture.peakHour,
      taskId: fixture.taskId,
    }, null, 2));
  } catch (error) {
    console.error(serverOutput);
    throw error;
  } finally {
    await stopServer(server);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
