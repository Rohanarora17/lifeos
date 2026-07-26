'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('telemetry event store', () => {
  let db;
  let ingestTelemetryEvents;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-telemetry-store-');
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
        collectorVersion: '1.0.0',
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
});
