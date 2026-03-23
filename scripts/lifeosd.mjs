#!/usr/bin/env node

import process from 'node:process';

const APP_URL = process.env.LIFEOS_APP_URL || 'http://127.0.0.1:3000';
const PING_INTERVAL_MS = Number(process.env.LIFEOSD_PING_MS || '300000'); // 5 min default
const startedAt = new Date().toISOString();

console.log(`[lifeosd] starting at ${startedAt}`);
console.log(`[lifeosd] appUrl=${APP_URL} pingIntervalMs=${PING_INTERVAL_MS}`);
console.log(`[lifeosd] whisper=${process.env.WHISPER_CPP_URL ? 'configured' : 'stub'} voice=${process.env.VOICE_MODE || 'local'}`);

async function pingGuardian(attempt = 0) {
  try {
    const res = await fetch(`${APP_URL}/api/guardian/soft-watch`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error(`[lifeosd] soft-watch ping failed: HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const pending = (data.commitments ?? []).filter(c => c.status === 'pending').length;
    console.log(`[lifeosd] ${new Date().toISOString()} ping ok — ${pending} pending commitment(s)`);
  } catch (err) {
    // Retry with backoff on startup (app may not be ready yet)
    if (attempt < 5) {
      const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
      console.log(`[lifeosd] app not reachable (attempt ${attempt + 1}), retrying in ${delay / 1000}s…`);
      setTimeout(() => pingGuardian(attempt + 1), delay);
    } else {
      console.error(`[lifeosd] could not reach app after ${attempt} attempts: ${String(err)}`);
    }
  }
}

// Startup ping — loads SOFT_WATCH checker in the Next.js runtime
void pingGuardian(0);

// Recurring ping — keeps checker alive across Next.js hot reloads
setInterval(() => void pingGuardian(), PING_INTERVAL_MS);
