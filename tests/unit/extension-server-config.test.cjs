'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_API_BASE,
  DEFAULT_APP_URL,
  loadApiBase,
  requestGuardianState,
  loadGuardianSession,
  saveGuardianSession,
} = require('../../extension/server-config.js');

function fakeStorage(initial = {}) {
  const values = { ...initial };
  return {
    async get(key) {
      if (typeof key === 'string') return { [key]: values[key] };
      return Object.fromEntries(key.map(item => [item, values[item]]));
    },
    async set(next) {
      Object.assign(values, next);
    },
    async remove(key) {
      delete values[key];
    },
  };
}

describe('extension server and session recovery', () => {
  it('uses the deployed Mac Mini when no browser override is stored', async () => {
    assert.equal(DEFAULT_APP_URL, 'http://100.99.194.80:3000');
    assert.equal(DEFAULT_API_BASE, 'http://100.99.194.80:3000/api');
    assert.equal(await loadApiBase(fakeStorage()), DEFAULT_API_BASE);
  });

  it('migrates the retired localhost default without replacing a real custom server', async () => {
    const legacyStorage = fakeStorage({ apiUrl: 'http://localhost:3000/api' });
    assert.equal(await loadApiBase(legacyStorage), DEFAULT_API_BASE);
    assert.equal((await legacyStorage.get('apiUrl')).apiUrl, DEFAULT_API_BASE);

    const customStorage = fakeStorage({ apiUrl: 'http://100.64.1.20:3000/api' });
    assert.equal(await loadApiBase(customStorage), 'http://100.64.1.20:3000/api');
    assert.equal((await customStorage.get('apiUrl')).apiUrl, 'http://100.64.1.20:3000/api');
  });

  it('loads the stored API URL before requesting Guardian state', async () => {
    const requested = [];
    const storage = fakeStorage({ apiUrl: 'http://100.64.1.20:3000/api/' });
    const result = await requestGuardianState({
      storage,
      headers: { Authorization: 'Bearer test' },
      fetchImpl: async (url, options) => {
        requested.push({ url, options });
        return { ok: true, json: async () => ({ activeSession: null }) };
      },
    });

    assert.equal(result.apiBase, 'http://100.64.1.20:3000/api');
    assert.equal(requested[0].url, 'http://100.64.1.20:3000/api/guardian/state');
    assert.equal(requested[0].options.headers.Authorization, 'Bearer test');
  });

  it('restores a session after a service worker restart and removes it when stopped', async () => {
    const storage = fakeStorage();
    const session = { sessionId: 'session-42', targetTitle: 'Graphs', state: 'ACTIVE' };

    await saveGuardianSession(storage, session);
    assert.deepEqual(await loadGuardianSession(storage), session);

    await saveGuardianSession(storage, null);
    assert.equal(await loadGuardianSession(storage), null);
  });
});
