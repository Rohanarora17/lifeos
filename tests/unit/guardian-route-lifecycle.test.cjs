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
      clientVersion: '0.3.0',
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
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const plan = db.prepare(`
      INSERT INTO daily_plans (plan_date, status, created_at, updated_at)
      VALUES (?, 'active', datetime('now'), datetime('now'))
    `).run(today);
    const plannedStart = new Date();
    db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, title, planned_start, planned_end, duration_minutes, status
      ) VALUES ('route-planned-session', ?, 'Audit polynomial commitment research', ?, ?, 25, 'planned')
    `).run(plan.lastInsertRowid, plannedStart.toISOString(), new Date(plannedStart.getTime() + 25 * 60_000).toISOString());

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
    const startedCommitment = db.prepare(`
      SELECT state, session_id FROM coaching_commitments
      WHERE source_type='planned_focus' AND source_id='route-planned-session'
    `).get();
    assert.equal(startedCommitment.state, 'started');
    assert.equal(startedCommitment.session_id, sessionId);
    assert.equal(
      db.prepare("SELECT status FROM planned_focus_sessions WHERE id='route-planned-session'").pluck().get(),
      'started',
    );
    recordBrowserCollectorHeartbeat({
      deviceId: 'test-chrome',
      sessionId,
      windowFocused: true,
      collectorVersion: '1.3.1',
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
          payload: { browserWindowFocused: true, collectorVersion: '1.3.1' },
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
    const completedCommitment = db.prepare(`
      SELECT state, outcome_score, completion_ratio FROM coaching_commitments
      WHERE source_type='planned_focus' AND source_id='route-planned-session'
    `).get();
    assert.equal(completedCommitment.state, 'abandoned');
    assert.equal(completedCommitment.outcome_score, 0);
    assert.ok(completedCommitment.completion_ratio < 0.8);
    assert.equal(
      db.prepare("SELECT status FROM planned_focus_sessions WHERE id='route-planned-session'").pluck().get(),
      'skipped',
    );
    sessionId = null;
  });
});
