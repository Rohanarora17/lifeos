'use strict';

const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('guardian route lifecycle', () => {
  let db;
  let startPOST;
  let eventsPOST;
  let stateGET;
  let endPOST;
  let sessionId;
  let recordBrowserCollectorHeartbeat;

  before(() => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const env = createIsolatedDb('lifeos-guardian-routes-');
    db = env.db;
    process.env.LIFEOS_REQUIRE_VISION_CLIENT = 'true';
    const clientStatus = env.requireLib('guardian-client-status.ts');
    const { recordNativeClientHeartbeat } = clientStatus;
    ({ recordBrowserCollectorHeartbeat } = clientStatus);
    recordNativeClientHeartbeat({
      deviceId: 'test-macbook',
      clientVersion: 'test',
      screenRecordingStatus: 'authorized',
      captureCapable: true,
      frontmostApp: 'Google Chrome',
      frontmostWindowTitle: 'Polynomial commitments paper',
      systemState: 'active',
    });
    ({ POST: startPOST } = require(
      '../../src/app/api/guardian/session/start/route.ts'
    ));
    ({ POST: eventsPOST } = require(
      '../../src/app/api/guardian/events/route.ts'
    ));
    ({ GET: stateGET } = require(
      '../../src/app/api/guardian/state/route.ts'
    ));
    ({ POST: endPOST } = require(
      '../../src/app/api/guardian/session/end/route.ts'
    ));
  });

  after(async () => {
    if (sessionId) {
      await endPOST(
        new Request('http://lifeos.test/api/guardian/session/end', {
          method: 'POST',
          body: JSON.stringify({ sessionId }),
        })
      );
    }
    delete process.env.LIFEOS_REQUIRE_VISION_CLIENT;
  });

  it('starts, ingests browser context, exposes state, and completes', async () => {
    const startResponse = await startPOST(
      new Request('http://lifeos.test/api/guardian/session/start', {
        method: 'POST',
        body: JSON.stringify({
          topic: 'Audit polynomial commitment research',
          durationMinutes: 25,
          mood: 'medium',
          source: 'api',
          startRequestId: 'guardian-route-lifecycle-start',
        }),
      })
    );
    assert.equal(startResponse.status, 200);
    const started = await startResponse.json();
    assert.equal(started.success, true);
    assert.equal(started.session.state, 'ACTIVE');
    assert.equal(started.session.targetTitle, 'Audit polynomial commitment research');
    sessionId = started.session.sessionId;
    recordBrowserCollectorHeartbeat({
      deviceId: 'test-chrome',
      sessionId,
      windowFocused: true,
      collectorVersion: 'test',
    });

    const eventResponse = await eventsPOST(
      new Request('http://lifeos.test/api/guardian/events', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          type: 'tab',
          url: 'https://eprint.iacr.org/2020/081',
          title: 'Polynomial commitments paper',
          dwellSeconds: 30,
          tabStartedAt: Date.now() - 30_000,
          payload: { browserWindowFocused: true, collectorVersion: 'test' },
        }),
      })
    );
    assert.equal(eventResponse.status, 200);
    const event = await eventResponse.json();
    assert.equal(event.success, true);
    assert.equal(event.session.currentUrl, 'https://eprint.iacr.org/2020/081');
    assert.equal(typeof event.decision.type, 'string');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const activity = db
      .prepare(
        `SELECT category, classification_confidence as confidence
         FROM activities
         WHERE device_name = 'LifeOS Guardian'
         ORDER BY id DESC
         LIMIT 1`
      )
      .get();
    assert.equal(activity.category, 'neutral');
    assert.equal(activity.confidence, 'low');

    const stateResponse = await stateGET(
      new Request(
        `http://lifeos.test/api/guardian/state?sessionId=${sessionId}`
      )
    );
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.equal(state.state, 'ACTIVE');
    assert.equal(state.targetTitle, 'Audit polynomial commitment research');
    assert.equal(typeof state.focusScore, 'number');

    const endResponse = await endPOST(
      new Request('http://lifeos.test/api/guardian/session/end', {
        method: 'POST',
        body: JSON.stringify({ sessionId }),
      })
    );
    assert.equal(endResponse.status, 200);
    const ended = await endResponse.json();
    assert.equal(ended.success, true);
    assert.equal(ended.session.state, 'COMPLETE');

    const persisted = db
      .prepare(
        'SELECT state FROM guardian_sessions WHERE session_id = ?'
      )
      .get(sessionId);
    assert.equal(persisted.state, 'COMPLETE');
    sessionId = null;
  });
});
