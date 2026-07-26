'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('guardian voice limits', () => {
  let db;
  let acquireGuardianVoiceLease;
  let releaseGuardianVoiceLease;

  beforeEach(() => {
    process.env.LIFEOS_MAX_CONCURRENT_LIVE_SESSIONS = '1';
    process.env.LIFEOS_MAX_DAILY_LIVE_MINUTES = '120';
    const env = createIsolatedDb('lifeos-guardian-voice-limits-');
    db = env.db;
    ({ acquireGuardianVoiceLease, releaseGuardianVoiceLease } = env.requireLib('guardian-voice-limits.ts'));
  });

  function createSession(sessionId) {
    db.prepare(`
      INSERT INTO guardian_sessions (session_id, target_title, started_at, duration_minutes)
      VALUES (?, 'Voice test', ?, 30)
    `).run(sessionId, Date.now());
  }

  it('allows only one active live session by default and releases it when the guardian ends', () => {
    createSession('session-a');
    createSession('session-b');
    assert.equal(acquireGuardianVoiceLease('session-a').allowed, true);

    const blocked = acquireGuardianVoiceLease('session-b');
    assert.deepEqual(blocked.allowed, false);
    assert.equal(blocked.reason, 'concurrent_session_limit');

    releaseGuardianVoiceLease('session-a');
    assert.equal(acquireGuardianVoiceLease('session-b').allowed, true);
  });

  it('limits repeated token minting for the same session', () => {
    createSession('session-a');
    assert.equal(acquireGuardianVoiceLease('session-a').allowed, true);
    assert.equal(acquireGuardianVoiceLease('session-a').allowed, true);
    assert.equal(acquireGuardianVoiceLease('session-a').allowed, true);

    const blocked = acquireGuardianVoiceLease('session-a');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'token_rate_limit');
  });

  it('does not authorize more than the daily Live voice budget', () => {
    process.env.LIFEOS_MAX_DAILY_LIVE_MINUTES = '10';
    createSession('session-a');
    createSession('session-b');
    assert.equal(acquireGuardianVoiceLease('session-a').allowed, true);
    releaseGuardianVoiceLease('session-a');

    const blocked = acquireGuardianVoiceLease('session-b');
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.reason, 'daily_voice_limit');
  });
});
