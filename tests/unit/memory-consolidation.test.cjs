'use strict';

const { before, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('memory consolidation integrity', () => {
  let db;
  let consolidateFacts;
  let purgeStaleUnverifiedFacts;

  before(() => {
    const env = createIsolatedDb('lifeos-memory-consolidation-');
    db = env.db;
    ({ consolidateFacts } = require('../../src/lib/memory-extractor.ts'));
    ({ purgeStaleUnverifiedFacts } = require('../../src/lib/memory.ts'));
  });

  it('links duplicate facts to the existing winner without creating a copy', async () => {
    const insert = db.prepare(`
      INSERT INTO mem_facts (
        category, topic, content, confidence, importance, status, created_at
      ) VALUES ('preference', 'focus_length', ?, ?, ?, 'active', datetime('now'))
    `);
    const winnerId = Number(
      insert.run('Forty-five minute sessions work best', 0.9, 0.9).lastInsertRowid
    );
    const duplicateId = Number(
      insert.run('Long focus sessions work best', 0.7, 0.4).lastInsertRowid
    );

    await consolidateFacts();

    const facts = db.prepare(`
      SELECT id, status, superseded_by FROM mem_facts
      WHERE topic = 'focus_length' ORDER BY id
    `).all();
    assert.equal(facts.length, 2);
    assert.deepEqual(facts, [
      { id: winnerId, status: 'active', superseded_by: null },
      { id: duplicateId, status: 'superseded', superseded_by: winnerId },
    ]);
  });

  it('purges stale facts even when a superseded fact still references them', () => {
    const staleId = Number(db.prepare(`
      INSERT INTO mem_facts (
        category, topic, content, status, created_at
      ) VALUES (
        'pattern', 'stale_reference', 'Old replacement', 'unverified',
        datetime('now', '-30 days')
      )
    `).run().lastInsertRowid);
    const oldId = Number(db.prepare(`
      INSERT INTO mem_facts (
        category, topic, content, status, superseded_by
      ) VALUES (
        'pattern', 'stale_reference', 'Superseded source', 'superseded', ?
      )
    `).run(staleId).lastInsertRowid);

    assert.equal(purgeStaleUnverifiedFacts(14), 1);
    assert.equal(
      db.prepare('SELECT id FROM mem_facts WHERE id = ?').get(staleId),
      undefined
    );
    assert.deepEqual(
      db.prepare('SELECT superseded_by FROM mem_facts WHERE id = ?').get(oldId),
      { superseded_by: null }
    );
  });
});
