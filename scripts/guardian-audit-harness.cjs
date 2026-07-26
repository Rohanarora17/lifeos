'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function filesUnder(directory, name) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(target, name));
    else if (entry.name === name) output.push(target);
  }
  return output;
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

const routeFiles = filesUnder(path.join(root, 'src', 'app', 'api'), 'route.ts');
const pageFiles = filesUnder(path.join(root, 'src', 'app'), 'page.tsx');
const proxy = read('src/proxy.ts');
const extension = read('extension/background.js');
const nativeCapture = read('macos/LifeOSCopilot/Sources/LifeOSCopilot/Services.swift');
const claims = read('src/lib/assessment-claim.ts');

const checks = [
  {
    id: 'route_inventory',
    passed: routeFiles.length >= 74,
    detail: `${routeFiles.length} API route files`,
  },
  {
    id: 'page_inventory',
    passed: pageFiles.length >= 17,
    detail: `${pageFiles.length} page files`,
  },
  {
    id: 'api_authentication',
    passed: proxy.includes('authorizeApiRequest') && !proxy.includes("'Access-Control-Allow-Origin', '*'"),
    detail: 'central auth policy and no wildcard CORS',
  },
  {
    id: 'oauth_state',
    passed: read('src/app/api/calendar/google/callback/route.ts').includes('Invalid OAuth state'),
    detail: 'calendar callback binds authorization code to state cookie',
  },
  {
    id: 'telemetry_contract',
    passed: extension.includes('/telemetry/events')
      && extension.includes('queryState(60)')
      && extension.includes('WINDOW_ID_NONE')
      && extension.includes('persistAcrossSessions'),
    detail: 'extension emits durable state-aware intervals',
  },
  {
    id: 'tab_group_preservation',
    passed: extension.includes('shouldGroupTab')
      && !extension.includes('// Auto-group the tab into the session group'),
    detail: 'existing groups are preserved',
  },
  {
    id: 'extension_screenshot_retired',
    passed: !extension.includes('captureVisibleTab'),
    detail: 'browser screenshot capture is absent',
  },
  {
    id: 'frontmost_window_capture',
    passed: nativeCapture.includes('SCScreenshotManager.captureImage')
      && nativeCapture.includes('desktopIndependentWindow')
      && !nativeCapture.includes('CGDisplayCreateImage')
      && !nativeCapture.includes('NSPasteboard'),
    detail: 'ScreenCaptureKit window capture without clipboard simulation',
  },
  {
    id: 'claim_thresholds',
    passed: claims.includes('sampleSize >= 10 && distinctDays >= 5')
      && claims.includes('sampleSize >= 20')
      && claims.includes("userStance === 'confirmed'"),
    detail: 'decision and identity thresholds are enforced',
  },
];

const result = {
  generatedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA || process.env.LIFEOS_DEPLOYED_COMMIT || 'local',
  inventory: {
    pages: pageFiles.length,
    apiRoutes: routeFiles.length,
  },
  checks,
  passed: checks.filter(check => check.passed).length,
  failed: checks.filter(check => !check.passed).length,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.failed > 0) process.exitCode = 1;
