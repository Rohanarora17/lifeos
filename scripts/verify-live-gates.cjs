#!/usr/bin/env node

/**
 * Live integration gate reporter — honest status only.
 *
 * Exit codes:
 *   0 = all configured live gates healthy OR none configured (soft skip with report)
 *   1 = at least one configured live dependency is broken
 *
 * Does not claim personalization is complete when keys are missing.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { registerTypescript } = require('./lib/register-ts.cjs');

const root = path.resolve(__dirname, '..');

function loadEnvFile(name) {
  const envPath = path.join(root, name);
  if (!fs.existsSync(envPath)) return;
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

loadEnvFile('.env');
loadEnvFile('.env.local');
registerTypescript(root);

function mask(value) {
  if (!value) return null;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function checkGemini() {
  try {
    const { getGeminiRuntimeInfo, getGenAI, generateWithFallback } = require('../src/lib/ai.ts');
    const { MODEL_REALTIME_ACTIVITY } = require('../src/lib/models.ts');
    const runtime = getGeminiRuntimeInfo();
    const result = await generateWithFallback(getGenAI(), {
      model: MODEL_REALTIME_ACTIVITY,
      contents: 'Return exactly: ok',
      config: { temperature: 0, maxOutputTokens: 128 },
    });
    const text = (result.text || '').trim().toLowerCase();
    return {
      id: 'vertex_ai_gemini',
      configured: true,
      healthy: text.includes('ok'),
      detail: `Vertex AI runtime reached ${runtime.apiProduct} with ${runtime.auth} auth in project ${runtime.project}, location ${runtime.location}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingProject = message.includes('GOOGLE_CLOUD_PROJECT');
    return {
      id: 'vertex_ai_gemini',
      configured: !missingProject,
      healthy: false,
      detail: missingProject
        ? 'GOOGLE_CLOUD_PROJECT is missing. Configure Vertex AI ADC and a Google Cloud project before using live Gemini evidence.'
        : `Vertex AI Gemini call failed: ${message}`,
    };
  }
}

function checkGoogleOAuthArtifacts() {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
  const refresh = process.env.GOOGLE_REFRESH_TOKEN || process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || '';
  const ics = process.env.CALENDAR_ICS_URL || '';

  // Also check settings DB if available — optional, non-fatal
  let settingsHint = '';
  try {
    const dbPath = process.env.LIFEOS_DB_PATH || path.join(root, 'data', 'lifeos.db');
    if (fs.existsSync(dbPath)) {
      settingsHint = ` Local DB exists at ${dbPath}; run app calendar settings for OAuth status.`;
    }
  } catch { /* */ }

  if (process.env.LIFEOS_FAKE_GOOGLE_CALENDAR === '1') {
    return {
      id: 'google_calendar',
      configured: false,
      healthy: null,
      detail: 'LIFEOS_FAKE_GOOGLE_CALENDAR=1 — deterministic fake path only (verified by verify:calendar-sync). Not live OAuth.',
    };
  }

  if (ics) {
    return {
      id: 'google_calendar',
      configured: true,
      healthy: null,
      detail: `ICS URL configured (${mask(ics)}). Live OAuth not asserted; ICS smoke is separate.${settingsHint}`,
    };
  }

  if (!clientId && !refresh) {
    return {
      id: 'google_calendar',
      configured: false,
      healthy: null,
      detail: `No GOOGLE_CLIENT_ID / refresh token / ICS URL in env. Fake calendar CRUD is verified; live OAuth is not.${settingsHint}`,
    };
  }

  return {
    id: 'google_calendar',
    configured: true,
    healthy: null,
    detail: `OAuth-related env present (client ${mask(clientId) || 'n/a'}, refresh ${refresh ? 'set' : 'missing'}). Full live create/update/delete against a real account still needs a manual smoke on the user's Google account.${settingsHint}`,
  };
}

function checkFormalSuite() {
  const result = spawnSync('npm', ['run', 'test:cognitive'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    id: 'cognitive_formal_suite',
    configured: true,
    healthy: result.status === 0,
    detail: result.status === 0
      ? 'npm run test:cognitive passed (temp SQLite + production lib).'
      : `npm run test:cognitive failed with status ${result.status}. ${((result.stderr || result.stdout || '')).slice(-300)}`,
  };
}

async function main() {
  const gates = [];
  gates.push(await checkGemini());
  gates.push(checkGoogleOAuthArtifacts());
  gates.push(checkFormalSuite());

  const broken = gates.filter(g => g.configured && g.healthy === false);
  const report = {
    ok: broken.length === 0,
    generatedAt: new Date().toISOString(),
    gates,
    interpretation: {
      formalSuite: 'Required for Cognitive Self-Map claims.',
      geminiLive: 'Uses Vertex AI billing/auth via the shared Gemini runtime.',
      calendarLive: 'Fake CRUD is already verified; live OAuth/ICS needs real account smoke.',
    },
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(broken.length === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
