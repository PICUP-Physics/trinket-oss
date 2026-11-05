'use strict';

// Only this build's prefix tokens may be cached.
//
// The prefix route strips whatever token it is given and serves THIS build's
// file. On 2026-11-04 a no-traffic candidate's pages asked the public host for
// /cache-prefix-<candidate's components hash>/.../RScompiler.3.2.3.min.js; the
// public host still routed to the old revision, which answered with its own
// (old) compiler, immutable for a year, and Cloudflare kept it. After the
// candidate was promoted, students got the old compiler from that URL until the
// entry was purged by hand, on both prods.
//
// A request under a token this build did not issue is still served -- a page
// from a mid-rollout instance must keep working -- but never cacheably.
const config = require('config');
const flow = require('../../helpers/flow.cjs');
const assetVersion = require('../../../lib/util/assetVersion');

const FILE = '/css/embed/foundation.css';
const COMPONENT = '/components/glowscript/lib/jquery/2.0/jquery.min.js';

let prevCache;
beforeEach(() => {
  flow.cookies = {};
  prevCache = config.app.cache;
  config.app.cache = { enabled: true, staticMaxAge: 31536000 };
});
afterEach(() => { config.app.cache = prevCache; });

const get = async (path) => {
  await flow.get(path);
  return flow.lastResponse;
};

describe('cache-prefix tokens this build did not issue', () => {
  it('an asset under this build\'s deploy token is cached immutably', async () => {
    const res = await get('/' + config.app.cachePrefix + assetVersion.token() + FILE);
    expect(res.statusCode, 'the fixture must exist, or this proves nothing').toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('a component under this build\'s components token is cached immutably', async () => {
    const res = await get('/' + config.app.cachePrefix + assetVersion.componentsToken() + COMPONENT);
    if (res.statusCode === 404) return;     // components tarball not installed here
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('the same asset under another build\'s token is served, but no-store', async () => {
    const res = await get('/' + config.app.cachePrefix + 'not0ur5token' + FILE);
    expect(res.statusCode, 'a mid-rollout page must still get its file').toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers['cache-control']).not.toContain('immutable');
  });
});
