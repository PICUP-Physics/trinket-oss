'use strict';
// Lazily required in beforeAll (not at module top): lib/workers/exports.js
// pulls in config/app.config -> routes -> controllers -> @hapi/hapi. The
// global test setup (test/helpers/vitest-setup.cjs) boots app.js and applies
// required config fixups (redis disabled + mocked, session secret, etc.)
// inside its own beforeAll. A top-level require here would run at test-file
// collection time, BEFORE that setup runs, and hits real Redis + a
// hapi/@hapi-validate version-skew crash that only happens on that early,
// unconfigured path.
let addTrinketToArchive;
beforeAll(() => {
  ({ addTrinketToArchive } = require('../../../lib/workers/exports'));
});

function fakeArchive() {
  const names = [];
  return { names, append: (_c, opts) => names.push(opts.name) };
}
const trinket = { shortCode: 'abc123', name: 'My Sim', lang: 'python3', code: 'print(1)', assets: [], settings: {} };

describe('addTrinketToArchive basePath', () => {
  it('uses default <lang>/<name>_<shortCode>/ when no options', async () => {
    const a = fakeArchive();
    await addTrinketToArchive(a, trinket);
    expect(a.names.some(n => n.startsWith('python3/My_Sim_abc123/'))).toBe(true);
  });
  it('honors options.basePath', async () => {
    const a = fakeArchive();
    await addTrinketToArchive(a, trinket, { basePath: 'assignment-1/jane/' });
    expect(a.names.every(n => n.startsWith('assignment-1/jane/'))).toBe(true);
    expect(a.names).toContain('assignment-1/jane/metadata.json');
  });
});

// One missing asset must not fail the trinket, and must not leave a rejected
// promise nobody handles: under native promises Node treats that as fatal and
// would take the export worker down with it. Two things keep that true today,
// the per-asset .catch and Promise.allSettled; this fails if both go.
describe('addTrinketToArchive with a failing asset download', () => {
  const aws = require('../../../config/aws');
  let unhandled;
  const onUnhandled = (reason) => unhandled.push(reason);

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    vi.spyOn(aws, 'S3').mockImplementation(function() {
      return { getObject: (_params, cb) => setImmediate(() => cb(new Error('NoSuchKey'))) };
    });
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
  });

  it('archives the rest, skips the asset, and rejects nothing', async () => {
    const a = fakeArchive();
    const withAsset = Object.assign({}, trinket, {
      assets: [{ name: 'gone.png', url: 'https://assets.example/userassets/gone.png' }],
    });
    const result = await addTrinketToArchive(a, withAsset);
    expect(result.shortCode).toBe('abc123');
    await new Promise((r) => setImmediate(r));     // let any stray rejection surface
    expect(a.names).toContain('python3/My_Sim_abc123/metadata.json');
    expect(a.names.some((n) => n.endsWith('assets/gone.png'))).toBe(false);
    expect(unhandled).toEqual([]);
  });
});
