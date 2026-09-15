import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import ctx from '../../../lib/util/ltiDeepLinkCtx.js';
import ltiKeys from '../../../lib/util/ltiKeys.js';

// A REAL keypair, not a stubbed signer: the point of these tests is that a token
// actually verifies, and that a tampered one actually does not. Stubbing signJwt to
// identity (as some sibling tests do, for other reasons) would assert nothing here.
beforeAll(() => {
  if (!process.env.LTI_PRIVATE_KEY) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.LTI_PRIVATE_KEY = privateKey.export({ type: 'pkcs1', format: 'pem' });
  }
});

const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString());

// The deep-link context token (#217). Its whole purpose is to let the picker work when
// the browser refused the cookie the launch set, WITHOUT becoming a bearer credential
// for the instructor's account, and without disclosing the LMS's coordinates in a
// URL — so the identity, binding and secrecy assertions below matter as much as the
// round-trip one.
describe('ltiDeepLinkCtx', () => {
  const dl11 = {
    version: '1.1',
    deep_link_return_url: 'https://lms.example.edu/return',
    data: 'opaque-from-lms',
    mode: 'both',
    acceptMultiple: true,
    assignmentAllowed: true,
    consumerKey: 'key-123',
  };
  const USER = 'u-launcher-1';

  it('round-trips the fields the picker and select step need', () => {
    const out = ctx.verify(ctx.sign(dl11, USER), USER);
    expect(out).toBeTruthy();
    expect(out.version).toBe('1.1');
    expect(out.deep_link_return_url).toBe(dl11.deep_link_return_url);
    expect(out.data).toBe('opaque-from-lms');
    expect(out.mode).toBe('both');
    expect(out.acceptMultiple).toBe(true);
    expect(out.consumerKey).toBe('key-123');
  });

  it('round-trips the 1.3 platform coordinates', () => {
    const out = ctx.verify(ctx.sign({
      version: '1.3',
      deep_link_return_url: 'https://lms.example.edu/dl',
      platformIss: 'https://lms.example.edu',
      platformCid: 'client-1',
      deploymentId: 'dep-1',
    }, USER), USER);
    expect(out.platformIss).toBe('https://lms.example.edu');
    expect(out.platformCid).toBe('client-1');
    expect(out.deploymentId).toBe('dep-1');
  });

  // The security property. If this ever fails, a leaked picker URL — a referrer, a
  // screenshot in a support ticket, a proxy log — becomes a live session.
  it('carries NO user identity, not even the id it is bound to', () => {
    const token = ctx.sign({ ...dl11, userId: 'u-secret', user: { id: 'u-secret' } }, 'u-secret');
    const decoded = decode(token);
    expect(JSON.stringify(decoded)).not.toContain('u-secret');
    expect(decoded.uid).toBeUndefined();
    expect(decoded.sub).toBeUndefined();
    expect(ctx.verify(token, 'u-secret').userId).toBeUndefined();
  });

  // Review finding 2 (b): the LMS's coordinates are not readable from the URL.
  it('does not expose the return URL, the LMS data or the platform in the payload', () => {
    const token = ctx.sign({
      ...dl11, platformIss: 'https://lms.example.edu', platformCid: 'client-1', deploymentId: 'dep-1'
    }, USER);
    const json = JSON.stringify(decode(token));
    expect(json).not.toContain('lms.example.edu');
    expect(json).not.toContain('opaque-from-lms');
    expect(json).not.toContain('key-123');
    expect(json).not.toContain('client-1');
    expect(json).not.toContain('dep-1');
    expect(json).toContain('lti-dl-ctx');
  });

  // Review finding 2 (a): bound to the launching user with a keyed digest.
  it('is refused for a different user, and reports the mismatch as such', () => {
    const token = ctx.sign(dl11, USER);
    expect(ctx.verify(token, USER)).toBeTruthy();
    expect(ctx.verify(token, 'u-someone-else')).toBeNull();
    expect(ctx.check(token, 'u-someone-else')).toEqual({ dl: null, mismatch: true });
    expect(ctx.check(token, USER).mismatch).toBe(false);
  });

  it('skips the user check only when no user is given (the framed, cookieless case)', () => {
    const token = ctx.sign(dl11, USER);
    expect(ctx.verify(token)).toBeTruthy();
    expect(ctx.check(token).mismatch).toBe(false);
  });

  it('refuses to mint an unbound token', () => {
    expect(ctx.sign(dl11)).toBeNull();
    expect(ctx.sign(dl11, '')).toBeNull();
  });

  // Regression: signing used to throw when no LTI 1.3 keypair was configured, which
  // made every LTI 1.1 deep-link launch fail on a 1.1-only deploy — 1.1 needs no such
  // key. The token is an enhancement and must never break a launch that would
  // otherwise work, so absence of a key degrades to "no token".
  // NOTE: the "no signing key" path — sign() returning null rather than throwing — is
  // covered by test/lib/api/lti11-deeplink.test.js, which drives a real 1.1 launch and
  // failed outright when signing threw. It is not unit-tested here on purpose: the key
  // cannot be removed from this context (loadPem() also reads config.app.lti.privateKey),
  // and neither stubbing the imported object nor vi.doMock intercepts the CJS
  // require('./ltiKeys') inside the module. The API test is the honest guard.

  it('refuses a token of the wrong type', () => {
    const wrong = ltiKeys.signJwt({ typ: 'lti-state', ru: 'https://evil.example/' }, { expiresIn: '5m' });
    expect(ctx.verify(wrong, USER)).toBeNull();
  });

  it('refuses tampered, empty and malformed tokens', () => {
    expect(ctx.verify(null)).toBeNull();
    expect(ctx.verify('')).toBeNull();
    expect(ctx.verify('not.a.jwt')).toBeNull();
    const t = ctx.sign(dl11, USER);
    expect(ctx.verify(t.slice(0, -3) + 'aaa', USER)).toBeNull();
  });

  // Review finding 2 (b), the part the JWT signature alone would not catch: a
  // payload whose encrypted blob was altered and then RE-SIGNED with the tool key
  // still has a valid signature; only the GCM tag can refuse it.
  it('refuses an altered encrypted blob even under a valid signature', () => {
    const p = decode(ctx.sign(dl11, USER));
    const buf = Buffer.from(p.enc, 'base64url');
    buf[0] ^= 0x01;
    const forged = ltiKeys.signJwt({ ...p, enc: buf.toString('base64url'), exp: undefined, iat: undefined },
                                   { expiresIn: '5m' });
    expect(ctx.verify(forged, USER)).toBeNull();
    // ...and the same for a re-signed payload with the binding digest swapped.
    const q = decode(ctx.sign(dl11, USER));
    const rebound = ltiKeys.signJwt({ ...q, uh: 'AAAAAAAAAAAAAAAAAAAAAA', exp: undefined, iat: undefined },
                                    { expiresIn: '5m' });
    expect(ctx.verify(rebound, USER)).toBeNull();
  });
});
