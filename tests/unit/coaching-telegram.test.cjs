'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('closed-loop coaching Telegram controls', () => {
  let db;
  let setSetting;
  let getSetting;
  let commitments;
  let webhookPOST;
  let originalFetch;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-coaching-telegram-');
    db = env.db;
    setSetting = env.setSetting;
    ({ getSetting } = env.requireLib('db.ts'));
    commitments = env.requireLib('coaching-commitments.ts');
    setSetting('telegram_chat_id', '12345');
    setSetting('telegram_bot_token', 'test-token');
    originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const webhookPath = require.resolve('../../src/app/api/telegram/webhook/route.ts');
    delete require.cache[webhookPath];
    ({ POST: webhookPOST } = require(webhookPath));
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function seedMissedCommitment() {
    const plan = db.prepare(`
      INSERT INTO daily_plans (plan_date, status, created_at, updated_at)
      VALUES (date('now'), 'active', datetime('now'), datetime('now'))
    `).run();
    const start = new Date(Date.now() - 6 * 60_000);
    db.prepare(`
      INSERT INTO planned_focus_sessions (
        id, plan_id, title, planned_start, planned_end, duration_minutes, status
      ) VALUES ('telegram-commitment', ?, 'Finish DSA exercise', ?, ?, 20, 'planned')
    `).run(plan.lastInsertRowid, start.toISOString(), new Date(start.getTime() + 20 * 60_000).toISOString());
    return commitments.runCommitmentExecutionCheck({ now: new Date(), send: async () => true });
  }

  it('reschedules the exact missed commitment from its intervention button', async () => {
    const seeded = await seedMissedCommitment();
    const before = new Date(seeded.commitment.plannedStartAt).getTime();
    const response = await webhookPOST(new Request('http://lifeos.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query: {
          id: 'callback-1',
          data: `commit:snooze:${seeded.commitment.id}`,
          message: { chat: { id: 12345 } },
        },
      }),
    }));

    assert.equal(response.status, 200);
    const updated = commitments.getCommitment(seeded.commitment.id);
    assert.equal(updated.state, 'scheduled');
    assert.ok(new Date(updated.plannedStartAt).getTime() > before);
  });

  it('captures the blocker reply against the commitment that asked for it', async () => {
    const seeded = await seedMissedCommitment();
    await webhookPOST(new Request('http://lifeos.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query: {
          id: 'callback-2',
          data: `commit:block:${seeded.commitment.id}`,
          message: { chat: { id: 12345 } },
        },
      }),
    }));

    await webhookPOST(new Request('http://lifeos.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          chat: { id: 12345 },
          text: 'The hard problem makes me reach for my phone and scroll',
        },
      }),
    }));

    const updated = commitments.getCommitment(seeded.commitment.id);
    assert.equal(updated.blockerKind, 'distraction');
    assert.match(updated.blockerText, /reach for my phone/i);
    assert.equal(getSetting('coaching_pending_commitment_blocker'), '');
  });
});
