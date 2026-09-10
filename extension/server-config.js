(function initLifeOSServerConfig(root) {
  'use strict';

  const DEFAULT_APP_URL = 'http://100.99.194.80:3000';
  const DEFAULT_API_BASE = `${DEFAULT_APP_URL}/api`;
  const GUARDIAN_SESSION_KEY = 'lifeosGuardianSession';
  const RETIRED_LOCAL_API_BASES = new Set([
    'http://localhost:3000/api',
    'http://127.0.0.1:3000/api',
  ]);

  function normalizeApiBase(value) {
    const trimmed = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
    if (!trimmed) return DEFAULT_API_BASE;
    const normalized = trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
    return RETIRED_LOCAL_API_BASES.has(normalized) ? DEFAULT_API_BASE : normalized;
  }

  async function loadApiBase(storage) {
    const stored = await storage.get('apiUrl');
    const apiBase = normalizeApiBase(stored.apiUrl);
    if (stored.apiUrl && stored.apiUrl !== apiBase) {
      await storage.set({ apiUrl: apiBase });
    }
    return apiBase;
  }

  async function requestGuardianState({ storage, fetchImpl, headers }) {
    const apiBase = await loadApiBase(storage);
    const response = await fetchImpl(`${apiBase}/guardian/state`, { headers });
    return { apiBase, response };
  }

  async function saveGuardianSession(storage, session) {
    if (!session?.sessionId) {
      await storage.remove(GUARDIAN_SESSION_KEY);
      return;
    }
    await storage.set({ [GUARDIAN_SESSION_KEY]: session });
  }

  async function loadGuardianSession(storage) {
    const stored = await storage.get(GUARDIAN_SESSION_KEY);
    const session = stored[GUARDIAN_SESSION_KEY];
    return session?.sessionId ? session : null;
  }

  const api = {
    DEFAULT_APP_URL,
    DEFAULT_API_BASE,
    GUARDIAN_SESSION_KEY,
    normalizeApiBase,
    loadApiBase,
    requestGuardianState,
    saveGuardianSession,
    loadGuardianSession,
  };

  root.LifeOSServerConfig = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
