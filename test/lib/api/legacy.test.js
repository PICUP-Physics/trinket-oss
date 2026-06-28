const flow    = require('../../helpers/flow.cjs');
const Trinket = require('../../../lib/models/trinket');

// Reset the cookie jar before each test so a cached session from one test
// does not bleed into the next (the 2a harness drops the DB after each test,
// so stale cookies would point at a dropped user).
beforeEach(() => {
  flow.cookies    = {};
  flow.activeUser = 'user';
});

describe('Legacy shortcode redirects', () => {
  let pythonShortCode, glowShortCode;
  const legacyPython  = 'legacy-python-001';
  const legacyGlow    = 'legacy-glow-001';
  const legacyDeleted = 'legacy-deleted-001';

  beforeEach(async () => {
    // Need an authenticated user to create a trinket via the API.
    await flow.switchUser('user');

    // 1) A normal python trinket created through the API, then stamped
    //    with a legacyShortCode the way an import would have.
    await flow.createTrinket();
    pythonShortCode = flow.lastResponse.body.data.shortCode;
    const pythonId  = flow.lastResponse.body.data.id;

    const pythonDoc = await new Promise((resolve, reject) => {
      Trinket.findById(pythonId, (err, doc) => err ? reject(err) : resolve(doc));
    });
    pythonDoc.legacyShortCode = legacyPython;
    await new Promise((resolve, reject) =>
      pythonDoc.save((err) => err ? reject(err) : resolve())
    );

    // 2) A glowscript trinket — proves the redirect uses the record's own lang
    //    (old vpython codes now live as glowscript).
    const glowDoc = await new Promise((resolve, reject) => {
      new Trinket({
        code            : 'GlowScript 3.0',
        lang            : 'glowscript',
        legacyShortCode : legacyGlow,
      }).save((err, glow) => err ? reject(err) : resolve(glow));
    });
    glowShortCode = glowDoc.shortCode;

    // 3) A soft-deleted trinket — must resolve to 404.
    await new Promise((resolve, reject) => {
      new Trinket({
        code            : 'gone',
        lang            : 'python',
        legacyShortCode : legacyDeleted,
        deletedAt       : new Date(),
      }).save((err) => err ? reject(err) : resolve());
    });
  });

  it('redirects a known legacy code to the new trinket page (301)', async () => {
    await flow.get('/legacy/' + legacyPython);
    expect(flow.lastResponse.statusCode).toEqual(301);
    expect(flow.lastResponse.headers.location).toEqual('/python/' + pythonShortCode);
  });

  it('builds the target from the record lang (renamed langs land correctly)', async () => {
    await flow.get('/legacy/' + legacyGlow);
    expect(flow.lastResponse.statusCode).toEqual(301);
    expect(flow.lastResponse.headers.location).toEqual('/glowscript/' + glowShortCode);
  });

  it('returns 404 for an unknown legacy code', async () => {
    await flow.get('/legacy/does-not-exist');
    expect(flow.lastResponse.statusCode).toEqual(404);
  });

  it('returns 404 when the matched trinket is soft-deleted', async () => {
    await flow.get('/legacy/' + legacyDeleted);
    expect(flow.lastResponse.statusCode).toEqual(404);
  });

  it('redirects a known legacy code to the embed (301)', async () => {
    await flow.get('/legacy/embed/' + legacyPython);
    expect(flow.lastResponse.statusCode).toEqual(301);
    expect(flow.lastResponse.headers.location).toEqual('/embed/python/' + pythonShortCode);
  });

  it('returns 404 for an unknown legacy embed code', async () => {
    await flow.get('/legacy/embed/nope');
    expect(flow.lastResponse.statusCode).toEqual(404);
  });
});
