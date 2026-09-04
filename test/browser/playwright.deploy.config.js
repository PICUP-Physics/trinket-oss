// Deploy smoke — runs against a REAL deployment (a trial, or production if you
// are brave), not a local stack.
//
// The main suite in ./specs deliberately targets a local `make gcp` stack: it
// signs in through the Firebase Auth emulator, which no deployed server has.
// These specs never sign in and never write, so they are safe to point at a
// running server, and they cover what a local stack structurally cannot: the
// deploy's own overlay, its config, and the headers it actually serves.
//
//   TRINKET_BASE_URL=https://trial-merge.spvi.net npx playwright test -c playwright.deploy.config.js
//
// Optionally assert which build should be live:
//   EXPECT_COMMIT=7f5e205 TRINKET_BASE_URL=... npx playwright test -c playwright.deploy.config.js

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  globalSetup: require.resolve('./ephemeral-setup.js'),
  globalTeardown: require.resolve('./ephemeral-teardown.js'),
  testDir: './specs-deploy',
  // A deployed server is shared and may be cold; be patient but not silly.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // Never hammer someone else's server from many workers at once.
  workers: 1,
  retries: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.TRINKET_BASE_URL || 'https://trial-merge.spvi.net',
    ...devices['Desktop Chrome'],
    ignoreHTTPSErrors: false,
    screenshot: 'only-on-failure',
  },
});
