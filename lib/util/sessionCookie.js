// The session cookie's partitioned twin (#286).
//
// A cross-site LMS frame with third-party cookies blocked refuses the session
// cookie, so every session-backed page after an LTI launch (student assignment
// embed, SpeedGrader review panel) fell through to the cookie-guidance page.
// Browsers that block third-party cookies still store a cookie marked
// `Partitioned` (CHIPS: Chrome 114+, Firefox 141+, Safari 26.2+) — in a jar
// keyed to the top-level site, invisible anywhere else.
//
// That last property is why this is a COPY and not an attribute on the
// existing cookie: a partitioned session would sign a student out the moment
// they open trinket in a new tab from inside the LMS frame, which works today
// wherever third-party cookies are allowed. So the plain cookie is untouched
// and a second Set-Cookie carries the same encrypted value plus `Partitioned`.
//
// The copy keeps the SAME NAME. Firebase Hosting forwards exactly one cookie,
// `__session`, to a Cloud Run rewrite and strips every other name at the edge
// (mandi and the Hosting-fronted trial) — a differently named copy would never
// reach the app there. A partitioned and an unpartitioned cookie of one name
// live in separate jars and, where both are stored, BOTH arrive in the Cookie
// header; Chrome calls that working as intended (crbug 41492918). hapi would
// parse the duplicate as an array and yar would start a blank session, so the
// request side collapses duplicates to one before cookies are parsed.
//
// Which one: the FIRST. They are set together with the same value, so it
// rarely matters. When it does (the plain cookie was re-sealed by a later
// non-framed response), browsers list the older-created cookie first and keep
// the original creation time across replacement (RFC 6265 §5.3) — so the plain,
// fresher one comes first. Two trade-offs, both accepted: a sibling host or an
// XSS that can plant a same-named cookie with a longer Path gets it sorted
// first (today that pair fails closed as a blank session; a single planted
// cookie already wins today), and a partitioned jar can only be cleared from
// inside its partition, so a top-level logout on a shared machine leaves the
// LMS partition's copy behind until the next launch resets it (every LTI
// launch does). app.js logs whenever a dropped duplicate differs from the kept
// one, so either case is visible.
//
// Pure string functions, so the header rewriting in app.js stays a few lines.
'use strict';

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function isPartitioned(v) { return /;\s*Partitioned\s*(;|$)/i.test(String(v)); }

// Set-Cookie values → partitioned copies of the ones named `name` (same name,
// same attributes, `Partitioned` appended). An entry whose twin is already in
// the array is not copied again — hapi can hand the array back through the
// header setter more than once.
function partitionedCopies(setCookieValues, name) {
  var values = [].concat(setCookieValues || []).map(String);
  var re = new RegExp('^' + escapeRe(name) + '=');
  var twins = values.filter(isPartitioned);
  return values
    .filter(function (v) { return re.test(v) && !isPartitioned(v); })
    .filter(function (v) { return twins.indexOf(v + '; Partitioned') < 0; })
    .map(function (v) { return v + '; Partitioned'; });
}

// True when a response should carry the copy: any navigation INTO a frame —
// the LTI launch (cross-site) and every page the framed app navigates to
// afterwards (same-origin, but still inside the LMS frame, where only the
// partitioned jar is writable when third-party cookies are blocked). Top-level
// navigations and fetches never get one, so no partitioned cookie is created
// in a first-party jar to go stale against the plain one.
function wantsCopy(headers) {
  if (!headers) return false;
  var dest = headers['sec-fetch-dest'];
  return dest === 'iframe' || dest === 'frame';
}

// Request `Cookie` header → the same header with any repeated `name=` cookie
// reduced to its first occurrence. Unchanged (same object) when there is at
// most one. `onConflict(kept, dropped)` is called for each dropped value that
// differs from the kept one.
function dedupe(cookieHeader, name, onConflict) {
  if (!cookieHeader) return cookieHeader;
  var prefix = name + '=';
  var parts = cookieHeader.split(/;\s*/);
  var kept = null;
  var out = parts.filter(function (p) {
    if (p.indexOf(prefix) !== 0) return true;
    if (kept === null) { kept = p; return true; }
    if (p !== kept && onConflict) onConflict(kept.slice(prefix.length), p.slice(prefix.length));
    return false;
  });
  return out.length === parts.length ? cookieHeader : out.join('; ');
}

module.exports = {
  partitionedCopies: partitionedCopies,
  wantsCopy        : wantsCopy,
  dedupe           : dedupe
};
