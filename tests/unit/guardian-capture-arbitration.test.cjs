'use strict';

const { after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Guardian capture arbitration', () => {
  let env;
  let db;
  let client;
  let activity;
  const sessionId = 'session_capture_test';

  beforeEach(() => {
    process.env.LIFEOS_REQUIRE_VISION_CLIENT = 'true';
    env = createIsolatedDb('lifeos-guardian-capture-');
    db = env.db;
    client = env.requireLib('guardian-client-status.ts');
    activity = env.requireLib('session-activity.ts');
    db.prepare(`
      INSERT INTO guardian_sessions (session_id, target_title, started_at, duration_minutes, state)
      VALUES (?, 'Capture test', ?, 30, 'ACTIVE')
    `).run(sessionId, Date.now());
  });

  after(() => {
    delete process.env.LIFEOS_REQUIRE_VISION_CLIENT;
  });

  function heartbeat(app, systemState = 'active') {
    return client.recordNativeClientHeartbeat({
      deviceId: 'test-macbook',
      clientVersion: '1.0.0',
      screenRecordingStatus: 'authorized',
      captureCapable: true,
      frontmostApp: app,
      frontmostWindowTitle: 'Working document',
      systemState,
      activeSessionId: sessionId,
    });
  }

  it('selects Chrome only when Chrome is frontmost and extension evidence is fresh', () => {
    heartbeat('Google Chrome');
    client.recordBrowserCollectorHeartbeat({
      deviceId: 'test-chrome', sessionId, windowFocused: true, collectorVersion: '1.0.0',
    });
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'chrome').accepted, true);
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'vision').accepted, false);
  });

  it('keeps a 30-second MV3 alarm heartbeat fresh through normal scheduler jitter', () => {
    const now = Date.now();
    heartbeat('Google Chrome');
    client.recordBrowserCollectorHeartbeat({
      deviceId: 'test-chrome', sessionId, windowFocused: true,
      collectorVersion: '1.2.0', observedAt: new Date(now - 35_000).toISOString(),
    });
    assert.equal(client.getBrowserCollectorState(sessionId, now).fresh, true);
    assert.equal(client.getBrowserCollectorState(sessionId, now + 39_000).fresh, true);
    assert.equal(client.getBrowserCollectorState(sessionId, now + 41_000).fresh, false);
  });

  it('suppresses background Chrome while Preview or VS Code is frontmost', () => {
    heartbeat('Preview');
    client.recordBrowserCollectorHeartbeat({
      deviceId: 'test-chrome', sessionId, windowFocused: true, collectorVersion: '1.0.0',
    });
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'chrome').accepted, false);
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'vision').accepted, true);

    heartbeat('Visual Studio Code');
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'chrome').accepted, false);
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'vision').accepted, true);
  });

  it('falls back to vision when Chrome is frontmost but extension evidence is absent', () => {
    heartbeat('Google Chrome');
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'chrome').accepted, false);
    const fallback = activity.arbitrateSessionActivity(sessionId, 'vision');
    assert.equal(fallback.accepted, true);
    assert.match(fallback.reason, /extension telemetry was unavailable or stale/);
  });

  it('uses native state once for idle and marks it unscored', () => {
    heartbeat('Google Chrome', 'idle');
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'idle').accepted, true);
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'chrome').accepted, false);
    activity.recordSessionActivityInterval({
      sessionId,
      source: 'idle',
      observedStart: '2030-01-01T10:00:00.000Z',
      observedEnd: '2030-01-01T10:00:05.000Z',
      state: 'idle',
      category: 'neutral',
      scoreEligible: false,
      selectionReason: 'Native system state is authoritative for idle and lock status.',
    });
    const row = db.prepare('SELECT source, score_eligible, duration_seconds FROM session_activity_intervals').get();
    assert.deepEqual(row, { source: 'idle', score_eligible: 0, duration_seconds: 5 });
  });

  it('counts verified foreground media while input-idle but never while locked', () => {
    heartbeat('Google Chrome', 'idle');
    client.recordBrowserCollectorHeartbeat({
      deviceId: 'test-chrome', sessionId, windowFocused: true,
      collectorVersion: '1.2.0', mediaPlaybackActive: true,
      mediaTitle: 'Lecture 2: Contradiction and Induction',
    });
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'chrome').accepted, true);
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'idle').accepted, false);

    heartbeat('Google Chrome', 'locked');
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'chrome').accepted, false);
    assert.equal(activity.arbitrateSessionActivity(sessionId, 'idle').accepted, true);
  });

  it('does not inflate dwell when a collector retries the same interval', () => {
    heartbeat('Preview');
    const interval = {
      sessionId,
      source: 'vision',
      observedStart: '2030-01-01T10:00:00.000Z',
      observedEnd: '2030-01-01T10:00:05.000Z',
      app: 'Preview',
      category: 'productive',
      scoreEligible: true,
      selectionReason: 'Preview was frontmost.',
    };
    const firstId = activity.recordSessionActivityInterval(interval);
    const retryId = activity.recordSessionActivityInterval(interval);
    assert.equal(retryId, firstId);
    const row = db.prepare(`
      SELECT COUNT(*) AS count, SUM(duration_seconds) AS seconds
      FROM session_activity_intervals
    `).get();
    assert.deepEqual(row, { count: 1, seconds: 5 });
  });

  it('computes focus from canonical intervals instead of contradictory raw events', () => {
    const { computeFocusScore } = require('../../src/lib/focus-score.ts');
    const state = {
      tick: 1,
      startedAt: Date.now() - 10_000,
      totalPausedMs: 0,
      focusScoreHistory: [],
      screenContext: null,
      tabEventLog: [{
        type: 'tab', dwellSeconds: 10, domain: 'distraction.example',
        payload: { classification: 'distraction', captureSource: 'chrome' },
      }],
    };
    const canonical = [{
      source: 'vision', durationSeconds: 10, state: 'active', domain: 'Preview',
      category: 'productive', scoreEligible: true, evidence: {},
    }];
    const supported = computeFocusScore(state, undefined, null, canonical);
    assert.equal(supported.onTopicSeconds, 10);
    assert.equal(supported.distractionCount, 0);
    assert.ok(supported.score > 40);
  });

  it('reports stale and permission failures as not ready', () => {
    const ready = heartbeat('Preview');
    assert.equal(ready.ready, true);
    assert.equal(client.getGuardianClientReadiness(Date.parse(ready.lastSeenAt) + 16_000).reason, 'stale');
    client.recordNativeClientHeartbeat({
      deviceId: 'test-macbook',
      screenRecordingStatus: 'denied',
      captureCapable: false,
      frontmostApp: 'Preview',
    });
    assert.equal(client.getGuardianClientReadiness().reason, 'permission_required');
  });

  it('expires stale scheduled commitments and keeps future AI-plan provenance', () => {
    db.prepare(`
      INSERT INTO soft_watch_commitments (
        id, target_title, intended_start_at, planned_minutes, source, status, created_at
      ) VALUES
        ('expired', 'Old block', ?, 30, 'next_day_plan', 'pending', ?),
        ('future', 'Current block', ?, 30, 'next_day_plan', 'pending', ?)
    `).run(Date.now() - 60_000, Date.now() - 120_000, Date.now() + 30 * 60_000, Date.now());
    const { getUpcomingCommitments } = env.requireLib('longitudinal-engine.ts');
    const upcoming = getUpcomingCommitments();
    assert.equal(upcoming.length, 1);
    assert.equal(upcoming[0].id, 'future');
    assert.equal(upcoming[0].source, 'next_day_plan');
    assert.equal(db.prepare(`SELECT status FROM soft_watch_commitments WHERE id = 'expired'`).pluck().get(), 'expired');
  });
});

describe('LifeOS timezone formatting', () => {
  it('renders an 18:45 IST instant as 18:45 rather than adding the offset twice', () => {
    const { lifeosTime } = require('../../src/lib/timezone.ts');
    const value = Date.parse('2026-08-05T13:15:00.000Z');
    assert.match(lifeosTime(value, { hour12: false }), /18:45/);
  });

  it('queries an IST calendar day using explicit UTC boundaries', () => {
    const { lifeosDayBoundsUtc } = require('../../src/lib/timezone.ts');
    assert.deepEqual(lifeosDayBoundsUtc('2026-08-05'), {
      startIso: '2026-08-04T18:30:00.000Z',
      endIso: '2026-08-05T18:30:00.000Z',
    });
  });
});

describe('Guardian client-gated session lifecycle', () => {
  it('blocks without a client, deduplicates start retries, and auto-pauses/resumes', () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.LIFEOS_REQUIRE_VISION_CLIENT = 'true';
    const env = createIsolatedDb('lifeos-guardian-client-lifecycle-');
    const client = env.requireLib('guardian-client-status.ts');
    const runtime = env.requireLib('guardian-runtime.ts');

    assert.throws(
      () => runtime.startGuardianSession({ topic: 'Blocked start', durationMinutes: 10, startRequestId: 'blocked' }),
      error => error?.code === 'vision_client_required',
    );

    client.recordNativeClientHeartbeat({
      deviceId: 'lifecycle-macbook',
      clientVersion: '1.0.0',
      screenRecordingStatus: 'authorized',
      captureCapable: true,
      frontmostApp: 'Preview',
      systemState: 'active',
    });
    const first = runtime.startGuardianSession({
      topic: 'Idempotent capture session', durationMinutes: 10, source: 'api', startRequestId: 'same-start-request',
    });
    const retry = runtime.startGuardianSession({
      topic: 'Idempotent capture session', durationMinutes: 10, source: 'api', startRequestId: 'same-start-request',
    });
    assert.equal(retry.sessionId, first.sessionId);
    assert.deepEqual(first.focusScoreHistory, []);

    env.db.prepare(`UPDATE native_client_status SET last_seen_at = ? WHERE device_id = ?`)
      .run(new Date(Date.now() - 20_000).toISOString(), 'lifecycle-macbook');
    assert.equal(runtime.getActiveGuardianSession().state, 'BREAK');
    assert.equal(runtime.getActiveGuardianSession().pauseReason, 'client_unavailable');

    client.recordNativeClientHeartbeat({
      deviceId: 'lifecycle-macbook',
      clientVersion: '1.0.0',
      screenRecordingStatus: 'authorized',
      captureCapable: true,
      frontmostApp: 'Preview',
      systemState: 'active',
    });
    assert.equal(runtime.getActiveGuardianSession().state, 'ACTIVE');
    assert.equal(runtime.getActiveGuardianSession().pauseReason, null);
    runtime.endGuardianSession(first.sessionId);
    delete process.env.LIFEOS_REQUIRE_VISION_CLIENT;
  });
});
