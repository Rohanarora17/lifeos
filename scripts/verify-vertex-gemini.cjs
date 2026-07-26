#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
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

async function main() {
  const { getGeminiRuntimeInfo, getGenAI, generateWithFallback } = require('../src/lib/ai.ts');
  const { MODEL_REALTIME_ACTIVITY } = require('../src/lib/models.ts');

  const runtime = getGeminiRuntimeInfo();
  if (runtime.apiProduct !== 'vertex_ai') {
    throw new Error(`Expected Vertex AI runtime, got ${runtime.apiProduct}.`);
  }

  const result = await generateWithFallback(getGenAI(), {
    model: MODEL_REALTIME_ACTIVITY,
    contents: 'Return exactly: vertex-ok',
    config: { temperature: 0, maxOutputTokens: 128 },
  });
  const text = (result.text || '').trim().toLowerCase();
  if (!text.includes('vertex-ok')) {
    throw new Error(`Vertex Gemini call returned unexpected text: ${result.text || '<empty>'}`);
  }

  console.log(JSON.stringify({
    ok: true,
    runtime,
    model: MODEL_REALTIME_ACTIVITY,
    response: text,
  }, null, 2));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    ok: false,
    error: message,
    remediation: [
      'Set GOOGLE_CLOUD_PROJECT to the Google Cloud project billed for Vertex AI.',
      'Run gcloud auth application-default login for local development.',
      'Run gcloud auth application-default set-quota-project $GOOGLE_CLOUD_PROJECT when needed.',
      'Enable aiplatform.googleapis.com and grant the runtime identity roles/aiplatform.user.',
    ],
  }, null, 2));
  process.exit(1);
});
