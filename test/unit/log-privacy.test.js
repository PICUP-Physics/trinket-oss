'use strict';
const crypto     = require('crypto');
const config     = require('config');
const logPrivacy = require('../../lib/util/logPrivacy');

const KEY     = 'k'.repeat(40);
const SESSION = 's'.repeat(40);

// The documented algorithm, computed independently of the helper.
function expectedToken(address, key) {
  const normalized = address.trim().toLowerCase();
  const hex = crypto.createHmac('sha256', key)
    .update('trinket-log-email-v1:' + normalized).digest('hex').slice(0, 8);
  return 'u-' + hex + '@' + normalized.slice(normalized.lastIndexOf('@') + 1);
}

let ferpaWas, sessionWas, envFerpa, envSession, warnSpy;

beforeEach(() => {
  ferpaWas   = config.ferpa;
  sessionWas = config.app.plugins.session.cookieOptions.password;
  envFerpa   = process.env.FERPA_LOG_TOKEN_SECRET;
  envSession = process.env.SESSION_PASSWORD;
  delete process.env.FERPA_LOG_TOKEN_SECRET;
  delete process.env.SESSION_PASSWORD;
  config.ferpa = { logEmails: 'token', logTokenSecret: KEY };
  config.app.plugins.session.cookieOptions.password = SESSION;
  logPrivacy._resetWarningsForTests();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  config.ferpa = ferpaWas;
  config.app.plugins.session.cookieOptions.password = sessionWas;
  if (envFerpa === undefined) delete process.env.FERPA_LOG_TOKEN_SECRET; else process.env.FERPA_LOG_TOKEN_SECRET = envFerpa;
  if (envSession === undefined) delete process.env.SESSION_PASSWORD; else process.env.SESSION_PASSWORD = envSession;
  vi.restoreAllMocks();
});

describe('logPrivacy.email', () => {
  it('tokenizes an address by default: u- + 8 hex + @ + lowercased domain', () => {
    const out = logPrivacy.email('Student@CNU.edu');
    expect(out).toMatch(/^u-[0-9a-f]{8}@cnu\.edu$/);
    expect(out).toBe(expectedToken('Student@CNU.edu', KEY));
  });

  it('gives the same token for the same address in any case or with surrounding spaces', () => {
    expect(logPrivacy.email('  STUDENT@cnu.EDU ')).toBe(logPrivacy.email('student@cnu.edu'));
  });

  it('gives different tokens for different addresses', () => {
    expect(logPrivacy.email('a@cnu.edu')).not.toBe(logPrivacy.email('b@cnu.edu'));
  });

  it('returns addresses as written when ferpa.logEmails is full (any case, spaces)', () => {
    config.ferpa.logEmails = ' Full ';
    expect(logPrivacy.email('Student@CNU.edu')).toBe('Student@CNU.edu');
  });

  it('treats a misspelled logEmails value as token', () => {
    config.ferpa.logEmails = 'ful';
    expect(logPrivacy.email('Student@CNU.edu')).toBe(expectedToken('Student@CNU.edu', KEY));
  });

  it('passes usernames (no @) and non-strings through unchanged', () => {
    expect(logPrivacy.email('ryan.fisher')).toBe('ryan.fisher');
    expect(logPrivacy.email(undefined)).toBe(undefined);
    expect(logPrivacy.email(null)).toBe(null);
    expect(logPrivacy.email(42)).toBe(42);
  });

  it('still tokenizes, without throwing, when the ferpa section is missing', () => {
    config.ferpa = undefined;
    expect(logPrivacy.email('a@b.edu')).toBe(expectedToken('a@b.edu', SESSION));
  });
});

describe('logPrivacy.text', () => {
  it('replaces every address in free text and leaves the rest', () => {
    expect(logPrivacy.text('550 5.1.1 <Student@CNU.edu>: rejected; cc other@x.org'))
      .toBe('550 5.1.1 <' + expectedToken('Student@CNU.edu', KEY) + '>: rejected; cc ' + expectedToken('other@x.org', KEY));
  });

  it('is a no-op with full and for non-strings', () => {
    expect(logPrivacy.text(undefined)).toBe(undefined);
    config.ferpa.logEmails = 'full';
    expect(logPrivacy.text('to <a@b.edu>')).toBe('to <a@b.edu>');
  });

  it('tokenizes addresses with apostrophes or non-ASCII letters whole, and leaves surrounding quotes', () => {
    expect(logPrivacy.text("550 <o'brien@cnu.edu> rejected")).toBe('550 <' + expectedToken("o'brien@cnu.edu", KEY) + '> rejected');
    expect(logPrivacy.text('to josé@cnu.edu')).toBe('to ' + expectedToken('josé@cnu.edu', KEY));
    expect(logPrivacy.text("quoted 'student@cnu.edu' here")).toBe("quoted '" + expectedToken('student@cnu.edu', KEY) + "' here");
  });

  it('stops at key=, path and query separators, so the token matches the bare address', () => {
    expect(logPrivacy.text('email=bob@cnu.edu')).toBe('email=' + expectedToken('bob@cnu.edu', KEY));
    expect(logPrivacy.text('GET /users/bob@cnu.edu/profile')).toBe('GET /users/' + expectedToken('bob@cnu.edu', KEY) + '/profile');
    expect(logPrivacy.text('?to=a@b.edu&cc=c@d.edu')).toBe('?to=' + expectedToken('a@b.edu', KEY) + '&cc=' + expectedToken('c@d.edu', KEY));
    const nfd = 'josé@cnu.edu';  // e + combining acute, not the precomposed é
    expect(logPrivacy.text('to ' + nfd)).toBe('to ' + expectedToken(nfd, KEY));
  });

  it('scans long text in linear time', () => {
    const started = Date.now();
    logPrivacy.text('a'.repeat(200000));
    logPrivacy.text('x@' + 'b.'.repeat(30000));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('token key', () => {
  it('uses FERPA_LOG_TOKEN_SECRET before ferpa.logTokenSecret', () => {
    process.env.FERPA_LOG_TOKEN_SECRET = 'e'.repeat(40);
    expect(logPrivacy.email('a@b.edu')).toBe(expectedToken('a@b.edu', 'e'.repeat(40)));
  });

  it('does not change tokens when the session password is rotated, if logTokenSecret is set', () => {
    const before = logPrivacy.email('a@b.edu');
    config.app.plugins.session.cookieOptions.password = 'z'.repeat(40);
    expect(logPrivacy.email('a@b.edu')).toBe(before);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('falls back to the session password, with exactly one warning, when logTokenSecret is too short', () => {
    config.ferpa.logTokenSecret = 'x'.repeat(31);
    expect(logPrivacy.email('a@b.edu')).toBe(expectedToken('a@b.edu', SESSION));
    expect(logPrivacy.email('c@d.edu')).toBe(expectedToken('c@d.edu', SESSION));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('ferpa.logTokenSecret is not set');
  });

  it('uses SESSION_PASSWORD from the environment before the configured session password', () => {
    config.ferpa.logTokenSecret = '';
    process.env.SESSION_PASSWORD = 'p'.repeat(40);
    expect(logPrivacy.email('a@b.edu')).toBe(expectedToken('a@b.edu', 'p'.repeat(40)));
  });

  it('uses a random per-process key, with one warning, when no secret is usable', () => {
    config.ferpa.logTokenSecret = '';
    config.app.plugins.session.cookieOptions.password = '';
    const first = logPrivacy.email('a@b.edu');
    expect(first).toMatch(/^u-[0-9a-f]{8}@b\.edu$/);
    expect(logPrivacy.email('a@b.edu')).toBe(first);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('cannot be looked up');
  });

  it('reports where the key comes from without warning', () => {
    expect(logPrivacy.keySource()).toBe('dedicated');
    config.ferpa.logTokenSecret = '';
    expect(logPrivacy.keySource()).toBe('session');
    config.app.plugins.session.cookieOptions.password = '';
    expect(logPrivacy.keySource()).toBe('random');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('never throws', () => {
  it('hides the local part if tokenizing fails', () => {
    vi.spyOn(crypto, 'createHmac').mockImplementation(() => { throw new Error('boom'); });
    expect(logPrivacy.email('Student@CNU.edu')).toBe('u-????????@cnu.edu');
    expect(logPrivacy.text('to <a@b.edu>')).toBe('to <u-????????@b.edu>');
  });
});
