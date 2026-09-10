'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backgroundPath = path.resolve(__dirname, '../../extension/background.js');

describe('extension Guardian session recovery', () => {
  it('reconciles server session state before every telemetry sample', () => {
    const source = fs.readFileSync(backgroundPath, 'utf8');
    const telemetryHandler = source.match(
      /if \(alarm\.name === TELEMETRY_ALARM\) \{([\s\S]*?)\n\s*return;\n\s*\}/,
    )?.[1] || '';

    const reconcileAt = telemetryHandler.indexOf('await checkExternalSession()');
    const sampleAt = telemetryHandler.indexOf('await sampleBrowserTelemetry()');
    assert.ok(reconcileAt >= 0, 'telemetry alarm must recover the active server session');
    assert.ok(sampleAt > reconcileAt, 'session recovery must happen before telemetry is sampled');
  });

  it('recreates the Guardian poll alarm whenever the service worker starts', () => {
    const source = fs.readFileSync(backgroundPath, 'utf8');
    const startupSection = source.slice(0, source.indexOf('// Context Menu Setup'));
    assert.match(
      startupSection,
      /chrome\.alarms\.create\('lifeos-guardian-poll', \{ periodInMinutes: 0\.5 \}\)/,
    );
  });
});

