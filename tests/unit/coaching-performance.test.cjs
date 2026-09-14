'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('session performance learning', () => {
  let db;
  let performance;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-session-performance-');
    db = env.db;
    performance = env.requireLib('coaching-performance.ts');
  });

  function addSession({ id, daysAgo, hour, planned, elapsed, focus, trajectoryAverage = focus }) {
    const at = new Date(Date.now() - daysAgo * 86_400_000);
    at.setHours(hour, 0, 0, 0);
    const timestamp = at.toISOString();
    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id, target_title, duration_minutes, elapsed_minutes,
        average_focus_score, final_focus_score, completed_at, started_at
      ) VALUES (?, 'Study', ?, ?, ?, ?, ?, ?)
    `).run(id, planned, elapsed, trajectoryAverage, focus, timestamp, timestamp);
  }

  it('learns duration from sessions that were substantially completed', () => {
    addSession({ id: 'good-1', daysAgo: 1, hour: 9, planned: 30, elapsed: 30, focus: 80 });
    addSession({ id: 'good-2', daysAgo: 2, hour: 9, planned: 30, elapsed: 28, focus: 76 });
    addSession({ id: 'good-3', daysAgo: 3, hour: 10, planned: 40, elapsed: 35, focus: 70 });
    addSession({ id: 'abandoned-1', daysAgo: 4, hour: 16, planned: 90, elapsed: 12, focus: 25 });
    addSession({ id: 'abandoned-2', daysAgo: 5, hour: 16, planned: 90, elapsed: 10, focus: 20 });

    const profile = performance.getSessionPerformanceProfile();
    assert.equal(profile.sampleSize, 5);
    assert.equal(profile.confidence, 'medium');
    assert.equal(profile.recommendedMinutes, 30);
    assert.deepEqual(profile.bestStartHours, [9]);
    assert.ok(profile.completedAsPlannedRate < 1);
  });

  it('labels a material recent outcome decline', () => {
    for (let i = 0; i < 3; i++) {
      addSession({ id: `recent-${i}`, daysAgo: i + 1, hour: 14, planned: 30, elapsed: 12, focus: 30 });
      addSession({ id: `prior-${i}`, daysAgo: i + 5, hour: 10, planned: 30, elapsed: 30, focus: 82 });
    }
    assert.equal(performance.getSessionPerformanceProfile().trend, 'declining');
  });

  it('stays explicit about insufficient evidence', () => {
    const profile = performance.getSessionPerformanceProfile();
    assert.equal(profile.confidence, 'insufficient');
    assert.equal(profile.recommendedMinutes, null);
    assert.equal(profile.trend, 'unknown');
  });

  it('learns from the full-evidence completed score rather than the live trajectory average', () => {
    addSession({
      id: 'different-live-and-final',
      daysAgo: 1,
      hour: 9,
      planned: 20,
      elapsed: 20,
      trajectoryAverage: 77,
      focus: 83,
    });

    assert.equal(performance.getSessionPerformanceProfile().averageFocusScore, 83);
  });
});
