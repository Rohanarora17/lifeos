#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-rendered-adaptive-planner-'));
const dbPath = path.join(tempDir, 'lifeos.db');
const port = 4310 + Math.floor(Math.random() * 300);
const baseUrl = `http://127.0.0.1:${port}`;

process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';
process.env.LIFEOS_FAKE_GOOGLE_CALENDAR = '1';
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

function isoMinutesFromNow(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function istDate(planDate, time) {
  return new Date(`${planDate}T${time}:00+05:30`);
}

function recoveryProfile() {
  return {
    version: 11,
    synthesizedAt: Date.now(),
    trigger: 'rendered_adaptive_planner_fixture',
    peakFocusHours: [10],
    optimalSessionMinutes: 45,
    avgSessionFocusScore: 72,
    focusTrend: 'stable',
    totalFocusMinutesThisWeek: 90,
    energyByHour: { 10: 'medium' },
    currentEnergyEstimate: 'low',
    energyPattern: 'Late sleep usually makes the first block smaller.',
    topProductiveDomains: ['arxiv.org', 'mathacademy.com'],
    topDistractionDomains: ['youtube.com'],
    distractionTriggers: ['starting optional browsing before the planned block'],
    avoidancePatterns: ['oversizing research sessions on low-energy mornings'],
    strongTopics: ['adaptive systems'],
    frictionTopics: ['distributed systems papers'],
    goalMomentum: {},
    taskCompletionRate: 0.68,
    activeGoalsSummary: ['Keep research moving without overloading the day'],
    nextRecommendedTopic: 'adaptive scheduler design',
    habitStreakSummary: [],
    habitsAtRisk: [],
    standupGoalToday: 'Keep the recovery-sized research plan intact',
    moodToday: 'low',
    calendarEventsToday: [],
    recentStudyTopics: ['adaptive planning'],
    knowledgeGaps: ['scheduler tradeoffs'],
    preferredCoachingStyle: 'direct',
    adaptiveThresholds: {
      focusDropAlertScore: 65,
      cognitiveLoadThreshold: 8,
      distractionAlertMinutes: 15,
      sessionDurationSweetSpot: 45,
      habitRiskDays: 2,
      focusGoodThreshold: 78,
      focusExcellentThreshold: 88,
      cognitiveLoadAdvice: 'Keep one planned block visible instead of adding more tasks.',
      efficacyAdvice: 'Use a smaller task target and finish it.',
    },
    currentNarrative: 'A low-energy planning day should show the scheduled block instead of generic prompts.',
    coachingInsights: ['Rendered surfaces should expose the same adaptive state as the backend plan.'],
    nextBestFocusWindow: '10:30',
    weeklyProgressSummary: 'Small planned sessions are the useful signal this week.',
  };
}

const { getDb, setSetting } = require('../src/lib/db.ts');
const { generateNextDayPlan } = require('../src/lib/next-day-planner.ts');

async function seed() {
  const db = getDb();
  const today = todayIst();
  const tomorrow = addDays(today, 1);
  setSetting('morning_brief_time', '10:30');

  db.prepare(`
    INSERT INTO user_intelligence_profile (profile_json, version, trigger)
    VALUES (?, 11, 'rendered_adaptive_planner_fixture')
  `).run(JSON.stringify(recoveryProfile()));

  const todayTask = db.prepare(`
    INSERT INTO tasks (title, status, priority, task_type, course, energy_required, estimated_minutes, due_date)
    VALUES ('Recovery ZK flashcards', 'todo', 'medium', 'study', 'zero knowledge', 'low', 25, ?)
  `).run(today);
  const todayTaskId = Number(todayTask.lastInsertRowid);
  const todayPlan = db.prepare(`
    INSERT INTO daily_plans (plan_date, sleep_time, wake_estimate, mood, energy, tomorrow_intention, status)
    VALUES (?, '02:00', '10:30', 'low', 'low', 'Keep the current recovery block visible', 'active')
  `).run(today);
  const todayPlanId = Number(todayPlan.lastInsertRowid);

  db.prepare(`
    INSERT INTO planned_focus_sessions (
      id, plan_id, task_id, title, planned_start, planned_end, duration_minutes,
      session_type, rule_json, reward_xp, reward_coins, status
    ) VALUES (
      'rendered-today-recovery-block', ?, ?, 'Recovery ZK flashcards',
      ?, ?, 25, 'study',
      '{"mode":"study","guidance":"Use a recovery-sized block; stop after the promised 25 minutes.","breakMinutes":8,"tools":["notes"],"rewardReason":"recovery mode shaped this visible block"}',
      30, 15, 'planned'
    )
  `).run(todayPlanId, todayTaskId, isoMinutesFromNow(20), isoMinutesFromNow(45));

  db.prepare(`
    INSERT INTO calendar_events (id, title, description, start_time, end_time, location)
    VALUES ('rendered_tomorrow_busy', 'Morning appointment', 'Visible planner constraint', ?, ?, 'Calendar')
  `).run(
    istDate(tomorrow, '09:00').toISOString(),
    istDate(tomorrow, '10:00').toISOString()
  );

  const tomorrowTask = db.prepare(`
    INSERT INTO tasks (title, status, priority, task_type, course, energy_required, estimated_minutes, due_date)
    VALUES ('Read adaptive systems paper', 'todo', 'high', 'research', 'adaptive systems', 'low', 35, ?)
  `).run(tomorrow);
  const tomorrowTaskId = Number(tomorrowTask.lastInsertRowid);

  await generateNextDayPlan({
    planDate: tomorrow,
    sleepTime: '02:00',
    wakeEstimate: '10:30',
    mood: 'low',
    energy: 'low',
    eveningNotes: 'Rendered smoke fixture: late night and low energy should be visible on planner UI.',
    tomorrowIntention: 'Read adaptive systems paper lightly',
    selectedTaskIds: [tomorrowTaskId],
    syncCalendar: true,
    regenerate: true,
  });

  return { today, tomorrow };
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

function runPlaywright(tomorrow) {
  const specPath = path.join(tempDir, 'rendered-adaptive-planner.spec.cjs');
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
const tomorrow = process.env.PLAN_DATE;

test('dashboard and guardian render adaptive planner state', async ({ page }) => {
  await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
  await expect(page.getByText('Today Mode')).toBeVisible();
  await expect(page.getByText('low energy · low mood')).toBeVisible();
  await expect(page.getByText('Next planned block: Recovery ZK flashcards')).toBeVisible();
  await expect(page.getByText(/Next planned focus: Recovery ZK flashcards \\(25m\\)/)).toBeVisible();

  await page.goto(baseUrl + '/guardian', { waitUntil: 'networkidle' });
  await expect(page.getByText('Tomorrow Plan')).toBeVisible();
  await expect(page.getByText(tomorrow)).toBeVisible();
  await expect(page.getByText('02:00')).toBeVisible();
  await expect(page.getByText('10:30').first()).toBeVisible();
  await expect(page.getByText('low', { exact: true })).toHaveCount(2);
  await expect(page.getByText('connected')).toBeVisible();
  await expect(page.getByText('Read adaptive systems paper').first()).toBeVisible();
  await expect(page.getByText('Use longer exploration blocks').first()).toBeVisible();
  await expect(page.getByText(/XP ·/).first()).toBeVisible();
  await expect(page.getByText(/created|synced/).first()).toBeVisible();
});
`);
  fs.writeFileSync(configPath, `
module.exports = {
  testDir: ${JSON.stringify(tempDir)},
  testMatch: /rendered-adaptive-planner\\.spec\\.cjs/,
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
        PLAN_DATE: tomorrow,
      },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert(result.status === 0, `Rendered adaptive planner smoke failed with status ${result.status}.`);
}

async function main() {
  const { tomorrow } = await seed();
  const server = spawn(
    process.execPath,
    [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '-p', String(port), '--hostname', '127.0.0.1'],
    {
      cwd: root,
      env: {
        ...process.env,
        LIFEOS_DB_PATH: dbPath,
        LIFEOS_DISABLE_UIL_SYNTHESIS: '1',
        LIFEOS_FAKE_GOOGLE_CALENDAR: '1',
        NEXT_TELEMETRY_DISABLED: '1',
      },
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
    runPlaywright(tomorrow);
    console.log(JSON.stringify({
      ok: true,
      dbPath,
      baseUrl,
      scenario: 'rendered dashboard and guardian planner expose adaptive recovery/planning state',
      tomorrow,
    }, null, 2));
  } catch (error) {
    console.error(serverOutput);
    throw error;
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
