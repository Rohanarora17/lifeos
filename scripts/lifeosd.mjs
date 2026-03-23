#!/usr/bin/env node

import process from 'node:process';

const heartbeatMs = Number(process.env.LIFEOSD_HEARTBEAT_MS || '30000');
const startedAt = new Date().toISOString();

console.log(`[lifeosd] starting local guardian helper at ${startedAt}`);
console.log(`[lifeosd] mode=local-first heartbeatMs=${heartbeatMs}`);
console.log(`[lifeosd] whisper=${process.env.WHISPER_CPP_URL ? 'configured' : 'stub'} kokoro=${process.env.KOKORO_URL ? 'configured' : 'fallback'}`);
console.log(
  `[lifeosd] voiceMode=${process.env.VOICE_MODE || 'local'} livekit=${process.env.LIVEKIT_WS_URL ? 'configured' : 'off'} guardianVoiceAgent=${
    process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY || process.env.API_KEY || process.env.GEMINI_API_KEY
      ? 'configured'
      : 'missing-google-key'
  } appUrl=${process.env.LIFEOS_APP_URL || 'http://127.0.0.1:3000'}`
);

setInterval(() => {
  console.log(`[lifeosd] alive ${new Date().toISOString()}`);
}, heartbeatMs);
