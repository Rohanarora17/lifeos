#!/usr/bin/env node

/**
 * Spins an isolated Next dev server on a temp DB seeded with pressure-wired data,
 * then runs Playwright e2e against /insights Brain Map.
 *
 * This is a real browser test — not typecheck-only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeos-brain-map-e2e-'));
const dbPath = path.join(tempDir, 'lifeos.db');
const port = 4320 + Math.floor(Math.random() * 200);
const baseUrl = `http://127.0.0.1:${port}`;

process.env.LIFEOS_DB_PATH = dbPath;
process.env.LIFEOS_DISABLE_UIL_SYNTHESIS = '1';
process.env.LIFEOS_FAKE_GOOGLE_CALENDAR = '1';
process.env.NEXT_TELEMETRY_DISABLED = '1';

registerTypescript(root);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function seed() {
  const { getDb, setSetting } = require('../src/lib/db.ts');
  const db = getDb();
  setSetting('morning_brief_time', '09:00');
  setSetting('cognitive_experiments_v1', '[]');
  setSetting('cognitive_trait_stances', '{}');

  // Non-urgent target task
  db.prepare(`
    INSERT INTO tasks (
      title, status, priority, task_type, energy_required, estimated_minutes, due_date, created_at
    ) VALUES (
      'Deep paper synthesis', 'todo', 'high', 'research', 'high', 90,
      date('now', '+14 days'), datetime('now', '-12 days')
    )
  `).run();

  // Pressure-wired linked sessions
  for (let i = 0; i < 7; i++) {
    const near = i < 5;
    const dueOffset = near ? (i % 3) : 12;
    const createOffset = near ? -(12 + i) : -2;
    const creditOffset = near ? (i % 2) : 0;
    const focus = near ? 88 + (i % 3) : 70;
    const title = near ? `Crisis block ${i}` : `Buffer block ${i}`;
    const task = db.prepare(`
      INSERT INTO tasks (title, status, priority, task_type, due_date, created_at, estimated_minutes)
      VALUES (?, 'doing', 'high', 'study', date('now', ?), datetime('now', ?), 45)
    `).run(title, `${dueOffset} days`, `${createOffset} days`);
    const taskId = Number(task.lastInsertRowid);
    db.prepare(`
      INSERT INTO task_session_logs (
        task_id, session_id, session_title, credited_minutes, focus_score, credited_at
      ) VALUES (?, ?, ?, 45, ?, datetime('now', ?))
    `).run(taskId, `e2e-session-${i}`, title, focus, `${creditOffset} days`);
  }

  // Precompute traits so history has a point
  const { computeCognitiveTraits } = require('../src/lib/cognitive-traits.ts');
  const { proposeCognitiveExperiment } = require('../src/lib/cognitive-experiments.ts');
  const traits = computeCognitiveTraits({ windowDays: 45 });
  proposeCognitiveExperiment({ traits });
  return traits;
}

function waitForServer(server, url, timeoutMs = 90_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server did not become ready at ${url}`));
        return;
      }
      try {
        const res = await fetch(url);
        if (res.ok || res.status === 404 || res.status === 500) {
          resolve();
          return;
        }
      } catch {
        /* retry */
      }
      setTimeout(tick, 500);
    };
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    tick();
  });
}

async function main() {
  const playwrightCli = path.join(root, 'node_modules', '.bin', 'playwright');
  assert(fs.existsSync(playwrightCli), '@playwright/test is not installed. Run npm install -D @playwright/test');

  const traits = seed();
  assert(traits.pressureProfile.pressureDependency != null, 'Seed should produce PDI');

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
    },
  );

  let serverOutput = '';
  server.stdout.on('data', c => { serverOutput += c.toString(); });
  server.stderr.on('data', c => { serverOutput += c.toString(); });

  try {
    await waitForServer(server, `${baseUrl}/insights`);

    const result = spawnSync(
      playwrightCli,
      ['test', 'tests/e2e/brain-map.spec.cjs', '--config', 'playwright.config.cjs'],
      {
        cwd: root,
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          LIFEOS_DB_PATH: dbPath,
        },
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      },
    );

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert(result.status === 0, `Brain Map e2e failed with status ${result.status}`);

    console.log(JSON.stringify({
      ok: true,
      suite: 'playwright e2e brain-map',
      baseUrl,
      dbPath,
      pdi: traits.pressureProfile.pressureDependency,
      voluntary: traits.pressureProfile.voluntaryStartRate,
    }, null, 2));
  } catch (error) {
    console.error(serverOutput.slice(-4000));
    throw error;
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
