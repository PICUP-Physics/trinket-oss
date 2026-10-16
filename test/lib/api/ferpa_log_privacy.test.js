'use strict';
const config     = require('config');
const mailer     = require('../../../lib/util/mailer');
const nunjucks   = require('../../../lib/util/nunjucks');
const logPrivacy = require('../../../lib/util/logPrivacy');
const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const Store    = require('../../../lib/util/store');
const users    = require('../../../lib/controllers/users');

// The login form route exists only with the local auth provider.
const FB_MODE = process.env.TEST_AUTH_PROVIDER === 'firebase';

// With the default ferpa.logEmails (token), every log line that used to print a
// student's email address prints u-xxxxxxxx@domain instead; with `full` it prints
// the address as written. Log prefixes and the MAIL_SEND_FAILED field order do not
// change.
const ADDRESS  = 'Student@CNU.edu';
const TOKEN_RE = /^u-[0-9a-f]{8}@cnu\.edu$/;

let ferpaWas, errSpy, logSpy;

beforeEach(() => {
  ferpaWas = config.ferpa;
  config.ferpa = { logEmails: 'token', logTokenSecret: 'k'.repeat(40) };
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  config.ferpa = ferpaWas;
  vi.restoreAllMocks();
});

// Each console call as one string, its arguments joined by spaces.
const calls = (spy) => spy.mock.calls.map((c) => c.map(String).join(' '));

describe('Student email addresses in server logs (ferpa.logEmails)', () => {

  describe('MAIL_SEND_FAILED (mailer.logFailure)', () => {
    const smtpError = () => Object.assign(
      new Error('Message failed: 550 5.1.1 <' + ADDRESS + '>: Recipient address rejected'),
      { code: 'EENVELOPE', responseCode: 550 }
    );

    it('writes the same token for to= and for the address in the SMTP reply', () => {
      mailer.logFailure(smtpError(), { to: ADDRESS, type: 'password-reset' });
      const token = logPrivacy.email(ADDRESS);
      expect(token).toMatch(TOKEN_RE);
      expect(calls(errSpy)).toEqual([
        'MAIL_SEND_FAILED type=password-reset to=' + token + ' code=EENVELOPE responseCode=550 ' +
        'message="Message failed: 550 5.1.1 <' + token + '>: Recipient address rejected"',
      ]);
    });

    it('writes the address as given with ferpa.logEmails: full', () => {
      config.ferpa.logEmails = 'full';
      mailer.logFailure(smtpError(), { to: ADDRESS, type: 'password-reset' });
      expect(calls(errSpy)[0]).toContain('to=' + ADDRESS + ' ');
      expect(calls(errSpy)[0]).toContain('<' + ADDRESS + '>');
    });
  });

  describe('send skipped because email is not configured (mailer.send)', () => {
    let hostWas;
    beforeEach(() => { hostWas = config.app.mail.host; config.app.mail.host = ''; });
    afterEach(() => { config.app.mail.host = hostWas; });

    it('logs a token instead of the recipient', async () => {
      await mailer.send(ADDRESS, 'Hi', {});
      expect(calls(logSpy)).toContain('Email not configured, skipping send to: ' + logPrivacy.email(ADDRESS));
      expect(calls(logSpy).join('\n')).not.toContain(ADDRESS);
    });
  });

  describe('course invitation failure (CourseInvitation.sendEmails)', () => {
    it('writes tokens in the MAIL_SEND_FAILED line and in the invitation error line', async () => {
      const CourseInvitation = require('../../../lib/models/courseInvitation');
      vi.spyOn(nunjucks, 'render').mockResolvedValue('<html>invite</html>');
      vi.spyOn(mailer, 'send').mockRejectedValue(new Error('Message failed: 550 <' + ADDRESS + '> rejected'));
      const invitation = { status: 'pending', email: ADDRESS, token: 'tok123', save: vi.fn() };

      await CourseInvitation.sendEmails([invitation], { name: 'Physics 101', description: 'd' },
        { fullname: 'Prof', email: 'prof@example.com' });

      const token = logPrivacy.email(ADDRESS);
      const lines = calls(errSpy);
      expect(lines.some((l) => l.startsWith('MAIL_SEND_FAILED type=course-invitation to=' + token + ' '))).toBe(true);
      expect(lines).toContain('Failed to send course invitation email: Message failed: 550 <' + token + '> rejected');
      expect(lines.join('\n')).not.toContain(ADDRESS);
    });
  });

  describe.skipIf(FB_MODE)('login lines (users.login)', () => {
    beforeEach(async () => {
      flow.cookies    = {};
      flow.activeUser = 'user';
      await new User(Object.assign({}, defaults.user, { email: 'student@cnu.edu' })).save();
    });

    it('writes the same token on both LOGIN lines for an email login', async () => {
      await flow.login({ email: 'Student@CNU.edu', password: defaults.user.password });
      const token = logPrivacy.email('student@cnu.edu');
      const lines = calls(logSpy);
      expect(lines).toContain('LOGIN: Starting login for ' + token);
      expect(lines).toContain('LOGIN: findByLogin callback null ' + token);
      expect(lines.join('\n').toLowerCase()).not.toContain('student@cnu.edu');
    });

    it('prints a typed username unchanged, and the stored email as a token', async () => {
      await flow.login({ email: defaults.user.username, password: defaults.user.password });
      const lines = calls(logSpy);
      expect(lines).toContain('LOGIN: Starting login for ' + defaults.user.username);
      expect(lines).toContain('LOGIN: findByLogin callback null ' + logPrivacy.email('student@cnu.edu'));
    });

    it('prints addresses as written with ferpa.logEmails: full', async () => {
      config.ferpa.logEmails = 'full';
      await flow.login({ email: 'student@cnu.edu', password: defaults.user.password });
      expect(calls(logSpy)).toContain('LOGIN: Starting login for student@cnu.edu');
    });
  });

  describe('signup from a blocked domain (users.create)', () => {
    it('writes a token in the log line and in the error that request.fail logs', async () => {
      vi.spyOn(Store.email(), 'blockListLookup').mockResolvedValue(true);
      const request = {
        payload : { email: ADDRESS, password: 'secret-password', 'g-recaptcha-response': 'x' },
        yar     : { get: () => undefined, flash: vi.fn() },
        success : vi.fn(),
        fail    : vi.fn(),
      };

      await users.create(request, vi.fn());

      const token = logPrivacy.email(ADDRESS);
      expect(calls(logSpy)).toContain('blocking signup from: ' + token);
      expect(request.success).not.toHaveBeenCalled();
      expect(request.fail).toHaveBeenCalledTimes(1);
      expect(request.fail.mock.calls[0][1].message).toBe('blocking signup from: ' + token);
    });
  });
});
