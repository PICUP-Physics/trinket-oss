'use strict';
// Library search matching and ranking (#344). Pure functions, no I/O: the
// search endpoint and the list's `q` filter both use this so they can't drift.

var MIN_LENGTH = 2;
var LIMIT      = 20;

function normalize(term) {
  if (typeof term !== 'string') return '';
  var t = term.trim().toLowerCase();
  return t.length < MIN_LENGTH ? '' : t;
}

function lower(v) {
  return typeof v === 'string' ? v.toLowerCase() : '';
}

function matches(trinket, normTerm) {
  if (!normTerm) return false;
  return lower(trinket.name).indexOf(normTerm) !== -1 ||
         lower(trinket.description).indexOf(normTerm) !== -1;
}

function group(trinket, normTerm) {
  var i = lower(trinket.name).indexOf(normTerm);
  if (i === 0) return 0;
  if (i > 0)   return 1;
  return 2;
}

// Firestore Timestamp, Date, string or missing → ms (missing sorts last).
function updatedMs(trinket) {
  var v = trinket.lastUpdated;
  if (!v) return -Infinity;
  var t = (typeof v.toDate === 'function') ? v.toDate().getTime() : new Date(v).getTime();
  return isNaN(t) ? -Infinity : t;
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function rank(trinkets, normTerm) {
  return trinkets
    .filter(function(t) { return matches(t, normTerm); })
    .map(function(t) {
      return { t: t, g: group(t, normTerm), u: updatedMs(t), n: lower(t.name), s: String(t.shortCode || '') };
    })
    .sort(function(a, b) {
      return cmp(a.g, b.g) || cmp(b.u, a.u) || cmp(a.n, b.n) || cmp(a.s, b.s);
    })
    .map(function(x) { return x.t; });
}

module.exports = {
  MIN_LENGTH : MIN_LENGTH,
  LIMIT      : LIMIT,
  normalize  : normalize,
  matches    : matches,
  rank       : rank
};
