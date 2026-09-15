'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('notification AI deduplication', () => {
  it('rejects a recent duplicate before initializing or calling Gemini', async () => {
    const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
    delete process.env.GOOGLE_CLOUD_PROJECT;
    try {
      const env = createIsolatedDb('lifeos-alert-dedup-');
      env.db.prepare(`
        INSERT INTO alerts (type, message, severity, created_at)
        VALUES ('weekly_review_test', 'already sent', 'warning', datetime('now'))
      `).run();
      const notifications = env.requireLib('notifications.ts');

      const sent = await notifications.sendAlert(
        'weekly_review',
        'Your weekly review is ready.',
        'warning',
        { key: 'weekly_review_test' },
      );

      assert.equal(sent, false);
      assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM ai_service_health').get().count, 0);
      assert.equal(env.db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE type='weekly_review_test'").get().count, 1);
    } finally {
      if (previousProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
      else process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    }
  });
});
