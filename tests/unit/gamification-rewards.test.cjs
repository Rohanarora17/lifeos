'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

function jsonRequest(body) {
  return { json: async () => body };
}

function deleteRequest(id) {
  return { nextUrl: new URL(`http://localhost/api/gamification?id=${id}`) };
}

describe('custom reward management API', () => {
  let db;
  let GET;
  let POST;
  let PATCH;
  let DELETE;

  before(() => {
    const env = createIsolatedDb('lifeos-rewards-');
    db = env.db;
    ({ GET, POST, PATCH, DELETE } = require('../../src/app/api/gamification/route.ts'));
  });

  it('creates, edits, redeems, and removes a user reward', async () => {
    db.prepare("INSERT INTO coin_ledger (amount, reason) VALUES (1000, 'Test balance')").run();

    const createResponse = await POST(jsonRequest({
      title: '  Fancy coffee after study  ',
      cost: '250',
      category: 'purchase',
      icon: '☕',
    }));
    assert.equal(createResponse.status, 200);

    const created = db.prepare(`
      SELECT id, title, cost, icon, category, user_cost_override, is_custom
      FROM rewards_store
      WHERE title = ?
    `).get('Fancy coffee after study');
    assert.ok(created);
    assert.equal(created.cost, 250);
    assert.equal(created.icon, '☕');
    assert.equal(created.category, 'purchase');
    assert.equal(created.user_cost_override, 1);
    assert.equal(created.is_custom, 1);

    const getResponse = await GET();
    const getBody = await getResponse.json();
    const listed = getBody.store.find((reward) => reward.id === created.id);
    assert.equal(listed.title, 'Fancy coffee after study');
    assert.equal(listed.is_custom, 1);

    const patchResponse = await PATCH(jsonRequest({
      id: created.id,
      title: 'Coffee and a long walk',
      cost: null,
      category: 'restorative',
      icon: '🌿',
    }));
    assert.equal(patchResponse.status, 200);

    const updated = db.prepare(`
      SELECT title, cost, icon, category, user_cost_override
      FROM rewards_store
      WHERE id = ?
    `).get(created.id);
    assert.equal(updated.title, 'Coffee and a long walk');
    assert.equal(updated.icon, '🌿');
    assert.equal(updated.category, 'restorative');
    assert.equal(updated.user_cost_override, 0);
    assert.ok(updated.cost >= 100);

    const balanceBefore = db.prepare('SELECT SUM(amount) AS balance FROM coin_ledger').get().balance;
    const idempotencyKey = 'test-redemption-create-edit-delete';
    const redeemResponse = await POST(jsonRequest({
      reward_id: created.id,
      idempotency_key: idempotencyKey,
    }));
    assert.equal(redeemResponse.status, 200);
    const balanceAfter = db.prepare('SELECT SUM(amount) AS balance FROM coin_ledger').get().balance;
    assert.equal(balanceAfter, balanceBefore - updated.cost);

    const duplicateResponse = await POST(jsonRequest({
      reward_id: created.id,
      idempotency_key: idempotencyKey,
    }));
    assert.equal(duplicateResponse.status, 200);
    assert.equal((await duplicateResponse.json()).deduplicated, true);
    assert.equal(db.prepare('SELECT SUM(amount) AS balance FROM coin_ledger').get().balance, balanceAfter);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_redemptions WHERE idempotency_key = ?').get(idempotencyKey).count, 1);

    const conflictingResponse = await POST(jsonRequest({
      reward_id: 1,
      idempotency_key: idempotencyKey,
    }));
    assert.equal(conflictingResponse.status, 409);

    const deleteResponse = await DELETE(deleteRequest(created.id));
    assert.equal(deleteResponse.status, 200);
    assert.equal(db.prepare('SELECT id FROM rewards_store WHERE id = ?').get(created.id), undefined);
    const redemptionSnapshot = db.prepare(`
      SELECT reward_id, reward_title, reward_icon, cost, ledger_entry_id
      FROM reward_redemptions
      WHERE idempotency_key = ?
    `).get(idempotencyKey);
    assert.equal(redemptionSnapshot.reward_id, created.id);
    assert.equal(redemptionSnapshot.reward_title, 'Coffee and a long walk');
    assert.equal(redemptionSnapshot.reward_icon, '🌿');
    assert.equal(redemptionSnapshot.cost, updated.cost);
    assert.ok(redemptionSnapshot.ledger_entry_id > 0);

    const retryAfterDelete = await POST(jsonRequest({
      reward_id: created.id,
      idempotency_key: idempotencyKey,
    }));
    assert.equal(retryAfterDelete.status, 200);
    assert.equal((await retryAfterDelete.json()).deduplicated, true);
    assert.equal(db.prepare('SELECT SUM(amount) AS balance FROM coin_ledger').get().balance, balanceAfter);
  });

  it('rejects invalid prices and protects built-in rewards', async () => {
    assert.equal(db.prepare('SELECT category FROM rewards_store WHERE id = 1').get().category, 'leisure');
    assert.equal(db.prepare('SELECT category FROM rewards_store WHERE id = 3').get().category, 'purchase');
    assert.equal(db.prepare('SELECT category FROM rewards_store WHERE id = 4').get().category, 'escape');

    const invalid = await POST(jsonRequest({
      title: 'Impossible reward',
      cost: '-10',
      category: 'custom',
    }));
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /between 1 and/i);

    const tooExpensive = await POST(jsonRequest({
      title: 'Too expensive',
      cost: '10000001',
      category: 'custom',
    }));
    assert.equal(tooExpensive.status, 400);

    const missingIdempotency = await POST(jsonRequest({ reward_id: 1 }));
    assert.equal(missingIdempotency.status, 400);
    assert.match((await missingIdempotency.json()).error, /idempotency_key/i);

    const editBuiltIn = await PATCH(jsonRequest({
      id: 1,
      title: 'Changed default',
      cost: 10,
      category: 'custom',
      icon: '🎁',
    }));
    assert.equal(editBuiltIn.status, 403);

    const deleteBuiltIn = await DELETE(deleteRequest(1));
    assert.equal(deleteBuiltIn.status, 403);
    assert.ok(db.prepare('SELECT id FROM rewards_store WHERE id = 1').get());
  });

  it('reseeds built-in rewards with their complete metadata after a reset', () => {
    const { reseedGamificationCatalog } = require('../../src/lib/gamification-catalog.ts');
    db.prepare('DELETE FROM reward_redemptions').run();
    db.prepare('DELETE FROM rewards_store').run();

    const seeded = reseedGamificationCatalog(db);
    assert.equal(seeded.rewards, 4);

    const rewards = db.prepare(`
      SELECT id, category, pricing_json, user_cost_override, is_custom
      FROM rewards_store
      ORDER BY id
    `).all();
    assert.deepEqual(rewards, [
      { id: 1, category: 'leisure', pricing_json: '{}', user_cost_override: 0, is_custom: 0 },
      { id: 2, category: 'leisure', pricing_json: '{}', user_cost_override: 0, is_custom: 0 },
      { id: 3, category: 'purchase', pricing_json: '{}', user_cost_override: 0, is_custom: 0 },
      { id: 4, category: 'escape', pricing_json: '{}', user_cost_override: 0, is_custom: 0 },
    ]);
  });
});
