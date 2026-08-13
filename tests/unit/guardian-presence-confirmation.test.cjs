'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Guardian presence confirmation', () => {
  let env;
  let db;
  let presence;
  let activity;
  const sessionId = 'session_presence_test';

  beforeEach(() => {
    env = createIsolatedDb('lifeos-guardian-presence-');
    db = env.db;
    presence = env.requireLib('guardian-presence.ts');
    activity = env.requireLib('session-activity.ts');
    db.prepare(`
      INSERT INTO guardian_sessions (session_id, target_title, started_at, duration_minutes, state)
      VALUES (?, 'Read algorithms', ?, 30, 'ACTIVE')
    `).run(sessionId, 1_000_000);
  });

  it('waits three minutes, makes static evidence unscored, and counts it after confirmation', () => {
    activity.recordSessionActivityInterval({
      sessionId,
      source: 'vision',
      observedStart: new Date(1_000_000).toISOString(),
      observedEnd: new Date(1_180_000).toISOString(),
      app: 'Preview',
      windowTitle: 'Algorithms.pdf',
      category: 'productive',
      selectionReason: 'Preview was frontmost.',
    });

    const early = presence.observeStaticActivity({
      sessionId, inputIdleSeconds: 179, app: 'Preview', observedAt: 1_179_000,
    });
    assert.equal(early.check, null);

    const observed = presence.observeStaticActivity({
      sessionId, inputIdleSeconds: 180, app: 'Preview',
      windowTitle: 'Algorithms.pdf', observedAt: 1_180_000,
    });
    assert.equal(observed.created, true);
    assert.equal(observed.check.secondsRemaining, 60);
    assert.deepEqual(db.prepare(`
      SELECT score_eligible, engagement_state, confirmation_status
      FROM session_activity_intervals WHERE session_id = ?
    `).get(sessionId), {
      score_eligible: 0,
      engagement_state: 'uncertain',
      confirmation_status: 'pending',
    });

    presence.resolvePresenceCheck(observed.check.checkId, 'still_working', 1_190_000);
    assert.equal(presence.hasRecentStillWorkingConfirmation(sessionId, 1_700_000), true);
    assert.equal(presence.hasRecentStillWorkingConfirmation(sessionId, 1_791_000), false);
    assert.deepEqual(db.prepare(`
      SELECT score_eligible, category, engagement_state, confirmation_status
      FROM session_activity_intervals WHERE session_id = ?
    `).get(sessionId), {
      score_eligible: 1,
      category: 'productive',
      engagement_state: 'confirmed_active',
      confirmation_status: 'confirmed',
    });
  });

  it('does not inherit keyboard or pointer idle time from before the session started', () => {
    assert.equal(presence.isWithinSessionPresenceGrace(sessionId, 1_030_000), true);
    const observed = presence.observeStaticActivity({
      sessionId, inputIdleSeconds: 900, app: 'Preview',
      windowTitle: 'Algorithms.pdf', observedAt: 1_030_000,
    });
    assert.equal(observed.created, false);
    assert.equal(observed.check, null);
  });

  it('uses recent task-aligned vision evidence before asking for confirmation', () => {
    db.prepare(`
      INSERT INTO screen_observations (
        observed_at, source, app, window_title, category, attention_quality,
        productive_for_goals, confidence, session_id, task_alignment,
        engagement_depth, change_magnitude
      ) VALUES (?, 'screen_vision', 'Preview', 'Algorithms.pdf', 'deep_work',
        'focused', 1, 0.92, ?, 88, 'active_learning', 'moderate')
    `).run(new Date(1_179_000).toISOString(), sessionId);

    assert.equal(presence.hasRecentTaskAlignedVisionEvidence({
      sessionId, app: 'Preview', windowTitle: 'Algorithms.pdf', now: 1_180_000,
    }), true);
    const observed = presence.observeStaticActivity({
      sessionId, inputIdleSeconds: 180, app: 'Preview',
      windowTitle: 'Algorithms.pdf', observedAt: 1_180_000,
    });
    assert.equal(observed.created, false);
    assert.equal(observed.check, null);
  });

  it('leaves an unanswered or break interval unscored', () => {
    const observed = presence.observeStaticActivity({
      sessionId, inputIdleSeconds: 181, app: 'Preview',
      windowTitle: 'Algorithms.pdf', observedAt: 1_181_000,
    });
    assert.equal(observed.timedOut, false);
    assert.equal(presence.observeStaticActivity({
      sessionId, inputIdleSeconds: 242, app: 'Preview', observedAt: 1_242_000,
    }).timedOut, true);

    presence.resolvePresenceCheck(observed.check.checkId, 'break', 1_242_000);
    const row = db.prepare(`
      SELECT SUM(score_eligible) AS eligible, MIN(engagement_state) AS state
      FROM session_activity_intervals WHERE presence_check_id = ?
    `).get(observed.check.checkId);
    assert.deepEqual(row, { eligible: 0, state: 'inactive' });
  });

  it('preserves verified interactive time before the static uncertainty window', () => {
    activity.recordSessionActivityInterval({
      sessionId,
      source: 'vision',
      observedStart: new Date(1_000_000).toISOString(),
      observedEnd: new Date(1_240_000).toISOString(),
      app: 'Preview', windowTitle: 'Algorithms.pdf', category: 'productive',
      selectionReason: 'Preview was frontmost.',
    });
    presence.observeStaticActivity({
      sessionId, inputIdleSeconds: 180, app: 'Preview',
      windowTitle: 'Algorithms.pdf', observedAt: 1_240_000,
    });
    const rows = db.prepare(`
      SELECT duration_seconds, score_eligible, engagement_state
      FROM session_activity_intervals ORDER BY observed_start
    `).all();
    assert.deepEqual(rows, [
      { duration_seconds: 60, score_eligible: 1, engagement_state: 'interactive' },
      { duration_seconds: 180, score_eligible: 0, engagement_state: 'uncertain' },
    ]);
  });
});
