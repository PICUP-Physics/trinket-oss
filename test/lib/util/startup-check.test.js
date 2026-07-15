'use strict';

// Design decision 3 (GCR-PICUP-TRIAL-MERGE-NOTES): GCP is all-or-none.
// db.backend firestore requires auth.provider firebase (and vice versa).
// Unsupported shapes fail closed in production (unless the deployer sets
// app.allowUnsupportedConfig) and warn everywhere else.

const { checkShape } = require('../../../lib/util/startup-check');

function cfg(db, auth, allow) {
  return {
    db:   { backend: db },
    auth: { provider: auth },
    app:  allow ? { allowUnsupportedConfig: true } : {}
  };
}

describe('startup-check config shape (all-or-none)', () => {
  it('accepts the self-host shape (mongoose + local) in production', () => {
    expect(checkShape(cfg('mongoose', 'local'), 'production').level).toEqual('ok');
  });

  it('accepts the GCP shape (firestore + firebase) in production', () => {
    expect(checkShape(cfg('firestore', 'firebase'), 'production').level).toEqual('ok');
  });

  it('accepts defaults (no db/auth config at all) as self-host', () => {
    expect(checkShape({}, 'production').level).toEqual('ok');
  });

  it('fails closed on firestore + local auth in production', () => {
    const r = checkShape(cfg('firestore', 'local'), 'production');
    expect(r.level).toEqual('fatal');
    expect(r.lines.join('\n')).toMatch(/auth\.provider/);
    expect(r.lines.join('\n')).toMatch(/allowUnsupportedConfig/);
  });

  it('fails closed on firebase auth without firestore in production', () => {
    expect(checkShape(cfg('mongoose', 'firebase'), 'production').level).toEqual('fatal');
  });

  it('downgrades to a warning outside production (test env)', () => {
    expect(checkShape(cfg('firestore', 'local'), 'test').level).toEqual('warn');
  });

  it('downgrades to a warning in production when allowUnsupportedConfig is set', () => {
    const r = checkShape(cfg('firestore', 'local', true), 'production');
    expect(r.level).toEqual('warn');
  });
});
