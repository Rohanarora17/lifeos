'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const env = createIsolatedDb('lifeos-telemetry-contract-');
const {
  telemetryDurationSeconds,
  validateTelemetryEventV1,
} = env.requireLib('telemetry-contract.ts');

function validEvent(overrides = {}) {
  return {
    version: 1,
    eventId: 'device-a:42',
    deviceId: 'device-a',
    source: 'browser_extension',
    observedStart: '2030-01-01T10:00:00.000Z',
    observedEnd: '2030-01-01T10:00:30.000Z',
    state: 'active',
    sessionId: 'focus-1',
    application: { name: 'Google Chrome', bundleId: 'com.google.Chrome' },
    window: { id: '17', title: 'Research', focused: true },
    tab: {
      id: 3,
      url: 'https://example.com/paper',
      domain: 'example.com',
      title: 'Paper',
      lastAccessed: 1_893_484_800_000,
      frozen: false,
      groupId: -1,
    },
    group: {
      id: null,
      title: null,
      lifeosManaged: false,
      relevanceConfidence: 0.9,
    },
    provenance: {
      collector: 'lifeos-extension',
      collectorVersion: '1.0.0',
      adaptedFrom: null,
    },
    privacy: { decision: 'allow', reason: 'waking_hours_metadata' },
    ...overrides,
  };
}

describe('TelemetryEventV1', () => {
  it('normalizes an observed interval and computes duration', () => {
    const result = validateTelemetryEventV1(validEvent());
    assert.equal(result.ok, true);
    assert.equal(telemetryDurationSeconds(result.event), 30);
    assert.equal(result.event.tab.lastAccessed, 1_893_484_800_000);
  });

  it('rejects reversed and implausibly long intervals', () => {
    const reversed = validateTelemetryEventV1(validEvent({
      observedStart: '2030-01-01T10:01:00.000Z',
      observedEnd: '2030-01-01T10:00:00.000Z',
    }));
    assert.equal(reversed.ok, false);
    assert.ok(reversed.errors.includes('observedInterval'));

    const long = validateTelemetryEventV1(validEvent({
      observedEnd: '2030-01-02T10:00:00.000Z',
    }));
    assert.equal(long.ok, false);
    assert.ok(long.errors.includes('observedInterval'));
  });

  it('removes contextual metadata when privacy says redact or drop', () => {
    for (const decision of ['redact', 'drop']) {
      const result = validateTelemetryEventV1(validEvent({
        privacy: { decision, reason: 'sensitive_window' },
      }));
      assert.equal(result.ok, true);
      assert.equal(result.event.application, null);
      assert.equal(result.event.window, null);
      assert.equal(result.event.tab, null);
      assert.equal(result.event.group, null);
    }
  });

  it('rejects unknown states, sources, and unbounded confidence', () => {
    assert.equal(validateTelemetryEventV1(validEvent({ state: 'away' })).ok, false);
    assert.equal(validateTelemetryEventV1(validEvent({ source: 'mystery' })).ok, false);
    assert.equal(validateTelemetryEventV1(validEvent({
      group: { lifeosManaged: false, relevanceConfidence: 1.2 },
    })).ok, false);
  });
});
