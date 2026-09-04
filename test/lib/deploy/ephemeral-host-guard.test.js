'use strict';

// The guard that keeps deploy-test identities off real deploys.
//
// TRIAL_HOSTS_EXTRA exists so other operators (Andrew's staging server, a
// self-hoster's scratch box) can use the harness without editing the file. That
// convenience must not become a way to point it at a student body, so the
// production hosts are refused even when explicitly named.
const path = require('path');
const guard = require(path.join(__dirname, '..', '..', 'browser', 'ephemeral-identity.js'));

describe('which hosts may have test identities minted on them', () => {
  const real = process.env.TRIAL_HOSTS_EXTRA;
  afterEach(() => {
    if (real === undefined) delete process.env.TRIAL_HOSTS_EXTRA;
    else process.env.TRIAL_HOSTS_EXTRA = real;
  });

  it('allows a known trial', () => {
    delete process.env.TRIAL_HOSTS_EXTRA;
    expect(guard.assertMintable('https://rba-merge-trial.spvi.net'))
      .toBe('rba-merge-trial.spvi.net');
  });

  it('refuses an unknown host — fail closed', () => {
    delete process.env.TRIAL_HOSTS_EXTRA;
    expect(() => guard.assertMintable('https://trinket-staging.drewsday.com'))
      .toThrow(/not a known trial host/);
  });

  it('lets an operator opt their own trial in via TRIAL_HOSTS_EXTRA', () => {
    process.env.TRIAL_HOSTS_EXTRA = 'trinket-staging.drewsday.com';
    expect(guard.assertMintable('https://trinket-staging.drewsday.com'))
      .toBe('trinket-staging.drewsday.com');
  });

  it('accepts a comma-separated list, and ignores whitespace', () => {
    process.env.TRIAL_HOSTS_EXTRA = ' a.example.com , b.example.com ';
    expect(guard.assertMintable('https://b.example.com')).toBe('b.example.com');
  });

  // The one that matters. An env var is easy to set by accident — a shell
  // profile, a CI variable, a copied command line.
  it('refuses PRODUCTION even when TRIAL_HOSTS_EXTRA names it', () => {
    for (const host of guard.NEVER_MINTABLE) {
      process.env.TRIAL_HOSTS_EXTRA = host;
      expect(() => guard.assertMintable('https://' + host),
        host + ' must never be mintable').toThrow(/PRODUCTION deploy/);
    }
  });

  it('names the real production deploys', () => {
    expect(guard.NEVER_MINTABLE.has('rba-uindy.spvi.net')).toBe(true);
    expect(guard.NEVER_MINTABLE.has('trinket.matterandinteractions.org')).toBe(true);
    expect(guard.NEVER_MINTABLE.has('trinket.gopicup.org')).toBe(true);
  });
});
