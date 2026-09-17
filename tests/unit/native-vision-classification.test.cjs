'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('native Vision classification', { concurrency: false }, () => {
  it('uses recent semantic Vision evidence for the legacy interval of any selected app', async () => {
    const env = createIsolatedDb('lifeos-native-vision-classification-');
    const { db } = env;
    const now = Date.now();
    const sessionId = 'session-native-semantic-classification';
    db.prepare(`
      INSERT INTO guardian_sessions (
        session_id, target_title, started_at, duration_minutes, state,
        evidence_pipeline_mode
      ) VALUES (?, 'Learn probability', ?, 30, 'ACTIVE', 'shadow')
    `).run(sessionId, now - 60_000);

    const client = env.requireLib('guardian-client-status.ts');
    client.recordNativeClientHeartbeat({
      deviceId: 'test-macbook',
      clientVersion: '0.3.0',
      screenRecordingStatus: 'authorized',
      captureCapable: true,
      frontmostApp: 'Research Player',
      frontmostWindowTitle: 'Probability lecture',
      systemState: 'active',
      activeSessionId: sessionId,
    });
    db.prepare(`
      INSERT INTO screen_observations (
        observed_at, source, app, window_title, activity, category,
        productive_for_goals, confidence, session_id, task_alignment,
        engagement_depth
      ) VALUES (?, 'screen_vision', 'Research Player', 'Probability lecture',
        'Watching a probability lecture', 'consumption', 1, 0.98, ?, 96,
        'passive_consumption')
    `).run(new Date(now - 5_000).toISOString(), sessionId);

    const { POST } = require('../../src/app/api/native/ingest/route.ts');
    const response = await POST(new Request('http://lifeos.test/api/native/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'app_dwell',
        sessionId,
        appInFocus: 'Research Player',
        windowTitle: '',
        startedAt: new Date(now - 10_000).toISOString(),
        durationSeconds: 10,
      }),
    }));
    // app_dwell ticks the real Guardian runtime, which starts heartbeat
    // watchdogs; finish the isolated session so the test leaves no timers.
    env.requireLib('guardian-runtime.ts').endGuardianSession(sessionId);

    assert.equal(response.status, 200);
    assert.equal((await response.json()).category, 'productive');
    assert.equal(db.prepare(`
      SELECT category FROM session_activity_intervals
      WHERE session_id = ? AND source = 'vision'
      ORDER BY observed_start DESC LIMIT 1
    `).pluck().get(sessionId), 'productive');
  });
});
