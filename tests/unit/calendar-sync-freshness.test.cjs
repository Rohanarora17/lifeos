'use strict';

const { afterEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

describe('calendar sync freshness', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not resync a calendar whose latest ISO timestamp already includes a timezone', async () => {
    const env = createIsolatedDb('lifeos-calendar-freshness-');
    env.setSetting('calendar_ics_url', 'https://calendar.test/private.ics');
    env.db.prepare(`
      INSERT INTO calendar_events (id, title, start_time, end_time, synced_at)
      VALUES ('fresh-event', 'Fresh event', '2030-01-01T09:00:00.000Z',
              '2030-01-01T10:00:00.000Z', ?)
    `).run(new Date().toISOString());

    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fresh calendars must not contact the ICS feed');
    };

    const { syncCalendarIfStale } = env.requireLib('calendar.ts');
    const result = await syncCalendarIfStale();

    assert.equal(result, null);
    assert.equal(fetchCalls, 0);
  });
});
