'use strict';

// What Add Students tells the instructor has to match what the server does.
//
// A course invitation is emailed only when the deploy has a mailer
// (lib/controllers/course.js: `if (mailer.isConfigured() ...)`). Without one,
// nobody is contacted: the invitation simply waits, and the student joins the
// first time they sign in with that address. The form used to say "invited"
// either way, and an instructor on a no-mail deploy waited for invitation
// emails that were never sent (MIAuthors #12).
//
// So the page is told which kind of deploy it is on (`inviteEmailEnabled`,
// computed by the same mailer.isConfigured() the send uses) and the words
// follow it.

const fs   = require('fs');
const path = require('path');

const rosterMessage = require('../../public/js/courseEditor/rosterMessage');

const totals = (over) => Object.assign(
  { enrolled: 0, invited: 0, invalid: 0, held: 0, duplicates: 0, failed: 0 }, over);

describe('rosterMessage.report: the deploy cannot send email', () => {
  const report = (t) => rosterMessage.report(totals(t), { inviteEmail: false });

  it('says plainly that students are not emailed', () => {
    const { message } = report({ invited: 5 });
    expect(message).toMatch(/doesn't email students/);
    expect(message).not.toMatch(/\binvited\b/);
    expect(message).not.toMatch(/\bemailed\b|\bsent\b/);
  });

  it('tells the instructor how students join', () => {
    const { message } = report({ invited: 5 });
    expect(message).toMatch(/^5 added\./);
    expect(message).toMatch(/first time they sign in/);
  });

  it('adds nothing about email when everyone was enrolled directly', () => {
    const { message, className } = report({ enrolled: 3 });
    expect(message).toBe('3 enrolled.');
    expect(className).toBe('success');
  });
});

describe('rosterMessage.report: the deploy sends invitation emails', () => {
  const report = (t) => rosterMessage.report(totals(t), { inviteEmail: true });

  it('says the invitations were emailed', () => {
    const { message } = report({ enrolled: 2, invited: 5 });
    expect(message).toMatch(/^2 enrolled, 5 invited\./);
    expect(message).toMatch(/emailed/);
    expect(message).not.toMatch(/doesn't email/);
  });
});

describe('rosterMessage.report: the parts that do not depend on email', () => {
  it.each([true, false])('keeps the skipped/held/failed notes (inviteEmail=%s)', (inviteEmail) => {
    const { message, className } = rosterMessage.report(
      totals({ invited: 1, invalid: 2, held: 3, duplicates: 4, failed: 1 }), { inviteEmail });
    expect(message).toContain('2 invalid email(s) skipped.');
    expect(message).toContain('3 line(s) had no email address and were left in the box.');
    expect(message).toContain('4 duplicate line(s) ignored.');
    expect(message).toContain('1 batch(es) failed');
    expect(className).toBe('alert');
  });

  it('warns when nothing was added', () => {
    expect(rosterMessage.report(totals({}), { inviteEmail: false }))
      .toEqual({ message: 'No new students added.', className: 'warning' });
  });

  it('treats a missing option as no email: never promise a send that may not happen', () => {
    expect(rosterMessage.report(totals({ invited: 1 })).message).toMatch(/doesn't email students/);
  });
});

describe('the server tells the page whether invitations are emailed', () => {
  const mailer = require('../../lib/util/mailer');
  const { addUserContext } = require('../../lib/util/routeParser');
  const request = { yar: { get: () => undefined } };

  afterEach(() => vi.restoreAllMocks());

  it.each([true, false])('inviteEmailEnabled follows mailer.isConfigured() (%s)', (configured) => {
    // The SAME check course.js uses to decide whether to send. emailEnabled
    // (AWS/Mailgun keys) answers a different question and can disagree.
    vi.spyOn(mailer, 'isConfigured').mockReturnValue(configured ? 'smtp.example.com' : '');
    const json = {};
    addUserContext(json, request);
    expect(json.inviteEmailEnabled).toBe(configured);
  });

  it('passes it to the Angular app config', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '../../lib/views/includes/app-config.html'), 'utf8');
    expect(html).toMatch(/inviteEmailEnabled\s*:\s*\{\{\s*'true' if inviteEmailEnabled else 'false'\s*\}\}/);
  });
});

describe('Add Students markup (static assertions; no Angular harness here)', () => {
  const html = fs.readFileSync(
    path.join(__dirname, '../../public/partials/course_editor.html'), 'utf8');
  const js = fs.readFileSync(
    path.join(__dirname, '../../public/js/courseEditor/controllers/usersControl.js'), 'utf8');
  const form = html.slice(html.indexOf('name="invite-users-form"'),
                          html.indexOf('</form>', html.indexOf('name="invite-users-form"')));

  it('explains each case in the form, gated on the flag', () => {
    expect(form).toMatch(/ng-if="inviteEmailEnabled"[^>]*>[^<]*emailed/);
    expect(form).toMatch(/ng-if="!inviteEmailEnabled"[^>]*>[^<]*doesn't email students/);
  });

  it('labels pending students as not yet signed in', () => {
    expect(html).toMatch(/Pending Students[^<]*<\/strong>\s*<span[^>]*>\s*\(haven't joined yet\)/);
  });

  it('the controller reads the flag and uses the shared message builder', () => {
    expect(js).toContain("trinketConfig.get('inviteEmailEnabled')");
    expect(js).toContain('trinketRosterMessage.report(');
  });

  it('the builder is loaded before the controller', () => {
    const yaml = fs.readFileSync(path.join(__dirname, '../../config/default.yaml'), 'utf8');
    const builder = yaml.indexOf("'/js/courseEditor/rosterMessage.js'");
    expect(builder).toBeGreaterThan(-1);
    expect(builder).toBeLessThan(yaml.indexOf("'/js/courseEditor/controllers/usersControl.js'"));
  });
});
