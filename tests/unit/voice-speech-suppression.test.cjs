'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const env = createIsolatedDb('lifeos-voice-suppression-');
const {
  isSpeechSuppressed,
  suppressSpeechForRequest,
} = env.requireLib('tts.ts');

describe('voice response channel ownership', () => {
  it('suppresses the competing server speech path until PTT releases it', () => {
    const release = suppressSpeechForRequest('session-a');
    assert.equal(isSpeechSuppressed('session-a'), true);
    assert.equal(isSpeechSuppressed('session-b'), false);
    release();
    assert.equal(isSpeechSuppressed('session-a'), false);
  });

  it('reference-counts concurrent requests and makes release idempotent', () => {
    const releaseOne = suppressSpeechForRequest('session-a');
    const releaseTwo = suppressSpeechForRequest('session-a');
    releaseOne();
    releaseOne();
    assert.equal(isSpeechSuppressed('session-a'), true);
    releaseTwo();
    assert.equal(isSpeechSuppressed('session-a'), false);
  });
});
