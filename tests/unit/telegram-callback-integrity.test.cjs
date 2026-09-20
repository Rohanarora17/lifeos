'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('Telegram exact-record callbacks', () => {
  let db;
  let webhookPOST;
  let originalFetch;

  beforeEach(() => {
    const env = createIsolatedDb('lifeos-telegram-callback-');
    db = env.db;
    env.setSetting('telegram_chat_id', '12345');
    env.setSetting('telegram_bot_token', 'test-token');
    originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    const webhookPath = require.resolve('../../src/app/api/telegram/webhook/route.ts');
    delete require.cache[webhookPath];
    ({ POST: webhookPOST } = require(webhookPath));
  });

  afterEach(() => { global.fetch = originalFetch; });

  async function click(data) {
    return webhookPOST(new Request('http://lifeos.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query: { id: `cb-${data}`, data, message: { chat: { id: 12345 } } } }),
    }));
  }

  it('records feedback for the exact alert represented by the button', async () => {
    const first = Number(db.prepare("INSERT INTO alerts (type, message, severity) VALUES ('focus_drop', 'First', 'warning')").run().lastInsertRowid);
    const second = Number(db.prepare("INSERT INTO alerts (type, message, severity) VALUES ('focus_drop', 'Second', 'warning')").run().lastInsertRowid);
    await click(`alert:helpful:${first}`);

    assert.deepEqual(db.prepare('SELECT read, feedback FROM alerts WHERE id = ?').get(first), { read: 1, feedback: 'helpful' });
    assert.deepEqual(db.prepare('SELECT read, feedback FROM alerts WHERE id = ?').get(second), { read: 0, feedback: null });
  });

  it('snoozes only the exact pending soft watch represented by the button', async () => {
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO soft_watch_commitments (id, target_title, intended_start_at, planned_minutes, source, status, created_at)
      VALUES (?, ?, ?, 30, 'telegram', 'pending', ?)
    `);
    insert.run('sw_first', 'First block', now - 1_000, now - 5_000);
    insert.run('sw_second', 'Second block', now + 60_000, now - 4_000);
    await click('softwatch:snooze:sw_first');

    const first = db.prepare('SELECT intended_start_at AS startAt FROM soft_watch_commitments WHERE id = ?').get('sw_first');
    const second = db.prepare('SELECT intended_start_at AS startAt FROM soft_watch_commitments WHERE id = ?').get('sw_second');
    assert.ok(first.startAt > now);
    assert.equal(second.startAt, now + 60_000);
  });

  it('cancels only the exact pending soft watch and treats old generic buttons as expired', async () => {
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO soft_watch_commitments (id, target_title, intended_start_at, planned_minutes, source, status, created_at)
      VALUES (?, ?, ?, 30, 'telegram', 'pending', ?)
    `);
    insert.run('sw_cancel', 'Cancel me', now, now);
    insert.run('sw_keep', 'Keep me', now, now);

    await click('softwatch:cancel:sw_cancel');
    await click('action:snooze');

    assert.equal(db.prepare('SELECT status FROM soft_watch_commitments WHERE id = ?').get('sw_cancel').status, 'dismissed');
    assert.equal(db.prepare('SELECT status FROM soft_watch_commitments WHERE id = ?').get('sw_keep').status, 'pending');
  });

  it('does not let old review or classification buttons rewrite completed evidence', async () => {
    const reviewId = Number(db.prepare(`
      INSERT INTO session_completions (session_id, status) VALUES ('already-reviewed', 'done')
    `).run().lastInsertRowid);
    const activityId = Number(db.prepare(`
      INSERT INTO activities (
        url, domain, title, category, subcategory, started_at, duration_seconds,
        ai_classification, classification_confidence, classification_reviewed
      ) VALUES ('https://example.test', 'example.test', 'Example', 'productive', 'work',
        datetime('now'), 60, '{}', 'low', 1)
    `).run().lastInsertRowid);

    await click(`review:blocked:${reviewId}`);
    await click(`classify:${activityId}:f`);

    assert.equal(db.prepare('SELECT status FROM session_completions WHERE id = ?').get(reviewId).status, 'done');
    assert.deepEqual(
      db.prepare('SELECT category, classification_reviewed AS reviewed FROM activities WHERE id = ?').get(activityId),
      { category: 'productive', reviewed: 1 },
    );
  });
});
