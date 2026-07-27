'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createIsolatedDb } = require('../helpers/temp-db.cjs');

const envLoader = createIsolatedDb('lifeos-api-security-');
const {
  authorizeApiRequest,
  configuredAdminReauthToken,
  constantTimeTokenEqual,
  configuredAllowedOrigins,
} = envLoader.requireLib('api-security.ts');

const production = {
  NODE_ENV: 'production',
  LIFEOS_API_TOKEN: 'app-secret',
  LIFEOS_DEVICE_TOKEN: 'device-secret',
  LIFEOS_ALLOWED_ORIGINS: 'http://100.99.194.80:3000',
  LIFEOS_EXTENSION_ID: 'abcdefghijklmnop',
};

function request(overrides = {}) {
  return {
    method: 'GET',
    pathname: '/api/dashboard',
    origin: 'http://100.99.194.80:3000',
    requestOrigin: null,
    authorization: null,
    deviceToken: null,
    cookieToken: null,
    ...overrides,
  };
}

describe('API security policy', () => {
  it('fails closed in production when the API token is missing', () => {
    const result = authorizeApiRequest(request(), { NODE_ENV: 'production' });
    assert.equal(result.allowed, false);
    assert.equal(result.status, 503);
    assert.equal(result.reason, 'security_not_configured');
  });

  it('accepts the app token through a bearer credential', () => {
    const result = authorizeApiRequest(
      request({ authorization: 'Bearer app-secret' }),
      production,
    );
    assert.equal(result.allowed, true);
    assert.equal(result.kind, 'bearer');
  });

  it('limits device credentials to device-facing routes', () => {
    const ingestion = authorizeApiRequest(
      request({
        pathname: '/api/daemon/ingest',
        authorization: 'Bearer device-secret',
      }),
      production,
    );
    assert.equal(ingestion.allowed, true);
    assert.equal(ingestion.kind, 'device');

    const dashboard = authorizeApiRequest(
      request({ authorization: 'Bearer device-secret' }),
      production,
    );
    assert.equal(dashboard.allowed, false);
    assert.equal(dashboard.status, 401);
  });

  it('requires an allowed origin for cookie-authenticated mutations', () => {
    const missingOrigin = authorizeApiRequest(
      request({ method: 'POST', cookieToken: 'app-secret' }),
      production,
    );
    assert.equal(missingOrigin.status, 403);
    assert.equal(missingOrigin.reason, 'csrf_rejected');

    const sameOrigin = authorizeApiRequest(
      request({
        method: 'POST',
        requestOrigin: 'http://100.99.194.80:3000',
        cookieToken: 'app-secret',
      }),
      production,
    );
    assert.equal(sameOrigin.allowed, true);
    assert.equal(sameOrigin.kind, 'cookie');
  });

  it('does not allow arbitrary cross-origin API access', () => {
    const origins = configuredAllowedOrigins(
      'http://100.99.194.80:3000',
      production,
    );
    assert.equal(origins.has('https://attacker.example'), false);
    assert.equal(origins.has('chrome-extension://abcdefghijklmnop'), true);
  });

  it('compares credentials without an early length return', () => {
    assert.equal(constantTimeTokenEqual('same', 'same'), true);
    assert.equal(constantTimeTokenEqual('short', 'longer'), false);
    assert.equal(constantTimeTokenEqual(null, 'secret'), false);
  });

  it('uses an independent admin reauthentication token when configured', () => {
    assert.equal(
      configuredAdminReauthToken({
        LIFEOS_API_TOKEN: 'app-secret',
        LIFEOS_ADMIN_REAUTH_TOKEN: 'admin-secret',
      }),
      'admin-secret',
    );
    assert.equal(
      configuredAdminReauthToken({ LIFEOS_API_TOKEN: 'legacy-secret' }),
      'legacy-secret',
    );
  });
});
