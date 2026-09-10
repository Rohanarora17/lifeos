'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Guardian activity correction propagation', () => {
  let db;
  let patchActivity;
  let getActivity;
  let personalization;
  const sessionId = 'session-correction-test';
  const intervalId = 'interval-correction-test';

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-activity-correction-');
    db = env.db;
    ({ PATCH: patchActivity, GET: getActivity } = require('../../src/app/api/activity/route.ts'));
    personalization = require('../../src/lib/personalization-context.ts');

    const startedAt = Date.now() - 10 * 60_000;
    db.prepare(`
      INSERT INTO guardian_sessions (
        session_id, target_title, started_at, duration_minutes, state, evidence_pipeline_mode
      ) VALUES (?, 'Study DSA', ?, 10, 'COMPLETE', 'shadow')
    `).run(sessionId, startedAt);
    db.prepare(`
      INSERT INTO session_activity_intervals (
        interval_id, session_id, device_id, source, observed_start, observed_end,
        duration_seconds, state, app, window_title, url, domain, title, category,
        subcategory, score_eligible, counted, selection_reason, capture_status,
        evidence_json, engagement_state
      ) VALUES (?, ?, 'chrome-primary', 'chrome', ?, ?, 600, 'active',
        'Google Chrome', 'Algorithms', 'https://example.com/dsa', 'example.com',
        'Algorithms', 'neutral', 'browser_telemetry', 1, 1,
        'Verified Chrome telemetry', 'verified_browser_telemetry', '{}', 'interactive')
    `).run(
      intervalId,
      sessionId,
      new Date(startedAt).toISOString(),
      new Date(startedAt + 10 * 60_000).toISOString(),
    );
    db.prepare(`
      INSERT INTO guardian_session_summaries (
        session_id, target_title, started_at, duration_minutes, elapsed_minutes,
        average_focus_score, final_focus_score, distraction_events,
        productive_events, neutral_events, completed_at
      ) VALUES (?, 'Study DSA', ?, 10, 10, 46, 46, 0, 0, 1, datetime('now'))
    `).run(sessionId, new Date(startedAt).toISOString());
  });

  it('recomputes a completed session and teaches future classification', async () => {
    const response = await patchActivity(new Request('http://lifeos.test/api/activity', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: `interval:${intervalId}`, category: 'productive' }),
    }));

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.recomputedSession, sessionId);

    assert.deepEqual(db.prepare(`
      SELECT category FROM session_activity_intervals WHERE interval_id = ?
    `).get(intervalId), { category: 'productive' });
    assert.equal(
      db.prepare(`SELECT classification FROM session_domain_classifications WHERE session_id = ? AND domain = ?`)
        .pluck().get(sessionId, 'example.com'),
      'on_topic',
    );

    const summary = db.prepare(`
      SELECT average_focus_score, final_focus_score,
             productive_events, neutral_events
      FROM guardian_session_summaries WHERE session_id = ?
    `).get(sessionId);
    assert.ok(summary.average_focus_score > 46);
    assert.ok(summary.final_focus_score > 46);
    assert.equal(summary.productive_events, 1);
    assert.equal(summary.neutral_events, 0);

    const learned = db.prepare(`
      SELECT category, confidence, ai_reasoning
      FROM domain_categories WHERE domain = 'example.com'
    `).get();
    assert.equal(learned.category, 'productive');
    assert.equal(learned.confidence, 1);
    assert.match(learned.ai_reasoning, /user/i);

    const snapshot = personalization.buildPersonalizationSnapshot({ surface: 'scheduler' });
    assert.ok(snapshot.today.activitySignal.productiveMinutes >= 10);
    assert.match(
      personalization.formatPersonalizationContext(snapshot),
      /Verified activity signal today: .*productive/,
    );
  });

  it('keeps classification feedback scoped to its owning session', () => {
    const runtime = require('../../src/lib/guardian-runtime.ts');
    const otherSessionId = 'session-other-correction-test';
    db.prepare(`
      INSERT INTO guardian_sessions (
        session_id, target_title, started_at, duration_minutes, state, evidence_pipeline_mode
      ) VALUES (?, 'Other session', ?, 10, 'ACTIVE', 'shadow')
    `).run(otherSessionId, Date.now());
    db.prepare(`
      INSERT INTO session_domain_classifications (session_id, domain, classification, classified_at)
      VALUES (?, 'example.com', 'distraction', ?)
    `).run(otherSessionId, Date.now());

    runtime.applyUserClassificationFeedbackForSession(sessionId, 'example.com', 'on_topic');

    assert.equal(
      db.prepare(`SELECT classification FROM session_domain_classifications WHERE session_id = ? AND domain = ?`)
        .pluck().get(sessionId, 'example.com'),
      'on_topic',
    );
    assert.equal(
      db.prepare(`SELECT classification FROM session_domain_classifications WHERE session_id = ? AND domain = ?`)
        .pluck().get(otherSessionId, 'example.com'),
      'distraction',
    );
  });

  it('returns session ownership metadata for timeline records', async () => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
      .format(new Date(Date.now() - 10 * 60_000));
    const response = await getActivity(new Request(`http://lifeos.test/api/activity?date=${date}&limit=50`));
    assert.equal(response.status, 200);
    const body = await response.json();
    const activity = body.activities.find((row) => row.id === `interval:${intervalId}`);
    assert.equal(activity.session_id, sessionId);
    assert.equal(activity.session.target_title, 'Study DSA');
    assert.equal(activity.session.state, 'COMPLETE');
  });

  it('routes legacy Guardian activity corrections back to the owning session', async () => {
    const { applyLegacyGuardianActivityCorrection } = require('../../src/lib/activity-correction.ts');
    const legacy = db.prepare(`
      INSERT INTO activities (
        url, domain, title, category, subcategory, started_at, ended_at,
        duration_seconds, device_name, guardian_session_id, counted, capture_source
      ) VALUES (?, ?, ?, 'neutral', 'browser', ?, ?, 600, 'LifeOS Guardian', ?, 1, 'chrome')
    `).run(
      'https://example.com/dsa',
      'example.com',
      'Algorithms',
      new Date(Date.now() - 10 * 60_000).toISOString(),
      new Date().toISOString(),
      sessionId,
    );
    db.prepare(`
      UPDATE session_activity_intervals
      SET evidence_json = json_object('rawActivityId', ?)
      WHERE interval_id = ?
    `).run(Number(legacy.lastInsertRowid), intervalId);
    assert.equal(
      db.prepare(`SELECT guardian_session_id FROM activities WHERE id = ?`).pluck().get(Number(legacy.lastInsertRowid)),
      sessionId,
    );

    const correction = applyLegacyGuardianActivityCorrection(Number(legacy.lastInsertRowid), 'productive');
    assert.equal(correction.sessionId, sessionId);
    assert.equal(
      db.prepare(`SELECT category FROM session_activity_intervals WHERE interval_id = ?`).pluck().get(intervalId),
      'productive',
    );
  });
});
