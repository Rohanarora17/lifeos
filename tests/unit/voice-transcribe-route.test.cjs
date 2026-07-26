'use strict';

const { afterEach, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { registerTypescript } = require('../../scripts/lib/register-ts.cjs');

const root = path.resolve(__dirname, '../..');
let POST;
let originalFetch;

describe('voice transcription route', () => {
  before(() => {
    registerTypescript(root);
    ({ POST } = require('../../src/app/api/voice/transcribe/route.ts'));
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.WHISPER_CPP_URL;
    delete process.env.WHISPER_CPP_MODE;
    delete process.env.WHISPER_CPP_OPENAI_MODEL;
    delete process.env.GROQ_API_KEY;
  });

  it('forwards one file field to an OpenAI-compatible transcription API', async () => {
    process.env.WHISPER_CPP_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
    process.env.WHISPER_CPP_MODE = 'openai';
    process.env.WHISPER_CPP_OPENAI_MODEL = 'whisper-large-v3-turbo';
    process.env.GROQ_API_KEY = 'test-key';

    let forwardedKeys = [];
    global.fetch = async (_url, options) => {
      forwardedKeys = [...options.body.keys()];
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(options.body.get('model'), 'whisper-large-v3-turbo');
      return new Response(JSON.stringify({ text: 'transcribed phrase' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const incoming = new FormData();
    incoming.set('audio', new File(['audio'], 'speech.m4a', { type: 'audio/mp4' }));
    const response = await POST(new Request('http://lifeos.test/api/voice/transcribe', {
      method: 'POST',
      body: incoming,
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(forwardedKeys, ['file', 'model', 'response_format']);
    assert.equal((await response.json()).transcript, 'transcribed phrase');
  });
});
