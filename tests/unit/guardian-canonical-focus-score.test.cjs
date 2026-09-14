'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('completed Guardian session focus score', () => {
  let db;
  let getHistory;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-canonical-session-focus-');
    db = env.db;
    delete require.cache[require.resolve('../../src/app/api/guardian/history/route.ts')];
    ({ GET: getHistory } = require('../../src/app/api/guardian/history/route.ts'));

    db.prepare(`
      INSERT INTO guardian_sessions (
        session_id, target_title, started_at, duration_minutes, state, evidence_pipeline_mode
      ) VALUES ('session-score-contract', 'Learn DSA', ?, 20, 'COMPLETE', 'shadow')
    `).run(Date.now() - 20 * 60_000);
    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id, target_title, duration_minutes, elapsed_minutes,
        average_focus_score, final_focus_score, completed_at, started_at
      ) VALUES ('session-score-contract', 'Learn DSA', 20, 20, 77, 83, datetime('now'), datetime('now', '-20 minutes'))
    `).run();

    const end = Date.now();
    const start = end - 20 * 60_000;
    const insertInterval = db.prepare(`
      INSERT INTO session_activity_intervals (
        interval_id, session_id, device_id, source, observed_start, observed_end,
        duration_seconds, state, category, score_eligible, counted,
        selection_reason, capture_status, evidence_json, engagement_state
      ) VALUES (?, 'session-score-contract', 'chrome-primary', 'chrome', ?, ?, ?,
        'active', ?, 1, 1, 'Verified Chrome telemetry',
        'verified_browser_telemetry', '{}', 'interactive')
    `);
    insertInterval.run(
      'canonical-productive',
      new Date(start).toISOString(),
      new Date(start + 15 * 60_000).toISOString(),
      15 * 60,
      'productive',
    );
    insertInterval.run(
      'canonical-neutral',
      new Date(start + 15 * 60_000).toISOString(),
      new Date(end).toISOString(),
      5 * 60,
      'neutral',
    );
  });

  it('exposes the full-evidence final score as the completed session score', async () => {
    const response = await getHistory();
    assert.equal(response.status, 200);

    const body = await response.json();
    const session = body.sessions.find((row) => row.session_id === 'session-score-contract');

    assert.equal(session.focus_score, 83);
    assert.equal(session.productive_minutes, 15);
    assert.equal(session.neutral_minutes, 5);
    assert.equal(session.distraction_minutes, 0);
    assert.equal(session.evidence_coverage_percent, 100);
  });

  it('uses the completed session score in the pending review queue', async () => {
    db.prepare(`
      INSERT INTO session_completions (session_id, status, created_at)
      VALUES ('session-score-contract', 'pending', datetime('now'))
    `).run();

    const response = await getHistory();
    const body = await response.json();
    const review = body.pendingCompletions.find((row) => row.session_id === 'session-score-contract');

    assert.ok(review);
    assert.equal(review.focus_score, 83);
  });
});
