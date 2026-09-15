'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  intelligenceRefreshDisposition,
  shouldRunScheduledIntelligenceRefresh,
} = require('../../src/lib/intelligence-refresh-policy.ts');

describe('unified intelligence refresh policy', () => {
  it('records noisy telemetry without rebuilding the full profile', () => {
    assert.equal(intelligenceRefreshDisposition('native_app_dwell'), 'dirty_only');
    assert.equal(intelligenceRefreshDisposition('native_screen_observation'), 'dirty_only');
    assert.equal(intelligenceRefreshDisposition('alert_suppressed:task_reminder'), 'ignore');
  });

  it('queues synthesis after meaningful evidence', () => {
    assert.equal(intelligenceRefreshDisposition('session_end'), 'synthesize');
    assert.equal(intelligenceRefreshDisposition('evening_checkin'), 'synthesize');
    assert.equal(intelligenceRefreshDisposition('activity_correction'), 'synthesize');
    assert.equal(intelligenceRefreshDisposition('native_app_classification'), 'synthesize');
    assert.equal(intelligenceRefreshDisposition('alert_feedback:not_helpful'), 'synthesize');
  });

  it('runs the scheduled backstop only when dirty and no session is active', () => {
    assert.equal(shouldRunScheduledIntelligenceRefresh({ dirty: true, activeSession: false }), true);
    assert.equal(shouldRunScheduledIntelligenceRefresh({ dirty: false, activeSession: false }), false);
    assert.equal(shouldRunScheduledIntelligenceRefresh({ dirty: true, activeSession: true }), false);
  });
});
