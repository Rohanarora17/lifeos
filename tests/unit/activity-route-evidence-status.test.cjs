'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('activity evidence status API', () => {
  it('separates shadow Chrome capture from evidence used for scoring', async () => {
    const env = createIsolatedDb('lifeos-activity-evidence-status-');
    const db = env.db;
    const evidence = env.requireLib('guardian-evidence-store.ts');
    const { lifeosDateKey } = env.requireLib('timezone.ts');
    const now = Date.now();
    const sessionId = 'activity-shadow-session';
    db.prepare(`
      INSERT INTO guardian_sessions (
        session_id, target_title, started_at, duration_minutes, state, evidence_pipeline_mode
      ) VALUES (?, 'Graphs', ?, 25, 'ACTIVE', 'shadow')
    `).run(sessionId, now - 30_000);

    evidence.ingestGuardianEvidence([{
      schemaVersion: 2,
      eventId: 'activity-shadow-native',
      sequence: 1,
      collector: 'native',
      collectorVersion: '0.3.0',
      deviceId: 'macbook-primary',
      sessionId,
      observedStart: new Date(now - 30_000).toISOString(),
      observedEnd: new Date(now).toISOString(),
      capabilities: ['frontmost_app', 'input_idle'],
      privacy: { decision: 'allow', reason: 'guardian_session' },
      native: {
        frontmostApp: 'Google Chrome',
        windowTitle: 'Graphs lesson',
        systemState: 'active',
        inputIdleSeconds: 0,
        screenRecordingStatus: 'authorized',
        captureCapable: true,
        sensitive: false,
      },
      chrome: null,
    }, {
      schemaVersion: 2,
      eventId: 'activity-shadow-chrome',
      sequence: 1,
      collector: 'chrome',
      collectorVersion: '1.3.3',
      deviceId: 'chrome-primary',
      sessionId,
      observedStart: new Date(now - 30_000).toISOString(),
      observedEnd: new Date(now).toISOString(),
      capabilities: ['active_tab', 'interaction'],
      privacy: { decision: 'allow', reason: 'guardian_session' },
      native: null,
      chrome: {
        windowFocused: true,
        url: 'https://example.test/graphs',
        domain: 'example.test',
        title: 'Graphs lesson',
        interaction: { keyboard: true, pointer: false, scroll: false, navigation: false, lastInputAt: new Date(now).toISOString() },
        media: { playing: false, progressed: false, currentTime: null, title: null },
      },
    }], now + 20_000);

    const { GET } = require('../../src/app/api/activity/route.ts');
    const response = await GET(new Request(`http://lifeos.test/api/activity?date=${lifeosDateKey(now)}`));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.sourceSummary.chromeSeconds, 0);
    assert.ok(payload.sourceSummary.shadowChromeSeconds >= 29);
    assert.ok(payload.sourceSummary.shadowChromeSeconds <= 35);
    assert.equal(payload.evidenceHealth.sources.chrome, 'current');
  });
});
