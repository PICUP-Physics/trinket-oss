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
});
