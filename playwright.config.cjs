'use strict';

const path = require('path');

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: path.join(__dirname, 'tests/e2e'),
  testMatch: /.*\.spec\.cjs$/,
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:4317',
    trace: 'off',
  },
};
