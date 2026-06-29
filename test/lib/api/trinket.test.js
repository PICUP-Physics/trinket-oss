const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const config   = require('config');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const nunjucks = require('nunjucks');
const mailer   = require('../../../lib/util/mailer');

// The trinket email controller calls nunjucks.render() (global, synchronous) to
// render the shareTrinket HTML template. The global nunjucks environment is
// configured here so the template can be found during tests — the app normally
// relies on the exports worker calling nunjucks.configure(), which doesn't run
// in the test process.
nunjucks.configure(path.join(__dirname, '../../../lib/views'));

// Reset the per-user cookie jar before each test — the 2a harness drops and
// recreates the DB per test, so any cached session would point at a dead user.
beforeEach(() => {
  flow.cookies = {};
});

describe('Trinket Creation', () => {
  describe('When creating a new trinket', () => {
    let trinketId, trinketShortCode, trinketLang;

    // Stub mailer so the email endpoint can run its full flow.
    // isConfigured() returns false in test env (empty host/from in default.yaml),
    // which makes the handler short-circuit before calling send(). Both are spied
    // here so the "share with token" test can assert mailer.send was invoked.
    beforeEach(() => {
      vi.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      vi.spyOn(mailer, 'send').mockResolvedValue(undefined);
    });

    // The HTML view/embed routes (/{lang}/{shortCode}, /embed/{lang}/{id}) are
    // gated by the trinketTypeEnabled pre-handler, which 404s when the lang's
    // feature flag is off. default.yaml ships features.trinkets.python = false
    // (Skulpt superseded by pyodide). Enable it at runtime so these routes serve.
    let pythonWasEnabled;
    beforeEach(() => {
      pythonWasEnabled = config.features.trinkets.python;
      config.features.trinkets.python = true;
    });

    afterEach(() => {
      vi.restoreAllMocks();
      config.features.trinkets.python = pythonWasEnabled;
    });

    // Recreate the user + trinket fixture for every test (DB is wiped per test).
    beforeEach(async () => {
      await flow.switchUser('user');
      await flow.createTrinket();
      trinketId        = flow.lastResponse.body.data.id;
      trinketShortCode = flow.lastResponse.body.data.shortCode;
      trinketLang      = flow.lastResponse.body.data.lang;
    });

    it('should return a new trinket', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
      expect(flow.lastContentType).toContain('application/json');
      expect(flow.lastResponse.body.data).toHaveProperty('id');
      expect(flow.lastResponse.body.data).toHaveProperty('hash');
      expect(flow.lastResponse.body.data).toHaveProperty('shortCode');
      expect(flow.lastResponse.body.data.lang).toEqual('python');
    });

    describe('When I attempt to fork with a new code modification', () => {
      beforeEach(async () => {
        await flow.forkTrinket(trinketId, { code: 'modified code' });
      });

      it('should create a new trinket', () => {
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toEqual(200);
        expect(flow.lastContentType).toContain('application/json');
        expect(flow.lastResponse.body.data).toHaveProperty('id');
        expect(flow.lastResponse.body.data).toHaveProperty('hash');
        expect(flow.lastResponse.body.data).toHaveProperty('shortCode');
      });

      it('should update the fork count of the parent', async () => {
        await flow.get('/api/trinkets/' + trinketId);
        expect(flow.lastResponse.body.data.metrics.forks).toEqual(1);
      });
    });

    // The next 3 tests exercise non-API (HTML) routes, served once the python
    // feature flag is enabled (see beforeEach above). They render the
    // trinket/python and embed/python nunjucks views (200 + text/html).

    it('should allow me to load the trinket', async () => {
      await flow.getTrinket(trinketShortCode, trinketLang);
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
      expect(flow.lastContentType).toContain('text/html');
    });

    it('should allow me to embed the trinket', async () => {
      await flow.getEmbeddedTrinket(trinketId, trinketLang);
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
      expect(flow.lastContentType).toContain('text/html');
    });

    it('should allow me to embed the trinket with result showing', async () => {
      // validating that the query param start is accepted
      await flow.getEmbeddedTrinket(trinketId, trinketLang, { start: 'result' });
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
      expect(flow.lastContentType).toContain('text/html');
    });

    it('should allow me to share the trinket with a token', async () => {
      const secret = config.app.mail.secret + trinketShortCode;
      const token  = jwt.sign({ shortCode: trinketShortCode }, secret);
      await flow.emailTrinket(trinketId, {
        email:   defaults.user.email,
        name:    defaults.user.fullname,
        replyTo: defaults.user.email,
        token:   token,
      });
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
      // Legacy assertion: mail.mailer.send.calledOnce — verified via vi.spyOn.
      // mailer.isConfigured is mocked true so the handler reaches mailer.send().
      expect(mailer.send).toHaveBeenCalledOnce();
    });

    // verifyEmailToken (lib/util/helpers.js) accepts a payload token OR, as a
    // fallback, an 'emailToken:{shortCode}' value in the yar session — which
    // createTrinket sets for the creator. So the creator's own session can email
    // without re-supplying a token (covered by the "with a token" test above and
    // implicitly by the session fallback). The contract this test asserts is the
    // negative case: a fresh session that has neither a payload token nor the
    // session fallback is rejected with 400. We switch to the anonymous cookie
    // jar (no emailToken in its session) to get that fresh session; the email
    // route is public (no auth: 'session'), so it reaches verifyEmailToken.
    it('should not allow me to share the trinket without a token', async () => {
      flow.switchUser('');  // fresh anonymous session: no emailToken in yar
      await flow.emailTrinket(trinketId, {
        email:   defaults.user.email,
        name:    defaults.user.fullname,
        replyTo: defaults.user.email,
      });
      expect(flow.lastResponse.statusCode).toEqual(400);
    });

    it('should allow me to run the trinket', async () => {
      await flow.runTrinket(trinketId);
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
      expect(flow.lastResponse.body.data).toHaveProperty('metrics');
      expect(flow.lastResponse.body.data.metrics).toHaveProperty('runs');
    });

    it('should allow an error to be logged if there is an error in the code', async () => {
      await flow.trinketRunError();
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
    });
  });
});
