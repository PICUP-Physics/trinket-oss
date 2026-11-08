// Which responses may be cached.
//
// Since the initial open-source release app.js has applied one `no-store`
// header to EVERY response via onPreResponse. For authenticated HTML that is
// correct and stays. For static assets it means a client re-fetches the whole
// front end on every page view — measured on a live deploy: 29 same-origin
// assets, 933 KB, none of it storable by the browser and none of it storable by
// a shared cache either, since `private` excludes CDNs by definition.
//
// An asset served under a version-stamped path is safe to cache hard, because
// the path changes when the deploy does (see assetVersion).
var DYNAMIC = 'private, s-maxage=0, max-age=0, no-cache, no-store, must-revalidate, proxy-revalidate';

var DEFAULT_MAX_AGE = 31536000; // one year, the conventional immutable ceiling

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches /<cachePrefix><token>/<assetType>/<path> and nothing else. Anchored:
// a path that merely CONTAINS the prefix (a trinket named after it, say) is not
// an asset route and must not be cached.
//
// This runs on EVERY response the server sends (via onPreResponse), so the
// compiled RegExp is memoized per prefix rather than rebuilt per request. One
// entry is enough — cachePrefix comes from config and never changes at runtime.
var _prefixReCache = { prefix: null, re: null };
function isVersionedAssetPath(pathname, cachePrefix) {
  if (!pathname || !cachePrefix) return false;
  if (_prefixReCache.prefix !== cachePrefix) {
    _prefixReCache = {
      prefix: cachePrefix,
      re: new RegExp('^/' + escapeRegExp(cachePrefix) + '([^/]+)/[^/]+/')
    };
  }
  return _prefixReCache.re.test(pathname);
}

// The token in a versioned asset path, or null.
function prefixToken(pathname, cachePrefix) {
  if (!isVersionedAssetPath(pathname, cachePrefix)) return null;
  return _prefixReCache.re.exec(pathname)[1];
}

// ownTokens: the prefix tokens this server issues (assetVersion's deploy and
// components tokens). The prefix route strips ANY token and serves this
// server's file, so a token we did not issue -- another build's URL that
// reached us, as when a no-traffic candidate's pages fetch through the public
// host -- would otherwise pin THIS build's bytes under THAT build's URL for a
// year. Such a request is still served, but no-store. Omitted, any token passes.
function headersFor(pathname, statusCode, appConfig, ownTokens) {
  var cache = appConfig && appConfig.cache;

  // Off unless a deploy opts in, so merging this changes nothing until someone
  // decides it should.
  var enabled = !!(cache && cache.enabled === true);

  // Only a successful body or its revalidation. Caching an error under an asset
  // path would pin a 404 for a year — the failure mode is a deploy that looks
  // broken to exactly the clients that visited during the bad window.
  var cacheable = statusCode === 200 || statusCode === 304;

  var token = prefixToken(pathname, appConfig && appConfig.cachePrefix);
  var ours = token !== null && (!ownTokens || ownTokens.indexOf(token) !== -1);

  if (enabled && cacheable && ours) {
    // isFinite guards NaN (YAML typo like staticMaxAge: 1y parses to a string,
    // Number coercion elsewhere could hand NaN through) and negatives — either
    // would emit a malformed max-age.
    var maxAge = (typeof cache.staticMaxAge === 'number' &&
                  isFinite(cache.staticMaxAge) && cache.staticMaxAge >= 0)
      ? cache.staticMaxAge : DEFAULT_MAX_AGE;
    // No Pragma/Expires here: the HTTP/1.0 pair would contradict this and some
    // intermediaries honour the stricter one.
    return { 'Cache-Control': 'public, max-age=' + maxAge + ', immutable' };
  }

  return { 'Cache-Control': DYNAMIC, 'Pragma': 'no-cache', 'Expires': '0' };
}

module.exports = {
  headersFor           : headersFor,
  isVersionedAssetPath : isVersionedAssetPath,
  DYNAMIC              : DYNAMIC
};
