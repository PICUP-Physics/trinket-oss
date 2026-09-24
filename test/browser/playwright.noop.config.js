// The #247 no-op corpus (specs-deploy/math-output-noop.spec.js), and its
// positive control math-output.spec.js, against any deploy INCLUDING
// production.
//
// It is the deploy config minus globalSetup/globalTeardown. ephemeral-setup.js
// refuses production before any test runs (trinket.gopicup.org throws), and on
// a Firebase trial it mints two identities; the specs this config is for never
// sign in, so they need neither. Every other spec in specs-deploy/ that needs
// an identity skips here for want of SMOKE_EMAIL.
//
//   TRINKET_BASE_URL=https://trinket.gopicup.org TRINKET_CORPUS=abc123,def456 \
//     npx playwright test -c playwright.noop.config.js math-output-noop math-output
const base = require('./playwright.deploy.config.js');

// No silent default: the deploy config falls back to a shared trial when
// TRINKET_BASE_URL is unset, and a forgotten variable would aim both halves
// of the gate at someone else's server.
if (!process.env.TRINKET_BASE_URL) {
  throw new Error('playwright.noop.config.js: set TRINKET_BASE_URL to the deploy under test');
}

// retries: 0 for the positive control too. A retry can only hide an
// intermittent failure, and "flaky, exit 0" is exactly a dead-feature result
// the control exists to catch. (math-output-noop.spec.js sets its own 0.)
const { globalSetup, globalTeardown, ...rest } = base;
module.exports = { ...rest, retries: 0 };
