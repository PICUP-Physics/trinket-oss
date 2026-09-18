// Roster ordering for the dashboards.
//
// Every roster list sorted on `displayName`, a single free-text field, so the
// order was by GIVEN name. An instructor grading by hand works from a
// surname-ordered list — their own gradebook, a printed roll — and matching
// one against the other by first name is slow and error-prone.
//
// We hold no separate surname. The LMS does send given/family parts on launch
// (lis_person_name_given / _family) but the launch joins them into one string
// and keeps only that, so the surname has to be DERIVED here. Derivation is a
// heuristic and cannot be right for every name in the world; it is right for
// the common cases and it never throws. Capturing the LMS-supplied parts at
// provision time would make this exact for LTI users, and is the better fix
// if this is ever not good enough.
//
// UMD-lite: window global for the Angular app, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketRosterSort = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Dropped from the END of a name before looking for the surname.
  var SUFFIXES = ['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'dds', 'dvm', 'esq', 'jd', 'rn'];

  // Stand-alone particles that belong TO the surname: "van der Berg", "de la
  // Cruz". Deliberately excludes mac/mc — those are written joined ("McDonald")
  // and treating them as particles would swallow a middle name.
  var PARTICLES = ['van', 'von', 'de', 'del', 'della', 'der', 'den', 'di', 'da',
                   'dos', 'du', 'la', 'le', 'lo', 'ter', 'ten', 'bin', 'ibn', 'al', 'st'];

  function bare(token) {
    return String(token).toLowerCase().replace(/[.,]/g, '');
  }

  function tokens(name) {
    return String(name == null ? '' : name).trim().split(/\s+/).filter(Boolean);
  }

  // "Surname given names", so that people sharing a surname stay in a stable,
  // sensible order rather than an arbitrary one.
  function surnameKey(name) {
    var parts = tokens(name);
    if (!parts.length) return '';

    // Drop trailing suffixes, but never everything: "Jr" alone is the name.
    while (parts.length > 1 && SUFFIXES.indexOf(bare(parts[parts.length - 1])) >= 0) {
      parts.pop();
    }
    if (parts.length === 1) return bare(parts[0]);

    // The surname is the last token plus any particles immediately before it.
    var start = parts.length - 1;
    while (start > 1 && PARTICLES.indexOf(bare(parts[start - 1])) >= 0) { start--; }

    var surname = parts.slice(start).map(bare).join(' ');
    var given   = parts.slice(0, start).map(bare).join(' ');
    return given ? surname + ' ' + given : surname;
  }

  function givenKey(name) {
    return tokens(name).map(bare).join(' ');
  }

  // The sort key for one roster entry. `field` is 'last' or 'first'; anything
  // else keeps the original given-name order, so a stale stored preference can
  // never leave a list sorted by something nobody asked for.
  function key(name, field) {
    return field === 'last' ? surnameKey(name) : givenKey(name);
  }

  // The sort key for a roster ENTRY, preferring a surname we actually know.
  //
  // The LMS sends given/family parts on launch and we now store them, so where
  // we have them the ordering is exact — including the cases derivation cannot
  // get right, such as a family name written first. Where we have none (a user
  // who predates that capture, or one added another way) it falls back to
  // deriving from the display name, so no backfill is needed and the ordering
  // simply becomes exact over time.
  function keyFor(user, field) {
    if (!user) return '';
    if (field === 'last') {
      var family = String(user.familyName == null ? '' : user.familyName).trim();
      if (family) {
        var given = String(user.givenName == null ? '' : user.givenName).trim();
        return givenKey(given ? family + ' ' + given : family);
      }
    }
    return key(user.displayName, field);
  }

  var fields = [
    { value: 'last',  label: 'Last name'  },
    { value: 'first', label: 'First name' }
  ];

  return { key: key, keyFor: keyFor, fields: fields };
}));
