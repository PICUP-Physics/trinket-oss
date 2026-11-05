'use strict';
// POST /api/users/assetFromURL: download the URL to a temp file, then hand it
// to FileUtil.uploadUserAsset with the response's content type.
const fs = require('fs');
const dns = require('dns');
const config = require('config');
const FileUtil = require('../../../lib/util/file');

let users;
beforeAll(() => { users = require('../../../lib/controllers/users'); });

describe('users.assetUploadFromURL', () => {
  let savedAssets, uploaded;
  beforeEach(() => {
    savedAssets = config.features.assets;
    config.features.assets = true;
    uploaded = null;
    vi.spyOn(dns, 'lookup').mockImplementation((host, cb) => cb(null, '93.184.216.34'));
    vi.spyOn(FileUtil, 'uploadUserAsset').mockImplementation((fileupload, user, cb) => {
      uploaded = { fileupload, body: fs.readFileSync(fileupload.path, 'utf8') };
      cb(null, { id: 'file-1' });
    });
  });
  afterEach(() => {
    config.features.assets = savedAssets;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function call(url) {
    return new Promise((resolve) => {
      users.assetUploadFromURL({
        payload: { url },
        user: {},
        success: (data) => resolve({ ok: true, data }),
        fail: (err) => resolve({ ok: false, err }),
      }, () => resolve({ ok: false, replied: true }));
    });
  }

  it('downloads the URL and uploads it with its content type', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('PNGDATA', { status: 200, headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchStub);

    const res = await call('https://example.com/pics/cat.png');
    expect(res).toEqual({ ok: true, data: { file: { id: 'file-1' } } });
    expect(String(fetchStub.mock.calls[0][0])).toBe('https://example.com/pics/cat.png');
    expect(uploaded.body).toBe('PNGDATA');
    expect(uploaded.fileupload.filename).toBe('cat.png');
    expect(uploaded.fileupload.headers['content-type']).toBe('image/png');
  });

  it('a non-200 answer fails instead of uploading the error page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Not Found', { status: 404 })));
    const res = await call('https://example.com/pics/missing.png');
    expect(res.ok).toBe(false);
    expect(uploaded).toBe(null);
  });

  it('a network error fails instead of never answering', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const res = await call('https://example.com/pics/cat.png');
    expect(res.ok).toBe(false);
    expect(uploaded).toBe(null);
  });

  it('still refuses private addresses before fetching anything', async () => {
    dns.lookup.mockImplementation((host, cb) => cb(null, '10.0.0.5'));
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const res = await call('https://internal.example/secret.png');
    expect(res.ok).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  // A body that is still streaming: it only ends if someone cancels it.
  function streamingError(status) {
    const seen = { cancelled: false };
    const body = new ReadableStream({ pull() {}, cancel() { seen.cancelled = true; } });
    return { response: new Response(body, { status }), seen };
  }

  // Answers like the real fetch: unless asked for redirect: 'manual', it
  // follows a redirect itself and hands back whatever is at the end.
  function fakeWeb(pages) {
    return vi.fn(async (url, opts) => {
      let href = new URL(String(url)).href;   // fetch's own reading of the URL
      let page = pages[href];
      while (page && page.location && !(opts && opts.redirect === 'manual')) {
        href = new URL(page.location, href).href;
        page = pages[href];
      }
      if (!page) return new Response('nope', { status: 404 });
      if (page.location) return new Response(null, { status: page.status || 302, headers: { location: page.location } });
      return new Response(page.body, { status: 200, headers: { 'content-type': 'image/png' } });
    });
  }

  function privateHosts(...hosts) {
    dns.lookup.mockImplementation((host, cb) => cb(null, hosts.includes(host) ? '10.0.0.5' : '93.184.216.34'));
  }

  it('checks the same host fetch will connect to (percent-encoded dots)', async () => {
    // url.parse stops the host at the '%'; fetch decodes it and goes on.
    privateHosts('public.example.internal.example');
    const fetchStub = fakeWeb({ 'http://public.example.internal.example/secret.png': { body: 'SECRET' } });
    vi.stubGlobal('fetch', fetchStub);
    const res = await call('http://public.example%2einternal.example/secret.png');
    expect(res.ok).toBe(false);
    expect(uploaded).toBe(null);
  });

  it('a redirect to a private address is refused, not followed', async () => {
    privateHosts('internal.example');
    vi.stubGlobal('fetch', fakeWeb({
      'https://example.com/cat.png': { location: 'http://internal.example/secret' },
      'http://internal.example/secret': { body: 'SECRET' },
    }));
    const res = await call('https://example.com/cat.png');
    expect(res.ok).toBe(false);
    expect(uploaded).toBe(null);
  });

  it('a redirect to a public address is followed, checking each hop', async () => {
    vi.stubGlobal('fetch', fakeWeb({
      'https://example.com/cat.png': { location: '/moved/cat.png', status: 301 },
      'https://example.com/moved/cat.png': { location: 'https://cdn.example.net/x/kitten.png' },
      'https://cdn.example.net/x/kitten.png': { body: 'PNGDATA' },
    }));
    const res = await call('https://example.com/cat.png');
    expect(res.ok).toBe(true);
    expect(uploaded.body).toBe('PNGDATA');
    expect(uploaded.fileupload.filename).toBe('kitten.png');
    expect(dns.lookup.mock.calls.map((c) => c[0])).toEqual(['example.com', 'example.com', 'cdn.example.net']);
  });

  it('a redirect to a non-http scheme is refused', async () => {
    vi.stubGlobal('fetch', fakeWeb({ 'https://example.com/cat.png': { location: 'file:///etc/passwd' } }));
    const res = await call('https://example.com/cat.png');
    expect(res.ok).toBe(false);
    expect(uploaded).toBe(null);
  });

  it('gives up after too many redirects', async () => {
    const pages = {};
    for (let i = 0; i < 20; i++) pages['https://example.com/' + i] = { location: 'https://example.com/' + (i + 1) };
    pages['https://example.com/20'] = { body: 'PNGDATA' };
    vi.stubGlobal('fetch', fakeWeb(pages));
    const res = await call('https://example.com/0');
    expect(res.ok).toBe(false);
    expect(uploaded).toBe(null);
  });

  for (const ip of ['::ffff:10.0.0.5', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '::', '0.0.0.0', '100.64.0.1']) {
    it('refuses the private or unroutable address ' + ip, async () => {
      dns.lookup.mockImplementation((host, cb) => cb(null, ip));
      const fetchStub = vi.fn();
      vi.stubGlobal('fetch', fetchStub);
      const res = await call('https://sneaky.example/secret.png');
      expect(res.ok).toBe(false);
      expect(fetchStub).not.toHaveBeenCalled();
    });
  }

  it('a non-200 answer cancels the body it will not read', async () => {
    const { response, seen } = streamingError(500);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const res = await call('https://example.com/pics/cat.png');
    expect(res.ok).toBe(false);
    expect(seen.cancelled).toBe(true);
  });

  it('logs a failed URL without its query string', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await call('https://example.com/pics/cat.png?token=SECRET123');
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('https://example.com/pics/cat.png');
    expect(logged).not.toContain('SECRET123');
  });

  it('logs a URL with credentials without them (real fetch puts the URL in its error)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await call('https://user:PASSWORD9@example.com/pics/cat.png?token=SECRET123');
    expect(res.ok).toBe(false);
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).not.toContain('PASSWORD9');
    expect(logged).not.toContain('SECRET123');
  });

  it('does not log the text of a fetch error, which can quote a redirect target', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(
      new TypeError('Request cannot be constructed from a URL that includes credentials: https://u:PASSWORD9@cdn.example.net/x')));
    await call('https://example.com/pics/cat.png');
    expect(log.mock.calls.flat().join(' ')).not.toContain('PASSWORD9');
  });
});
