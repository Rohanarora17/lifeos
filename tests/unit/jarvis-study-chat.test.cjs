'use strict';
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Jarvis shares validated study actions', () => {
  let db, POST;
  beforeEach(t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T06:30:00Z') });
    process.env.LIFEOS_DISABLE_SCHEDULER = 'true';
    const env = createIsolatedDb('lifeos-jarvis-study-');
    db = env.db;
    const ai = env.requireLib('ai.ts');
    ai.getGenAI = () => ({});
    ai.generateWithFallback = async () => ({ functionCalls: [{ name: 'updateStudyAgreement', args: { message: 'start ADSA', revision: 999 } }] });
    const planner = env.requireLib('study-day-planning.ts');
    planner.refreshStudyCalendar = async now => ({ status: 'fresh', events: [], syncedAt: now.toISOString(), warning: null });
    const route = require.resolve('../../src/app/api/chat/route.ts');
    delete require.cache[route];
    ({ POST } = require(route));
  });
  const request = extra => new Request('http://lifeos.test/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'I am going for lunch' }], requestId: 'jarvis-check-in', studyRevision: 0, studyDate: '2026-10-22', ...extra }) });
  it('uses the exact human check-in, persists the shared conversation and returns actual action output', async () => {
    const response = await POST(request());
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.studyState.activity.kind, 'meal');
    assert.equal(data.studyState.activity.status, 'pending');
    assert.match(data.response, /return|long/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_turns').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guardian_sessions').get().n, 0);
  });
  it('does not mutate without revision/date metadata and rejects replay against a changed agreement', async () => {
    let data = await (await POST(request({ studyRevision: null }))).json();
    assert.match(data.response, /Study check-in/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_turns').get().n, 0);
    await POST(request());
    data = await (await POST(request({ requestId: 'stale', studyRevision: 0 }))).json();
    assert.match(data.response, /changed|review/i);
    assert.equal(data.studyState.revision, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM study_chat_turns').get().n, 2);
  });
});
