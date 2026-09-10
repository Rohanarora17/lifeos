'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  guardianIntervalStart,
  isWithinWakingHours,
  recoverPersistedInterval,
  shouldCollectTelemetry,
  shouldTreatMediaPlaybackAsActive,
  shouldGroupTab,
  transitionInterval,
} = require('../../extension/activity-state.js');

describe('extension activity state machine', () => {
  it('supports waking windows that cross midnight', () => {
    assert.equal(isWithinWakingHours(new Date(2030, 0, 1, 8), 7, 1), true);
    assert.equal(isWithinWakingHours(new Date(2030, 0, 1, 0), 7, 1), true);
    assert.equal(isWithinWakingHours(new Date(2030, 0, 1, 3), 7, 1), false);
  });

  it('keeps observed active use outside the configured schedule', () => {
    assert.equal(shouldCollectTelemetry(false, 'active'), true);
    assert.equal(shouldCollectTelemetry(false, 'idle'), false);
    assert.equal(shouldCollectTelemetry(false, 'locked'), false);
    assert.equal(shouldCollectTelemetry(true, 'idle'), true);
  });

  it('keeps telemetry running throughout an active Guardian session', () => {
    assert.equal(shouldCollectTelemetry(false, 'idle', true), true);
    assert.equal(shouldCollectTelemetry(false, 'locked', true), true);
  });

  it('treats foreground playback as active while input-idle, but not while locked', () => {
    assert.equal(shouldTreatMediaPlaybackAsActive('idle', true), true);
    assert.equal(shouldTreatMediaPlaybackAsActive('active', true), true);
    assert.equal(shouldTreatMediaPlaybackAsActive('idle', false), false);
    assert.equal(shouldTreatMediaPlaybackAsActive('locked', true), false);
  });

  it('anchors the first interval at session start without inventing an unverified long backfill', () => {
    assert.equal(guardianIntervalStart(100_000, 101_000), 100_000);
    assert.equal(guardianIntervalStart(50_000, 101_000), 86_000);
    assert.equal(guardianIntervalStart(undefined, 101_000), 101_000);
  });

  it('closes the prior interval exactly at a focus or state transition', () => {
    const current = {
      eventId: 'one',
      state: 'active',
      tabId: 1,
      windowId: 2,
      url: 'https://one.example',
      sessionId: null,
      startedAt: 1_000,
      lastObservedAt: 1_000,
    };
    const result = transitionInterval(current, {
      eventId: 'two',
      state: 'unfocused',
      tabId: null,
      windowId: null,
      url: null,
      sessionId: null,
    }, 31_000);
    assert.equal(result.closed.endedAt, 31_000);
    assert.equal(result.current.state, 'unfocused');
    assert.equal(result.current.startedAt, 31_000);
  });

  it('does not create duplicate intervals for the same context', () => {
    const current = {
      eventId: 'one',
      state: 'active',
      tabId: 1,
      windowId: 2,
      url: 'https://one.example',
      sessionId: 'session',
      startedAt: 1_000,
      lastObservedAt: 1_000,
    };
    const result = transitionInterval(current, { ...current }, 5_000);
    assert.equal(result.closed, null);
    assert.equal(result.current.startedAt, 1_000);
    assert.equal(result.current.lastObservedAt, 5_000);
  });

  it('rolls sustained activity into bounded intervals for server freshness', () => {
    const current = {
      eventId: 'one',
      state: 'active',
      tabId: 1,
      windowId: 2,
      url: 'domain://example.test',
      sessionId: null,
      startedAt: 1_000,
      lastObservedAt: 31_000,
    };
    const next = { ...current, eventId: 'two' };
    const result = transitionInterval(current, next, 61_000);

    assert.equal(result.closed.eventId, 'one');
    assert.equal(result.closed.endedAt, 61_000);
    assert.equal(result.current.eventId, 'two');
    assert.equal(result.current.startedAt, 61_000);
  });

  it('caps a service-worker gap at the last observed timestamp', () => {
    const result = recoverPersistedInterval({
      eventId: 'one',
      state: 'active',
      startedAt: 1_000,
      lastObservedAt: 31_000,
    }, 300_000, 90_000);
    assert.equal(result.closed.endedAt, 31_000);
    assert.equal(result.closed.recoveryReason, 'worker_gap');
    assert.equal(result.current, null);
  });

  it('preserves existing groups and requires explicit or high-confidence relevance', () => {
    assert.equal(shouldGroupTab({
      currentGroupId: 12,
      openerGroupId: 4,
      sessionGroupId: 4,
    }), false);
    assert.equal(shouldGroupTab({
      currentGroupId: -1,
      openerGroupId: 4,
      sessionGroupId: 4,
    }), true);
    assert.equal(shouldGroupTab({
      currentGroupId: -1,
      openerGroupId: null,
      sessionGroupId: 4,
      relevanceConfidence: 0.84,
    }), false);
    assert.equal(shouldGroupTab({
      currentGroupId: -1,
      openerGroupId: null,
      sessionGroupId: 4,
      relevanceConfidence: 0.85,
    }), true);
  });
});
