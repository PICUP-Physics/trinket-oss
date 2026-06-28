'use strict';
const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const Store    = require('../../../lib/util/store');
const mailer   = require('../../../lib/util/mailer');
const nunjucks = require('nunjucks');

// The 2a harness drops the DB after each test, while the flow cookie jar is a
// module-level singleton. Reset it before each test so every test starts fresh.
beforeEach(() => {
  flow.cookies    = {};
  flow.activeUser = 'user';
});

describe('Forgot Password', () => {

  describe('When entering an invalid email address', () => {
    beforeEach(async () => {
      await flow.switchUser('');
    });

    it('should redirect to forgot password page', async () => {
      await flow.sendPassReset({ email: 'doesnot@exist.com' });
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastRedirect.pathname).toBe('/forgot-pass');
    });
  });

  describe('When entering a valid email address', () => {
    let mailerConfiguredSpy;
    let mailerSendSpy;
    let nunjucksRenderSpy;

    beforeEach(async () => {
      // Create the default user without logging in (avoids login-rate-limit
      // accumulation from repeated switchUser('user') calls across tests).
      await new User(defaults.user).save();
      await flow.switchUser('');

      // sendPassReset bails early when mailer.isConfigured() is false.
      // Stub isConfigured + send so the full reset flow executes in test mode.
      mailerConfiguredSpy = vi.spyOn(mailer, 'isConfigured').mockReturnValue(true);
      mailerSendSpy       = vi.spyOn(mailer, 'send').mockResolvedValue(undefined);

      // The controller calls nunjucks.render('emails/passwordReset', …) after
      // request.success() — i.e. after the HTTP response is already sent.
      // The global nunjucks env has no loader configured in test mode, so
      // the render throws "template not found", preventing mailer.send from
      // being reached and producing unhandled-rejection noise. Stub it to a
      // no-op so the full code path (including mailer.send) executes cleanly.
      nunjucksRenderSpy = vi.spyOn(nunjucks, 'render').mockReturnValue('<html>reset</html>');
    });

    afterEach(() => {
      mailerConfiguredSpy.mockRestore();
      mailerSendSpy.mockRestore();
      nunjucksRenderSpy.mockRestore();
    });

    // Helper: send a password-reset request and extract the reset key that
    // the controller stored in the in-memory Store. Both mailer stubs must
    // already be active (set up in the enclosing beforeEach).
    async function getResetKey() {
      const spy = vi.spyOn(Store, 'set');
      await flow.sendPassReset({ email: defaults.user.email });
      const call = spy.mock.calls.find(
        args => /^user/.test(args[0]) && /reset$/.test(args[0])
      );
      spy.mockRestore();
      if (!call) throw new Error('sendPassReset did not store a reset key in the Store');
      return call[0].split(':')[1];
    }

    it('should send a password reset email', async () => {
      const user = await new Promise((resolve, reject) =>
        User.findByLogin(defaults.user.email, (err, doc) => err ? reject(err) : resolve(doc))
      );

      const storeSpy = vi.spyOn(Store, 'set');
      await flow.sendPassReset({ email: defaults.user.email });
      expect(flow.wasOk).toBe(true);

      const call = storeSpy.mock.calls.find(
        args => /^user/.test(args[0]) && /reset$/.test(args[0])
      );
      expect(call).toBeTruthy();
      expect(call[0]).toMatch(/^user/);
      expect(call[0]).toMatch(/reset$/);

      const val = await Store.get(call[0]);
      expect(val).toEqual(user.id.toString());

      expect(mailerSendSpy).toHaveBeenCalledTimes(1);
      storeSpy.mockRestore();
    });

    describe('When accessing valid reset password URL', () => {
      it('should allow the reset password page to load', async () => {
        const resetKey = await getResetKey();
        await flow.resetPassForm(resetKey);
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
      });

      describe('When entering matching passwords with key', () => {
        it('should change your password', async () => {
          const resetKey = await getResetKey();
          const pass = 'such course';
          await flow.savePass({ key: resetKey, password: pass, password_verify: pass });
          expect(flow.wasOk).toBe(true);
          expect(flow.lastResponse.statusCode).toBe(200);

          // login with new password
          await flow.login({ email: defaults.user.email, password: pass });
          expect(flow.wasOk).toBe(true);
          expect(flow.lastRedirect.pathname).toBe('/home');
        });
      });

      describe('When entering passwords without a key', () => {
        it('should redirect to the forgot password page', async () => {
          // Joi validation requires 'key' in the payload; missing key → fail
          await flow.savePass({ password: 'such course', password_verify: 'such course' });
          expect(flow.wasOk).toBe(true);
          expect(flow.lastResponse.statusCode).toBe(302);
          expect(flow.lastRedirect.pathname).toBe('/forgot-pass');
        });
      });

      describe('When entering non-matching passwords', () => {
        it('should not change your password', async () => {
          const resetKey = await getResetKey();
          await flow.savePass({ key: resetKey, password: 'such course', password_verify: 'much open' });
          expect(flow.wasOk).toBe(true);
          expect(flow.lastResponse.statusCode).toBe(302);
          expect(flow.lastRedirect.pathname).toBe('/reset-pass');
        });
      });
    });

    describe('When accessing invalid reset password URL', () => {
      it('should redirect to the forgot password page', async () => {
        await flow.sendPassReset({ email: defaults.user.email });
        // fake an invalid key (keys are expected to be 8+ hex characters)
        await flow.resetPassForm('fake');
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(302);
        expect(flow.lastRedirect.pathname).toBe('/forgot-pass');
      });
    });
  });
});
