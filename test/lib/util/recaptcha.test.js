'use strict';
// recaptcha.verify against a stubbed fetch: the form it posts, how Google's
// answer maps to the callback, and that a failure fails closed instead of
// throwing (the request-based version read statusCode off an undefined
// response when the network call itself failed).
const config = require('config');
const recaptcha = require('../../../lib/util/recaptcha');

describe('recaptcha.verify', () => {
  let saved;
  beforeEach(() => {
    saved = { isTest: config.isTest, recaptcha: config.app.recaptcha };
    config.isTest = false;
    config.app.recaptcha = { secretkey: 'test-secret' };
  });
  afterEach(() => {
    config.isTest = saved.isTest;
    config.app.recaptcha = saved.recaptcha;
    vi.unstubAllGlobals();
  });

  const verify = (token) => new Promise((resolve) => recaptcha.verify(token, resolve));

  it('posts the secret and token as a form and returns Google\'s answer', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, score: 0.9 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);

    expect(await verify('tok-123')).toEqual({ success: true, score: 0.9 });
    expect(fetchStub).toHaveBeenCalledOnce();
    const [url, opts] = fetchStub.mock.calls[0];
    expect(url).toBe('https://www.google.com/recaptcha/api/siteverify');
    expect(opts.method).toBe('POST');
    const form = new URLSearchParams(String(opts.body));
    expect(form.get('secret')).toBe('test-secret');
    expect(form.get('response')).toBe('tok-123');
  });

  it('a non-200 answer is a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('busy', { status: 503 })));
    expect(await verify('tok')).toEqual({ status: false });
  });

  it('a network error is a failure, not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await verify('tok')).toEqual({ status: false });
  });

  it('skips the call entirely in test mode', async () => {
    config.isTest = true;
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    expect(await verify('tok')).toEqual({ success: true });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('a non-200 answer cancels the body it will not read', async () => {
    const seen = { cancelled: false };
    const body = new ReadableStream({ pull() {}, cancel() { seen.cancelled = true; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 503 })));
    expect(await verify('tok')).toEqual({ status: false });
    expect(seen.cancelled).toBe(true);
  });
});
