'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('diagnostics route', () => {
  it('reports canonical browser telemetry freshness', async () => {
    const env = createIsolatedDb('lifeos-diagnostics-route-');
    const observedStart = new Date(Date.now() - 10_000).toISOString();
    const observedEnd = new Date().toISOString();

    env.db.prepare(`
      INSERT INTO telemetry_events_v1 (
        event_id, version, device_id, source, observed_start, observed_end,
        duration_seconds, state, provenance_json, privacy_decision, privacy_reason
      ) VALUES (?, 1, 'test-browser', 'browser_extension', ?, ?, 10, 'active', '{}', 'allow', 'test')
    `).run('diagnostics-browser-event', observedStart, observedEnd);

    const { GET } = require('../../src/app/api/diagnostics/route.ts');
    const response = await GET({
      headers: {
        get(name) {
          return name.toLowerCase() === 'x-lifeos-auth-kind' ? 'bearer' : null;
        },
      },
    });
    const payload = await response.json();

    assert.equal(payload.telemetry.browser.status, 'fresh');
    assert.equal(payload.telemetry.browser.observedAt, observedEnd);
  });
});
