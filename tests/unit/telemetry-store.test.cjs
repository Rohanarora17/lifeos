'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('telemetry event store', () => {
  let env;
  let db;
  let ingestTelemetryEvents;

  beforeEach(() => {
    env = createIsolatedDb('lifeos-telemetry-store-');
    db = env.db;
    ({ ingestTelemetryEvents } = env.requireLib('telemetry-store.ts'));
  });

  function event(eventId, overrides = {}) {
    return {
      version: 1,
      eventId,
      deviceId: 'macbook',
      source: 'browser_extension',
      observedStart: '2030-01-01T10:00:00.000Z',
      observedEnd: '2030-01-01T10:00:30.000Z',
      state: 'active',
      sessionId: null,
      application: { name: 'Chrome', bundleId: 'com.google.Chrome' },
      window: { id: '1', title: 'Paper', focused: true },
      tab: null,
      group: null,
      provenance: {
        collector: 'extension',
        collectorVersion: '1.3.1',
        adaptedFrom: null,
      },
      privacy: { decision: 'allow', reason: 'waking_hours_metadata' },
      ...overrides,
    };
  }

  it('stores a valid interval once and treats retries as duplicates', () => {
    const first = ingestTelemetryEvents([event('one')]);
    const second = ingestTelemetryEvents([event('one')]);

    assert.deepEqual(first, { accepted: 1, duplicates: 0, rejected: [] });
    assert.deepEqual(second, { accepted: 0, duplicates: 1, rejected: [] });
    const row = db.prepare('SELECT * FROM telemetry_events_v1 WHERE event_id = ?').get('one');
    assert.equal(row.duration_seconds, 30);
    assert.equal(row.state, 'active');
  });

  it('refreshes Chrome collector availability from telemetry outside a focus session', () => {
    const now = Date.now();
    const observedEnd = new Date(now).toISOString();
    const observedStart = new Date(now - 30_000).toISOString();
    const result = ingestTelemetryEvents([event('collector-heartbeat', {
      observedStart,
      observedEnd,
      sessionId: null,
    })]);

    assert.equal(result.accepted, 1);
    const row = db.prepare(`
      SELECT session_id, last_seen_at, window_focused, collector_version
      FROM browser_collector_status
      WHERE device_id = 'chrome:macbook'
    `).get();
    assert.deepEqual(row, {
      session_id: null,
      last_seen_at: observedEnd,
      window_focused: 1,
      collector_version: '1.3.1',
    });
    assert.equal(db.prepare('SELECT COUNT(*) FROM session_activity_intervals').pluck().get(), 0);
  });

  it('retains privacy provenance without storing redacted context', () => {
    const result = ingestTelemetryEvents([event('redacted', {
      privacy: { decision: 'redact', reason: 'sensitive_window' },
    })]);
    assert.equal(result.accepted, 1);
    const row = db.prepare('SELECT * FROM telemetry_events_v1 WHERE event_id = ?').get('redacted');
    assert.equal(row.context_json, null);
    assert.equal(row.privacy_decision, 'redact');
    assert.equal(row.privacy_reason, 'sensitive_window');
  });

  it('reports invalid events without storing them', () => {
    const result = ingestTelemetryEvents([event('bad', { observedEnd: 'invalid' })]);
    assert.equal(result.accepted, 0);
    assert.equal(result.rejected.length, 1);
    assert.ok(result.rejected[0].errors.includes('observedEnd'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM telemetry_events_v1').get().count, 0);
  });

  it('promotes session-scoped Chrome telemetry and replaces only overlapping Vision fallback', () => {
    const sessionId = 'session_browser_telemetry';
    const now = Date.now();
    const iso = offset => new Date(now + offset).toISOString();
    db.prepare(`
      INSERT INTO guardian_sessions (session_id, target_title, started_at, duration_minutes, state)
      VALUES (?, 'Browser telemetry test', ?, 30, 'ACTIVE')
    `).run(sessionId, now - 60_000);

    const client = env.requireLib('guardian-client-status.ts');
    const activity = env.requireLib('session-activity.ts');
    client.recordNativeClientHeartbeat({
      deviceId: 'test-macbook', clientVersion: '1.0.0',
      screenRecordingStatus: 'authorized', captureCapable: true,
      frontmostApp: 'Google Chrome', frontmostWindowTitle: 'GitHub',
      systemState: 'active', activeSessionId: sessionId,
    });
    activity.recordSessionActivityInterval({
      sessionId, source: 'vision', observedStart: iso(-60_000), observedEnd: iso(0),
      app: 'Google Chrome', title: 'Google Chrome', category: 'neutral',
      selectionReason: 'Temporary Vision fallback.',
    });

    const browserEvent = event('guardian-browser', {
      observedStart: iso(-40_000),
      observedEnd: iso(-10_000),
      sessionId,
      window: { id: '1', title: 'GitHub', focused: true },
      tab: {
        id: 7, url: 'https://github.com/Rohanarora17/lifeos',
        domain: 'github.com', title: 'Rohanarora17/lifeos',
        lastAccessed: now - 10_000, frozen: false, groupId: -1,
      },
      privacy: { decision: 'allow', reason: 'guardian_focus_session' },
    });

    assert.equal(ingestTelemetryEvents([browserEvent]).accepted, 1);
    assert.equal(client.getBrowserCollectorState(sessionId, now).fresh, true);
    const rows = db.prepare(`
      SELECT source, observed_start, observed_end, duration_seconds, domain, capture_status
      FROM session_activity_intervals
      WHERE session_id = ?
      ORDER BY observed_start
    `).all(sessionId);
    assert.deepEqual(rows.map(row => [row.source, row.duration_seconds, row.domain]), [
      ['vision', 20, null],
      ['chrome', 30, 'github.com'],
      ['vision', 10, null],
    ]);
    assert.equal(rows[1].capture_status, 'verified_browser_telemetry');

    assert.equal(ingestTelemetryEvents([browserEvent]).duplicates, 1);
    assert.equal(db.prepare(`
      SELECT SUM(duration_seconds) AS seconds
      FROM session_activity_intervals WHERE session_id = ?
    `).get(sessionId).seconds, 60);
  });
});
