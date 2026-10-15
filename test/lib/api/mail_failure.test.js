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

  // This goes through resendEmailChange, not sendEmailChange, although both end in
  // send_email_confirmation: sendEmailChange never completes (it passes a callback to
  // Store.set, which ignores it, so it neither answers nor sends). That is pre-existing
  // and out of scope here; resendEmailChange is the live path to the same mail.
  describe('email change confirmation (users.resendEmailChange)', () => {
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
    it('logs a failed send and responds exactly as before', async () => {
      const trinketCtl     = require('../../../lib/controllers/trinket');
      const globalNunjucks = require('nunjucks');   // trinket.js renders with the global (synchronous) nunjucks
      vi.spyOn(globalNunjucks, 'render').mockReturnValue('<html>share</html>');

      const request = fakeRequest({ email: 'friend@example.com', name: 'Todd' });
      request.pre   = { trinket: { id: 't1', lang: 'python', shortCode: 'abc123', snapshot: '' } };
      const reply   = vi.fn();

      trinketCtl.email(request, reply);
      await vi.waitFor(() => expect(reply).toHaveBeenCalled(), { timeout: 5000 });
      await settle();

      // behaviour unchanged: the existing .catch still calls reply() once, with no arguments
      expect(reply).toHaveBeenCalledTimes(1);
      expect(reply).toHaveBeenCalledWith();
      expect(request.success).not.toHaveBeenCalled();

      expect(unhandled).toEqual([]);
      expect(failureLines()).toHaveLength(1);
      expect(failureLines()[0]).toContain('type=trinket-share');
      expect(failureLines()[0]).toContain('to=friend@example.com');
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
