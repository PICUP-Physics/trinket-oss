'use strict';
// rehostAsset (course import): fetches the asset from trinket.io and, on any
// failure, falls back to the absolute trinket.io URL so the import completes.
let rehostAsset;
beforeAll(() => {
  ({ _rehostAsset: rehostAsset } = require('../../../lib/controllers/imports'));
});
afterEach(() => vi.unstubAllGlobals());

describe('rehostAsset', () => {
  it('fetches the asset from trinket.io', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response('x', { status: 404 }));
    vi.stubGlobal('fetch', fetchStub);
    await rehostAsset('/files/abc/cat.png', {}, {});
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(String(fetchStub.mock.calls[0][0])).toBe('https://trinket.io/files/abc/cat.png');
  });

  it('a non-200 answer falls back to the trinket.io URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));
    expect(await rehostAsset('/files/abc/cat.png', {}, {})).toBe('https://trinket.io/files/abc/cat.png');
  });

  it('a network error falls back to the trinket.io URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await rehostAsset('/files/abc/cat.png', {}, {})).toBe('https://trinket.io/files/abc/cat.png');
  });
});
