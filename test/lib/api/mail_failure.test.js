'use strict';
const defaults = require('../../helpers/defaults');
const Store    = require('../../../lib/util/store');
const mailer   = require('../../../lib/util/mailer');
const nunjucks = require('../../../lib/util/nunjucks');
const users    = require('../../../lib/controllers/users');
const config   = require('config');
const admin    = require('../../../lib/controllers/admin');

// These handlers answer the user first and send the email afterwards, so a failed
// send used to be an unhandled rejection that nobody saw. Here every send fails
// (the Mailgun-sandbox style 421) and we assert it is logged on one MAIL_SEND_FAILED
// line and never surfaces as an unhandled rejection.
const SEND_ERROR = Object.assign(
  new Error('Message failed: 421 sandbox is for test purposes only'),
  { code: 'EENVELOPE', responseCode: 421 }
);

let errSpy, unhandled, onUnhandled;

beforeEach(() => {
  unhandled   = [];
  onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(mailer, 'isConfigured').mockReturnValue(true);
  vi.spyOn(mailer, 'send').mockRejectedValue(SEND_ERROR);
  vi.spyOn(nunjucks, 'render').mockResolvedValue('<html>mail body</html>');
});

afterEach(() => {
  process.removeListener('unhandledRejection', onUnhandled);
  vi.restoreAllMocks();
});

// The mail work runs after the handler has already answered, and Node reports an
// unhandled rejection one tick after it happens, so give both time to play out.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const failureLines = () =>
  errSpy.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('MAIL_SEND_FAILED'));

function fakeRequest(payload) {
  return {
    user    : { id: 'u1', fullname: 'Test User', username: 'testuser', email: 'old@example.com' },
    payload : Object.assign({ 'g-recaptcha-response': 'x' }, payload),
    headers : {},
    success : vi.fn(),
    fail    : vi.fn(),
  };
}

describe('A failed mail send is logged and never an unhandled rejection', () => {

  describe('password reset (users.sendPassReset)', () => {
    beforeEach(async () => {
      await new User(defaults.user).save();
    });

    it('logs the failed send', async () => {
      const request = fakeRequest({ email: defaults.user.email });
      users.sendPassReset(request, vi.fn());
      await vi.waitFor(() => expect(request.success).toHaveBeenCalled());
      await settle();

      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=password-reset');
      expect(failureLines()[0]).toContain('to=' + defaults.user.email);
      expect(failureLines()[0]).toContain('responseCode=421');
    });

    it('answers a failed key store and sends nothing, with no unhandled rejection (#343)', async () => {
      vi.spyOn(Store, 'set').mockRejectedValue(new Error('redis down'));
      const request = fakeRequest({ email: defaults.user.email });
      users.sendPassReset(request, vi.fn());
      await vi.waitFor(() => expect(request.fail).toHaveBeenCalled());
      await settle();

      expect(request.fail.mock.calls[0][0].message).toMatch(/password reset/i);
      expect(request.success).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    });

    it('answers a failed key expiry the same way (#343)', async () => {
      vi.spyOn(Store, 'expire').mockRejectedValue(new Error('redis down'));
      const request = fakeRequest({ email: defaults.user.email });
      users.sendPassReset(request, vi.fn());
      await vi.waitFor(() => expect(request.fail).toHaveBeenCalled());
      await settle();

      expect(request.success).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    });

    it('logs a template-render failure too, without attempting a send', async () => {
      nunjucks.render.mockRejectedValue(new Error('template not found: emails/passwordReset'));
      const request = fakeRequest({ email: defaults.user.email });
      users.sendPassReset(request, vi.fn());
      await vi.waitFor(() => expect(request.success).toHaveBeenCalled());
      await settle();

      expect(mailer.send).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=password-reset');
      expect(failureLines()[0]).toContain('template not found');
    });
  });

  describe('email verification (users.sendEmailVerification)', () => {
    it('logs the failed send', async () => {
      const request = fakeRequest({});
      users.sendEmailVerification(request, vi.fn());
      await vi.waitFor(() => expect(request.success).toHaveBeenCalled());
      await settle();

      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=verify-email');
      expect(failureLines()[0]).toContain('to=old@example.com');
    });

    it('answers a failed key store and sends nothing, with no unhandled rejection (#343)', async () => {
      vi.spyOn(Store, 'set').mockRejectedValue(new Error('redis down'));
      const request = fakeRequest({});
      users.sendEmailVerification(request, vi.fn());
      await vi.waitFor(() => expect(request.fail).toHaveBeenCalled());
      await settle();

      expect(request.fail.mock.calls[0][0].message).toMatch(/verification email/i);
      expect(request.success).not.toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
    });

    it('logs a template-render failure too, without attempting a send', async () => {
      nunjucks.render.mockRejectedValue(new Error('template not found: emails/verifyEmail'));
      const request = fakeRequest({});
      users.sendEmailVerification(request, vi.fn());
      await vi.waitFor(() => expect(request.success).toHaveBeenCalled());
      await settle();

      expect(mailer.send).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=verify-email');
    });
  });

  // resendEmailChange is the only route to the change-email confirmation mail.
  // sendEmailChange was removed (#340): it passed a callback to Store.set, which
  // ignores it, so it could neither answer nor send, and no route reached it.
  describe('email change confirmation (users.resendEmailChange)', () => {
    it('no longer has an unreachable sendEmailChange handler (#340)', () => {
      expect(users.sendEmailChange).toBeUndefined();
    });

    it('logs the failed send to the NEW address', async () => {
      await Store.set(
        Store.user.change_email_key('u1'),
        JSON.stringify({ key: 'abc12345', new_email: 'new@example.com' })
      );
      const request = fakeRequest({});
      users.resendEmailChange(request, vi.fn());
      await vi.waitFor(() => expect(request.success).toHaveBeenCalled());
      await settle();

      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=confirm-email-change');
      expect(failureLines()[0]).toContain('to=new@example.com');
    });
  });

  describe('session alert (admin.ohnoes)', () => {
    let adminEmailWas;
    beforeEach(() => { adminEmailWas = config.app.adminEmail; });
    afterEach(() => { config.app.adminEmail = adminEmailWas; });

    const alertLog = [{ time: 't', path: '/p', referrer: '', user: 'u', userAgent: 'ua', sesh: 's' }];

    it('logs a failed alert', async () => {
      config.app.adminEmail = 'admin@example.com';
      const request = fakeRequest({ log: alertLog });
      admin.ohnoes(request, vi.fn());
      await settle();

      expect(request.success).toHaveBeenCalled();
      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=session-alert');
      expect(failureLines()[0]).toContain('to=admin@example.com');
    });

    it('builds the alert text from the log, with no leading "undefined" (#342)', async () => {
      config.app.adminEmail = 'admin@example.com';
      const request = fakeRequest({ log: alertLog });
      admin.ohnoes(request, vi.fn());
      await settle();

      const options = mailer.send.mock.calls[0][2];
      expect(options.text).not.toMatch(/undefined/);
      expect(options.text.trim().startsWith('time')).toBe(true);
      expect(options.text).toContain('path\t\t/p');
    });

    it('does nothing when no admin address is configured (the shipped default)', async () => {
      config.app.adminEmail = '';
      const request = fakeRequest({ log: alertLog });
      admin.ohnoes(request, vi.fn());
      await settle();

      expect(request.success).toHaveBeenCalled();
      expect(mailer.send).not.toHaveBeenCalled();
      expect(unhandled).toEqual([]);
      expect(failureLines()).toEqual([]);
    });
  });

  describe('trinket share by email (trinket.email)', () => {
    const trinketCtl     = require('../../../lib/controllers/trinket');
    const TrinketModel   = require('../../../lib/models/trinket');
    const globalNunjucks = require('nunjucks');   // trinket.js renders with the global (synchronous) nunjucks

    function shareRequest() {
      const request = fakeRequest({ email: 'friend@example.com', name: 'Todd' });
      request.pre   = { trinket: { id: 't1', lang: 'python', shortCode: 'abc123', snapshot: '' } };
      return request;
    }

    beforeEach(() => {
      vi.spyOn(globalNunjucks, 'render').mockReturnValue('<html>share</html>');
    });

    // #341: the final catch used to call a bare reply(), which this app's reply shim
    // never settles (it resolves only on a redirect, code, header, view or an error
    // object), so the share dialog waited forever. A vi.fn() reply hides that, which is
    // why the old assertion on reply() passed: assert on what answers the request.
    it('answers a failed send with request.fail, logs it, and never calls a bare reply()', async () => {
      const request = shareRequest();
      const reply   = vi.fn();

      trinketCtl.email(request, reply);
      await vi.waitFor(() => expect(request.fail).toHaveBeenCalled(), { timeout: 5000 });
      await settle();

      expect(request.fail).toHaveBeenCalledTimes(1);
      expect(request.fail.mock.calls[0][0].message).toMatch(/could not send/i);
      expect(request.success).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();

      expect(unhandled).toEqual([]);
      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=trinket-share');
      expect(failureLines()[0]).toContain('to=friend@example.com');
    });

    it('still answers 403 when the share limit is exceeded', async () => {
      mailer.send.mockResolvedValue({});
      vi.spyOn(TrinketModel, 'findByIdAndUpdateMetrics').mockRejectedValue('threshold exceeded');
      const request = shareRequest();
      const reply   = vi.fn();

      trinketCtl.email(request, reply);
      await vi.waitFor(() => expect(reply).toHaveBeenCalled(), { timeout: 5000 });

      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply.mock.calls[0][0].isBoom).toBe(true);
      expect(reply.mock.calls[0][0].output.statusCode).toBe(403);
      expect(request.fail).not.toHaveBeenCalled();
      expect(request.success).not.toHaveBeenCalled();
    });

    it('does not tell the sender it failed when the email went out and only the share count failed', async () => {
      mailer.send.mockResolvedValue({});
      vi.spyOn(TrinketModel, 'findByIdAndUpdateMetrics').mockRejectedValue(new Error('metrics store down'));
      const request = shareRequest();
      const reply   = vi.fn();

      trinketCtl.email(request, reply);
      await vi.waitFor(() => expect(request.success).toHaveBeenCalled(), { timeout: 5000 });

      expect(request.fail).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(failureLines()).toEqual([]);
    });
  });

  // courseInvitation.js already caught and logged its own failures, but with a line that
  // carried no marker, so log-based monitoring could not see instructor invitations fail.
  describe('course invitation (CourseInvitation.sendEmails)', () => {
    it('logs a failed send with the marker, and behaves exactly as before otherwise', async () => {
      const CourseInvitation = require('../../../lib/models/courseInvitation');
      const invitation = { status: 'pending', email: 'student@example.com', token: 'tok123', save: vi.fn() };
      const course     = { name: 'Physics 101', description: 'd' };
      const user       = { fullname: 'Prof', email: 'prof@example.com' };

      // behaviour unchanged: the operation still resolves
      await expect(CourseInvitation.sendEmails([invitation], course, user)).resolves.toBeDefined();
      await settle();

      expect(mailer.send).toHaveBeenCalledTimes(1);
      expect(invitation.save).not.toHaveBeenCalled();   // a failed send is not recorded as sent
      expect(invitation.status).toBe('pending');
      expect(unhandled).toEqual([]);

      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=course-invitation');
      expect(failureLines()[0]).toContain('to=student@example.com');

      // the pre-existing log line is still written, unchanged
      const oldLine = errSpy.mock.calls.filter((c) => c[0] === 'Failed to send course invitation email:');
      expect(oldLine).toHaveLength(1);
    });
  });
});
