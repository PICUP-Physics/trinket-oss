'use strict';

// components/ gets a CONTENT hash, not the deploy commit — picup #238.
//
// Measured: a cold session is 6.89 MB, of which 6.62 MB (96%) is /components/.
// Those files come from a pinned tarball plus pinned runner builds and change a
// few times a year, but they shared the deploy prefix, so EVERY deploy re-issued
// their URLs and every active student re-downloaded them. At ~500 students that
// is ~3.4 GB per deploy for bytes that did not move.
//
// Hashing the content means the URL changes if and only if the bytes do. A
// version string was rejected deliberately: the ace files are curl'd outside the
// tarball, so no single pin describes every byte under components/, and a stale
// immutable asset is worse than the waste — there is no lever to invalidate it.
const av = require('../../lib/util/assetVersion');

describe('the components prefix (#238)', () => {
  afterEach(() => av._resetComponentsToken());

  it('falls back to the deploy token when no hash file exists', () => {
    // Dev trees and pre-#238 images have no components-hash.txt. Falling back to
    // the OLD behaviour is the safe direction — never a stale asset.
    av._resetComponentsToken();
    expect(av.componentsToken()).toBe(av.token());
  });

  it('is memoised, so a page render costs at most one read', () => {
    av._resetComponentsToken();
    expect(av.componentsToken()).toBe(av.componentsToken());
  });
});

describe('the deploy publishes components under that prefix', () => {
  const fs = require('fs'), path = require('path');
  const sh = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'deploy-hosting.sh'), 'utf8');

  it('reads the hash the image carries', () => {
    expect(sh).toMatch(/components-hash\.txt/);
  });

  it('stages components under the components prefix, not the commit prefix', () => {
    expect(sh).toMatch(/CPREFIX="\$\{SITE\}\/cache-prefix-\$\{COMPONENTS_TOKEN\}"/);
  });

  it('keeps the cache-prefix-* URL shape', () => {
    // Same shape means the server's prefix-stripping and Hosting's
    // /cache-prefix-*/** immutable rule both apply with no new config.
    expect(sh).toMatch(/cache-prefix-\$\{COMPONENTS_TOKEN\}/);
  });

  it('falls back to the deploy commit when the image predates the hash', () => {
    expect(sh).toMatch(/COMPONENTS_TOKEN="\$\{COMMIT\}"/);
  });
});
