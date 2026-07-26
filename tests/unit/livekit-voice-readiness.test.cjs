'use strict';

const { afterEach, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

const root = path.resolve(__dirname, '../..');
const envKeys = [
  'ELEVENLABS_API_KEY',
  'GOOGLE_CLOUD_PROJECT',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_WS_URL',
  'VOICE_MODE',
  'WHISPER_CPP_URL',
];

let livekit;

describe('guardian voice readiness', () => {
  before(() => {
    registerTypescript(root);
    livekit = require('../../src/lib/livekit.ts');
  });

  afterEach(() => {
    for (const key of envKeys) delete process.env[key];
  });

  it('reports the configured push-to-talk provider accurately', () => {
    process.env.WHISPER_CPP_URL =
      'https://api.groq.com/openai/v1/audio/transcriptions';

    assert.equal(livekit.hasPushToTalkTranscriptionConfigured(), true);
    assert.equal(livekit.getPushToTalkTranscriptionProvider(), 'groq-whisper');
    assert.match(livekit.getGuardianVoiceModeSummary(), /groq-whisper/);
  });

  it('prefers Scribe when both transcription providers are configured', () => {
    process.env.ELEVENLABS_API_KEY = 'test-key';
    process.env.WHISPER_CPP_URL =
      'https://api.groq.com/openai/v1/audio/transcriptions';

    assert.equal(
      livekit.getPushToTalkTranscriptionProvider(),
      'elevenlabs-scribe'
    );
  });

  it('requires mode, transport, and Vertex configuration for realtime readiness', () => {
    process.env.LIVEKIT_WS_URL = 'wss://voice.example.test';
    process.env.LIVEKIT_API_KEY = 'api-key';
    process.env.LIVEKIT_API_SECRET = 'api-secret';
    process.env.GOOGLE_CLOUD_PROJECT = 'test-project';

    assert.equal(livekit.isGuardianVoiceAgentConfigured(), false);
    process.env.VOICE_MODE = 'google-live';
    assert.equal(livekit.isGuardianVoiceAgentConfigured(), true);
  });
});
