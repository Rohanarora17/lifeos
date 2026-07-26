'use strict';

const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('guardian override idempotency', () => {
  let db;
  let adjudicateOverride;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-guardian-override-idempotency-');
    db = env.db;
    ({ adjudicateOverride } = env.requireLib('guardian-runtime.ts'));
  });

  it('returns the stored decision for a duplicate request without creating another override', async () => {
    const decision = {
      approved: true,
      reason: 'Targeted override approved',
      explainability: 'Approved as a short, scoped exception.',
      ttlMinutes: 10,
      reviewedAt: '2030-01-01T00:00:00.000Z',
    };
    db.prepare(`
      INSERT INTO guardian_sessions (session_id, target_title, started_at, duration_minutes)
      VALUES ('session-a', 'Research paper', ?, 30)
    `).run(Date.now());
    db.prepare(`
      INSERT INTO guardian_override_requests (
        session_id, url, reason, requested_minutes, approved,
        decision_reason, explainability, idempotency_key, decision_json
      ) VALUES ('session-a', 'https://docs.example.com', 'Read documentation', 10, 1, ?, ?, 'voice-turn-1', ?)
    `).run(decision.reason, decision.explainability, JSON.stringify(decision));

    const result = await adjudicateOverride({
      sessionId: 'session-a',
      url: 'https://docs.example.com',
      reason: 'Read documentation',
      requestedMinutes: 10,
      idempotencyKey: 'voice-turn-1',
    });

    assert.deepEqual(result, decision);
    const count = db.prepare('SELECT COUNT(*) AS count FROM guardian_override_requests').get().count;
    assert.equal(count, 1);
  });
});
