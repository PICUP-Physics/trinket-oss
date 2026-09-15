// A cookie carrying `Partitioned` (CHIPS) is stored by browsers that block
// third-party cookies — but it is ONLY visible inside the top-level site that
// set it. So the existing session cookie stays as it is (a student who opens
// trinket in a new tab from inside the LMS frame keeps their session wherever
// third-party cookies are allowed), and a partitioned COPY rides alongside it
// for the frames that refuse the first one (#286).
//
// Same name on purpose: Firebase Hosting forwards only `__session` to Cloud
// Run. Where a browser holds both jars it sends both, so the request side
// collapses duplicates before hapi parses them.
const sessionCookie = require('../../../lib/util/sessionCookie');

const SESSION = 'session=Fe26.2**abc; Secure; HttpOnly; SameSite=None; Path=/';

describe('sessionCookie.partitionedCopies', () => {
  it('copies the session cookie under the SAME name with Partitioned appended', () => {
    expect(sessionCookie.partitionedCopies([SESSION], 'session'))
      .toEqual([SESSION + '; Partitioned']);
  });

  it('leaves other cookies alone and matches the NAME, not a prefix', () => {
    const out = sessionCookie.partitionedCopies(
      ['other=1; Path=/', 'sessionx=2; Path=/', SESSION], 'session');
    expect(out).toEqual([SESSION + '; Partitioned']);
  });

  it('does not copy an entry that is already partitioned, nor one whose twin is already there', () => {
    expect(sessionCookie.partitionedCopies([SESSION + '; Partitioned'], 'session')).toEqual([]);
    // hapi can hand the array back through the header setter more than once
    expect(sessionCookie.partitionedCopies([SESSION, SESSION + '; Partitioned'], 'session')).toEqual([]);
  });

  it('copies a cleared cookie too, so logout clears both jars', () => {
    const cleared = 'session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; HttpOnly; SameSite=None; Path=/';
    expect(sessionCookie.partitionedCopies([cleared], 'session')).toEqual([cleared + '; Partitioned']);
  });

  it('is empty for no input and accepts a bare string', () => {
    expect(sessionCookie.partitionedCopies(undefined, 'session')).toEqual([]);
    expect(sessionCookie.partitionedCopies('session=x; Path=/', 'session')).toHaveLength(1);
  });
});

describe('sessionCookie.wantsCopy', () => {
  it('is true for any navigation into a frame — the launch and the pages after it', () => {
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' })).toBe(true);
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe' })).toBe(true);
    expect(sessionCookie.wantsCopy({ 'sec-fetch-dest': 'frame' })).toBe(true);
  });

  it('is false top-level, for fetches, and without the header', () => {
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'document' })).toBe(false);
    expect(sessionCookie.wantsCopy({ 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' })).toBe(false);
    expect(sessionCookie.wantsCopy({})).toBe(false);
    expect(sessionCookie.wantsCopy(undefined)).toBe(false);
  });
});

describe('sessionCookie.dedupe', () => {
  it('keeps the first of two same-named session cookies and reports a differing drop', () => {
    const conflicts = [];
    expect(sessionCookie.dedupe('a=1; session=FIRST; b=2; session=SECOND', 'session',
      (k, d) => conflicts.push([k, d]))).toBe('a=1; session=FIRST; b=2');
    expect(conflicts).toEqual([['FIRST', 'SECOND']]);
  });

  it('drops an identical duplicate silently — the normal two-jar case', () => {
    const conflicts = [];
    expect(sessionCookie.dedupe('session=SAME; session=SAME', 'session', (k, d) => conflicts.push([k, d])))
      .toBe('session=SAME');
    expect(conflicts).toEqual([]);
  });

  it('returns the very same header when there is one or none (no rewrite)', () => {
    const one = 'a=1; session=ONLY; b=2';
    expect(sessionCookie.dedupe(one, 'session')).toBe(one);
    const none = 'a=1; b=2';
    expect(sessionCookie.dedupe(none, 'session')).toBe(none);
    expect(sessionCookie.dedupe(undefined, 'session')).toBeUndefined();
  });

  it('does not confuse look-alike names', () => {
    const h = 'xsession=1; session=A; session_old=2';
    expect(sessionCookie.dedupe(h, 'session')).toBe(h);
  });

  it('works for the Hosting cookie name', () => {
    expect(sessionCookie.dedupe('__session=A; __session=B', '__session')).toBe('__session=A');
  });
});
