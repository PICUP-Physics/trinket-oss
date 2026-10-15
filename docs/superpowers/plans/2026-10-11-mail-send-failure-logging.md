# Mail Send Failure Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A failed `mailer.send()` at the four call sites that drop its promise is logged as one greppable `MAIL_SEND_FAILED …` line and can no longer become an unhandled rejection; user-visible responses do not change.

**Architecture:** Two small helpers in `lib/util/mailer.js` (`logFailure`, `sendSafe`) carry all the logic; each call site swaps `mailer.send(` for `mailer.sendSafe(` (plus a `try/catch` or `.catch` where a template render can also fail). The log line is a monitoring contract, so the deployment's health check (separate repo) is updated in the final task.

**Tech Stack:** Node ≥20, CommonJS, hapi (legacy `request.success/fail`, `reply` shim), nodemailer, vitest 2 (`globals: true`).

**Spec:** `docs/superpowers/specs/2026-10-11-mail-send-failure-logging-design.md`

## Global Constraints

- Work only in the worktree `<trinket worktree>` on branch `fix/mail-send-errors`. Do **not** touch the main checkout (`trinket-oss-picup-fork/`, branch `stop-button`). Exception: Task 5 edits a different repo, named in that task.
- Match surrounding style: `var`, comma-first/aligned-colon object literals as in the file you are editing, 2-space indent. No new dependencies.
- The log line format is exactly `MAIL_SEND_FAILED type=<type> to=<address> code=<code> responseCode=<n> message="<text>"`, written with a single `console.error` call (same channel the neighbouring code uses). Field names and order must not change.
- User-visible behaviour must not change: same responses, same status codes. The only intended behaviour change is `admin.ohnoes` doing nothing when `config.app.adminEmail` is empty.
- `mailer.sendSafe` must call `module.exports.send` (not a closed-over reference) so `vi.spyOn(mailer, 'send')` in existing and new tests intercepts it.
- `lib/util/mailer.js` changes are **additive only**: do not modify `send`, `isConfigured`, `createTransport` or their behaviour. Eight modules import the mailer (see Impact Analysis) and five of them are not edited at all, so they must behave exactly as before.
- Firestore cost rule (CLAUDE.md): this change adds no database reads or writes.
- Commit with conventional messages (`fix(mail): …`, `test(mail): …`) and end each commit message with the trailer line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never use `--force`. Do not push.
- Test commands run from the worktree root. The first vitest run in a fresh session can time out in the global setup while the in-memory Mongo binary starts; if you see `Hook timed out in 10000ms` on a suite with all tests skipped, run again (it is a cold start, not a failure of your change).

## Review Focus

1. A rejection that is not an `Error` (a string, `undefined`, `null`) must not make `logFailure` throw. Pinned in Task 1.
2. A multi-line, quote-containing or very long SMTP response must stay on one log line, or monitoring would split or miss it. Pinned in Task 1.
3. `admin.ohnoes` with an empty `adminEmail` (the shipped default) must not attempt a send and must not log a failure. Pinned in Task 3.
4. A template-render failure after the reset response is sent must be logged, must not attempt a send, and must not become an unhandled rejection. Pinned in Task 2.
5. The success path is untouched: `sendSafe` returns exactly what `send` returns, and the existing `forgot_pass` and `trinket` suites keep passing. Pinned in Tasks 1 and 4.

## Impact Analysis (code-review-graph and graphify, checked 2026-10-11)

`importers_of lib/util/mailer.js` (code-review-graph) returns 10 files, cross-checked with a repo-wide grep (`mailer.send` appears 8 times in `lib/`; nothing outside `mailer.js` touches nodemailer, `sendMail` or `createTransport`):

| Importer | Uses | This plan |
|---|---|---|
| `lib/controllers/users.js` | `send` x3 (dropped promise), `isConfigured` | **Task 2** |
| `lib/controllers/admin.js` | `send` x1 (dropped promise) | **Task 3** |
| `lib/controllers/trinket.js` | `send` x1 (own `.catch`, silent) | **Task 4** (log only) |
| `lib/models/courseInvitation.js` | `send`, already `.catch`es and logs | untouched |
| `lib/workers/exports.js` | `send` x2, rejection propagates into the job's failure path | untouched |
| `lib/controllers/course.js` | `isConfigured` only (lines 771, 818) | untouched |
| `lib/controllers/pages.js`, `app.js` | import only, no call | untouched |
| `test/lib/api/forgot_pass.test.js`, `trinket.test.js` | spy on `send` / `isConfigured` | must keep passing (Tasks 2 and 4) |

Consequences for the work: the mailer changes must be additive (Global Constraints), so the five untouched importers cannot change behaviour; the call-site tasks are the only places user-visible flow is edited. The coordinator re-runs code-review-graph `detect_changes` / impact on the finished branch (graph built for this worktree) and compares the changed-function list with this table before the final review.

---

### Task 1: `mailer.logFailure` and `mailer.sendSafe`

**Files:**
- Modify: `lib/util/mailer.js`
- Create: `test/unit/mailer-send-safe.test.js`
- Modify: `config/local.example.yaml:39-41` (one comment line)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (Tasks 2-4 call these exact signatures):
  - `mailer.logFailure(err, ctx)`: `err` is anything a promise can reject with; `ctx` is optional `{ type?: string, to?: string }`. Returns `undefined`. Never throws. Writes one line via `console.error`.
  - `mailer.sendSafe(to, subject, options)`: same arguments as `mailer.send`. Returns a promise that **never rejects**: resolves to `send()`'s return value on success, or `{ failed: true, error: <the rejection> }` after logging.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/mailer-send-safe.test.js`:

```js
'use strict';
const mailer = require('../../lib/util/mailer');

describe('mailer.logFailure', () => {
  let errSpy;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const lines = () => errSpy.mock.calls.map((c) => c.join(' '));

  it('writes one MAIL_SEND_FAILED line with type, recipient, codes and message', () => {
    const err = Object.assign(new Error('Message failed: 421 not allowed'), {
      code: 'EENVELOPE',
      responseCode: 421,
    });
    mailer.logFailure(err, { type: 'password-reset', to: 'a@b.edu' });
    expect(lines()).toEqual([
      'MAIL_SEND_FAILED type=password-reset to=a@b.edu code=EENVELOPE responseCode=421 message="Message failed: 421 not allowed"',
    ]);
  });

  it('collapses newlines, neutralises quotes and caps the message length', () => {
    const err = new Error('line one\r\nline "two"\n' + 'x'.repeat(1000));
    mailer.logFailure(err, { type: 't', to: 'a@b.edu' });
    const out = lines();
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/[\r\n]/);
    expect(out[0]).toContain("message=\"line one line 'two' xxx");
    expect(out[0].length).toBeLessThan(600);
  });

  it('does not throw on non-Error rejections or a missing context', () => {
    expect(() => mailer.logFailure('plain string')).not.toThrow();
    expect(() => mailer.logFailure(undefined, undefined)).not.toThrow();
    expect(() => mailer.logFailure(null, { to: undefined, type: undefined })).not.toThrow();
    const out = lines();
    expect(out[0]).toBe('MAIL_SEND_FAILED type=unknown to= code= responseCode= message="plain string"');
    expect(out[1]).toBe('MAIL_SEND_FAILED type=unknown to= code= responseCode= message=""');
    expect(out).toHaveLength(3);
  });
});

describe('mailer.sendSafe', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns what send() returns on success and logs nothing', async () => {
    const errSpy  = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sendSpy = vi.spyOn(mailer, 'send').mockResolvedValue({ messageId: 'm1' });
    const result  = await mailer.sendSafe('a@b.edu', 'Hi', { html: '<p>x</p>', type: 'verify-email' });
    expect(result).toEqual({ messageId: 'm1' });
    expect(sendSpy).toHaveBeenCalledWith('a@b.edu', 'Hi', { html: '<p>x</p>', type: 'verify-email' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('never rejects: resolves { failed, error } and logs one MAIL_SEND_FAILED line', async () => {
    const boom   = new Error('Message failed: 421 sandbox');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(mailer, 'send').mockRejectedValue(boom);
    const result = await mailer.sendSafe('a@b.edu', 'Hi', { type: 'password-reset' });
    expect(result).toEqual({ failed: true, error: boom });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0][0]).toContain('MAIL_SEND_FAILED type=password-reset to=a@b.edu');
  });

  it('copes with a missing options object', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(mailer, 'send').mockRejectedValue(new Error('x'));
    await expect(mailer.sendSafe('a@b.edu', 'Hi')).resolves.toMatchObject({ failed: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/mailer-send-safe.test.js`
Expected: all 6 tests FAIL with `mailer.logFailure is not a function` / `mailer.sendSafe is not a function`.

- [ ] **Step 3: Implement the helpers**

In `lib/util/mailer.js`, add these two functions between `createTransport()` and `module.exports` (after the closing `}` of `createTransport`, before the blank line preceding `module.exports = {`):

```js
// Collapse to a single line and cap the length, so a multi-line SMTP response
// can never split a log entry (monitoring matches one MAIL_SEND_FAILED line
// per failure).
function oneLine(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

// One stable, greppable line per failed send. The deployment health check
// matches the MAIL_SEND_FAILED marker — do not rename it or reorder the
// key=value fields without updating that script.
function logFailure(err, ctx) {
  ctx = ctx || {};
  var detail = err && err.message ? err.message : err;

  console.error(
    'MAIL_SEND_FAILED' +
    ' type='         + (oneLine(ctx.type, 40) || 'unknown') +
    ' to='           + oneLine(ctx.to, 120) +
    ' code='         + oneLine(err && err.code, 40) +
    ' responseCode=' + oneLine(err && err.responseCode, 10) +
    ' message="'     + oneLine(detail, 300).replace(/"/g, "'") + '"'
  );
}
```

Then add these two members to the `module.exports` object, after `isConfigured: isConfigured,`:

```js
  logFailure: logFailure,

  // Fire-and-forget variant of send(): never rejects. For callers that answer
  // the user first and send afterwards, where a failed send has nobody to
  // report to. Goes through module.exports.send so tests can spy on send().
  sendSafe: async function(to, subject, options) {
    try {
      return await module.exports.send(to, subject, options);
    } catch (err) {
      logFailure(err, { to: to, type: options && options.type });
      return { failed: true, error: err };
    }
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/mailer-send-safe.test.js`
Expected: 6 passed.

- [ ] **Step 5: Document the marker for operators**

In `config/local.example.yaml`, change the comment line

```yaml
# Without email, users can still register and log in, but password reset won't work.
```

to

```yaml
# Without email, users can still register and log in, but password reset won't work.
# A failed send is logged as one "MAIL_SEND_FAILED type=... to=... message=..." line in the
# app log (users are still told "success"), so grep for it if mail is not arriving.
# Mailgun sandbox domains only deliver to authorized recipients.
```

- [ ] **Step 6: Commit**

```bash
git add lib/util/mailer.js test/unit/mailer-send-safe.test.js config/local.example.yaml
git commit -m "fix(mail): add logFailure and sendSafe so failed sends are logged, not unhandled

sendSafe never rejects and logs one greppable MAIL_SEND_FAILED line per
failure; logFailure is also usable on its own from existing catch blocks.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Password reset, email-change and email-verification mails

**Files:**
- Modify: `lib/controllers/users.js` (three places: the reset block in `sendPassReset` at ~315-322, `send_email_confirmation` at ~1232, `send_email_verification` at ~1245)
- Create: `test/lib/api/mail_failure.test.js`

**Interfaces:**
- Consumes: `mailer.sendSafe(to, subject, options)` and `mailer.logFailure(err, ctx)` from Task 1 (exact signatures above).
- Produces: `test/lib/api/mail_failure.test.js` with the shared helpers `fakeRequest`, `settle`, `failureLines` and the top-level `beforeEach`/`afterEach` that Tasks 3 and 4 append `describe` blocks to. Types: `type=password-reset`, `type=confirm-email-change`, `type=verify-email`.

- [ ] **Step 1: Write the failing tests**

Create `test/lib/api/mail_failure.test.js` (Tasks 3 and 4 will add their blocks inside the outer `describe`):

```js
'use strict';
const defaults = require('../../helpers/defaults');
const mailer   = require('../../../lib/util/mailer');
const nunjucks = require('../../../lib/util/nunjucks');
const users    = require('../../../lib/controllers/users');
const Store    = require('../../../lib/util/store');

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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/lib/api/mail_failure.test.js`
Expected: the 5 tests FAIL. For the "failed send" tests: `expected [] to have a length of 1` on `failureLines()` and/or `unhandled` containing the 421 error. (Vitest also prints an "Unhandled Rejection" summary for the pre-fix code; that is the bug being fixed.)

- [ ] **Step 3: Fix the password-reset block**

In `lib/controllers/users.js`, inside `sendPassReset`, replace

```js
            var message = await nunjucks.render('emails/passwordReset', {
              fullname           : user.fullname,
              username           : user.username,
              reset_password_url : reset_password_url
            });
            mailer.send(user.email, 'Password reset', { html : message, type : 'password-reset' });
```

with

```js
            try {
              var message = await nunjucks.render('emails/passwordReset', {
                fullname           : user.fullname,
                username           : user.username,
                reset_password_url : reset_password_url
              });
              await mailer.sendSafe(user.email, 'Password reset', { html : message, type : 'password-reset' });
            }
            catch (err) {
              // the response was already sent above, so a render failure has nobody to
              // report to and must not become an unhandled rejection; sendSafe logs its own
              mailer.logFailure(err, { to : user.email, type : 'password-reset' });
            }
```

- [ ] **Step 4: Fix the two private email functions**

In `lib/controllers/users.js`, in `send_email_confirmation`, replace

```js
  }).then(function(message) {
    mailer.send(new_email, 'Confirm new email address', { html : message, type : 'confirm-email-change' });
  });
```

with

```js
  }).then(function(message) {
    return mailer.sendSafe(new_email, 'Confirm new email address', { html : message, type : 'confirm-email-change' });
  }).catch(function(err) {
    // only a template-render failure can land here (sendSafe never rejects)
    mailer.logFailure(err, { to : new_email, type : 'confirm-email-change' });
  });
```

and in `send_email_verification`, replace

```js
  }).then(function(message) {
    mailer.send(email, 'Verify email address', { html : message, type : 'verify-email' });
  });
```

with

```js
  }).then(function(message) {
    return mailer.sendSafe(email, 'Verify email address', { html : message, type : 'verify-email' });
  }).catch(function(err) {
    // only a template-render failure can land here (sendSafe never rejects)
    mailer.logFailure(err, { to : email, type : 'verify-email' });
  });
```

- [ ] **Step 5: Run the new tests and the existing reset suite**

Run: `npx vitest run test/lib/api/mail_failure.test.js test/lib/api/forgot_pass.test.js`
Expected: `mail_failure.test.js` 5 passed, `forgot_pass.test.js` 7 passed, no "Unhandled Rejection" in the output. (`forgot_pass` spies on `mailer.send`, which `sendSafe` goes through, so its "should send a password reset email" test still passes unchanged.)

- [ ] **Step 6: Commit**

```bash
git add lib/controllers/users.js test/lib/api/mail_failure.test.js
git commit -m "fix(mail): log failed password-reset, verification and email-change sends

These handlers answer 'success' before sending and dropped the send promise,
so a refused SMTP send was an unhandled rejection nobody saw (and a crash on
Node 20). Send and render failures are now logged as MAIL_SEND_FAILED; the
responses are unchanged.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Admin session-alert mail (`admin.ohnoes`)

**Files:**
- Modify: `lib/controllers/admin.js` (the `ohnoes` handler, ~lines 117-138)
- Modify: `test/lib/api/mail_failure.test.js` (append a `describe` inside the outer one)

**Interfaces:**
- Consumes: `mailer.sendSafe` from Task 1; `fakeRequest`, `settle`, `failureLines`, `mailer`, the shared `beforeEach`/`afterEach` from Task 2's test file.
- Produces: `type=session-alert` in the log line.

- [ ] **Step 1: Write the failing tests**

At the top of `test/lib/api/mail_failure.test.js`, add after the existing `require` lines:

```js
const config   = require('config');
const admin    = require('../../../lib/controllers/admin');
```

Then add this block inside the outer `describe('A failed mail send is logged and never an unhandled rejection', …)`, after the last existing inner `describe`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/lib/api/mail_failure.test.js -t "session alert"`
Expected: both FAIL. "logs a failed alert": `failureLines()` has length 0 (and an unhandled rejection is reported). "does nothing": `mailer.send` was called once (it is called with `''`).

- [ ] **Step 3: Fix `ohnoes`**

In `lib/controllers/admin.js`, in `ohnoes`, replace

```js
    if (!log || !log.length) return;
```

with

```js
    // no admin address configured (the default) means nobody to alert
    if (!config.app.adminEmail || !log || !log.length) return;
```

and replace

```js
    mailer.send(config.app.adminEmail, 'User Session Alert', {
      text : msg
    });
```

with

```js
    mailer.sendSafe(config.app.adminEmail, 'User Session Alert', {
      text : msg,
      type : 'session-alert'
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/lib/api/mail_failure.test.js`
Expected: 7 passed, no "Unhandled Rejection" output.

- [ ] **Step 5: Commit**

```bash
git add lib/controllers/admin.js test/lib/api/mail_failure.test.js
git commit -m "fix(mail): don't mail a session alert to nobody, and log a failed one

ohnoes called mailer.send(config.app.adminEmail, ...) and dropped the promise;
adminEmail defaults to '' so nodemailer rejected with no recipient, unhandled.
It now skips when no address is configured and logs a failed send.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Share-by-email failures are logged

**Files:**
- Modify: `lib/controllers/trinket.js` (the `email` handler, ~line 1004)
- Modify: `test/lib/api/mail_failure.test.js` (append a `describe`)

**Interfaces:**
- Consumes: `mailer.logFailure` from Task 1; the shared helpers from Task 2's test file.
- Produces: `type=trinket-share` in the log line. Response behaviour is deliberately **unchanged**.

Context for the implementer: the share handler already has a `.catch` that turns any failure into a bare `reply()` call, so a failed send is not an unhandled rejection today, but it is silent. We add a log line and rethrow so that existing `.catch` still decides the response exactly as before. (Known and out of scope: that bare `reply()` never completes the HTTP request when the send fails. The test pins `reply()` being called with no arguments, once, so this change cannot alter that behaviour.)

- [ ] **Step 1: Write the failing test**

Add this block inside the outer `describe` in `test/lib/api/mail_failure.test.js`, after the other inner blocks:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/lib/api/mail_failure.test.js -t "trinket share"`
Expected: FAIL on `expected [] to have a length of 1` (`failureLines()` is empty). The `reply` assertions pass already, which is the point: they pin the current behaviour.

- [ ] **Step 3: Add the logging `.catch`**

In `lib/controllers/trinket.js`, replace

```js
        return mailer.send(request.payload.email, subject, options)
          .then(function() {
```

with

```js
        return mailer.send(request.payload.email, subject, options)
          .catch(function(err) {
            // log, then rethrow so the existing catch below still decides the response
            mailer.logFailure(err, { to : request.payload.email, type : 'trinket-share' });
            throw err;
          })
          .then(function() {
```

- [ ] **Step 4: Run the new test and the neighbouring suites**

Run: `npx vitest run test/lib/api/mail_failure.test.js test/lib/api/trinket.test.js test/lib/api/forgot_pass.test.js test/unit/mailer-send-safe.test.js`
Expected: `mail_failure` 8 passed, `trinket` 14 passed, `forgot_pass` 7 passed, `mailer-send-safe` 6 passed; no "Unhandled Rejection" output.

- [ ] **Step 5: Commit**

```bash
git add lib/controllers/trinket.js test/lib/api/mail_failure.test.js
git commit -m "fix(mail): log a failed share-by-email send instead of swallowing it silently

The existing catch turned a send failure into a bare reply() with no trace.
Log it as MAIL_SEND_FAILED and rethrow so the response is unchanged.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Teach the deployment health check the new marker (separate repo)

This task edits a **different repository**: `<monitoring_trinket_server repo>` (its own git repo, branch `main`). Run its git commands with `git -C` that path. Do not commit anything to the Trinket worktree for this task.

**Files:**
- Modify: `<monitoring_trinket_server repo>/trinket_scheduled_check.sh` (the `MAIL SEND FAILURES` section)
- Create: `<monitoring_trinket_server repo>/tests/mail_section_test.sh`
- Modify: `<monitoring_trinket_server repo>/trinket_monitoring_context.md`, `lab_notebook.md`

**Interfaces:**
- Consumes: the log line written by Task 1's `logFailure`: `MAIL_SEND_FAILED type=<type> to=<address> code=<code> responseCode=<n> message="<text>"`.
- Produces: the health check counts one failure per `MAIL_SEND_FAILED` line **and** still counts the old raw `Error: Message failed: …` header lines (servers not yet upgraded). Counts feed the existing `MAIL_FAIL_COUNT` / `FLAGS` logic unchanged.

- [ ] **Step 1: Write the failing test script**

Create `tests/mail_section_test.sh`:

```bash
#!/bin/bash
# Runs the MAIL SEND FAILURES section of trinket_scheduled_check.sh on its own
# against canned `docker logs` output. Works on macOS (BSD date shim) and Linux.
# Usage: bash tests/mail_section_test.sh   (exit 0 = all checks passed)
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

awk '/--- MAIL SEND FAILURES/{f=1} /--- REDIS ---"$/{if(f){exit}} f' "$HERE/trinket_scheduled_check.sh" > "$TMP/section.sh"
[ -s "$TMP/section.sh" ] || { echo "FAIL: could not extract the MAIL SEND FAILURES section"; exit 1; }

cat > "$TMP/docker_failures" <<'EOS'
#!/bin/bash
cat <<'LOG'
2026-10-11T16:20:04.000000000Z MAIL_SEND_FAILED type=password-reset to=a@b.edu code=EENVELOPE responseCode=421 message="Message failed: 421 sandbox"
2026-10-11T16:21:04.000000000Z MAIL_SEND_FAILED type=verify-email to=c@d.edu code=EAUTH responseCode=535 message="Invalid login: 535 5.7.8 Authentication failed"
2026-10-11T17:05:10.500000000Z Error: Invalid login: 535 5.7.8 Authentication failed
2026-10-11T17:08:00.000000000Z Email not configured, skipping send to: someone@example.com
2026-10-11T17:09:00.000000000Z Error: Not Found
2026-10-11T17:09:01.000000000Z LOGIN: Starting login for x@y.edu
LOG
EOS
cat > "$TMP/docker_clean" <<'EOS'
#!/bin/bash
echo "2026-10-11T16:20:03.123456789Z LOGIN: Success, resetting session"
echo "2026-10-11T16:21:00.000000000Z Error: Not Found"
EOS
chmod +x "$TMP/docker_failures" "$TMP/docker_clean"

run_section() {
  bash -c '
    export TZ=America/Chicago
    DOCKER="$1"; FLAGS=(); FIRST_LOGIN_CHECK=0; MAIL_FAIL_MAX=0
    LOGIN_SINCE_EPOCH=$(python3 -c "import time;print(int(time.time())-86400)")
    NOW_EPOCH=$(python3 -c "import time;print(int(time.time()))")
    date() { if [ "$1" = "-d" ]; then command date -r "${2#@}" 2>/dev/null || command date -d "$2"; else command date "$@"; fi; }
    source "$2"
    echo "FLAG_COUNT=${#FLAGS[@]}"
    for f in "${FLAGS[@]}"; do echo "FLAG: $f"; done
  ' _ "$1" "$TMP/section.sh"
}

FAILS=0
expect()     { if echo "$OUT" | grep -qF -- "$1"; then echo "ok   - $2"; else echo "FAIL - $2"; FAILS=$((FAILS+1)); fi; }
expect_not() { if echo "$OUT" | grep -qF -- "$1"; then echo "FAIL - $2"; FAILS=$((FAILS+1)); else echo "ok   - $2"; fi; }

OUT=$(run_section "$TMP/docker_failures")
expect     "FLAG: 3 mail send failure(s) since last check"  "counts 2 marker lines + 1 old-format header = 3"
expect     "type=password-reset to=a@b.edu"                 "prints a marker line's detail"
expect     "type=verify-email to=c@d.edu"                   "prints the second marker line"
expect     "1 send(s) skipped because email is not configured" "counts the not-configured skip"
expect     "FLAG_COUNT=2"                                    "raises both flags"
expect_not "Not Found"                                       "ignores unrelated Error: lines"
expect_not "Starting login"                                  "ignores unrelated log lines"

OUT=$(run_section "$TMP/docker_clean")
expect     "No mail send failures in this window."          "clean log reports none"
expect     "FLAG_COUNT=0"                                    "clean log raises no flags"

[ "$FAILS" -eq 0 ] && echo "ALL PASSED" || { echo "$FAILS CHECK(S) FAILED"; exit 1; }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash <monitoring_trinket_server repo>/tests/mail_section_test.sh`
Expected: `FAIL` on "counts 2 marker lines + 1 old-format header = 3" (the section currently counts only the 1 old-format header, so the flag says `1 mail send failure(s)`), plus the dependent "prints a marker line's detail" and "prints the second marker line" checks; exit code 1.

- [ ] **Step 3: Teach the section the marker**

In `trinket_scheduled_check.sh`, inside the `python3 -c '…'` body of the `MAIL SEND FAILURES` section, add this line immediately above `fail_re = re.compile(`:

```python
# New format, written by lib/util/mailer.js logFailure(): one MAIL_SEND_FAILED line per failure.
marker_re = re.compile(r"MAIL_SEND_FAILED ")
```

and replace

```python
    if fail_re.search(msg):
        fails.append((ts, msg[msg.index("Error: "):].strip()))
```

with

```python
    mm = marker_re.search(msg)
    if mm:
        fails.append((ts, msg[mm.start():].strip()))
        continue
    if fail_re.search(msg):
        fails.append((ts, msg[msg.index("Error: "):].strip()))
```

(The body is inside single quotes in bash, so do not introduce a single quote or apostrophe anywhere in the python, including comments.)

Then update the bash comment block above that section: replace the sentence beginning `The patterns below match the error header line that nodemailer/Node print for an unhandled send failure` through `...extend fail_re to match it.` with:

```bash
# Two formats are matched: (1) current Trinket logs one MAIL_SEND_FAILED line per
# failed send (lib/util/mailer.js logFailure); (2) older Trinket versions let a
# failed send escape as an unhandled rejection, whose nodemailer error header
# ("Error: Message failed: ...") fail_re matches. One event is counted per line;
# the stack-trace and "response:" lines under an old-format error are ignored.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash <monitoring_trinket_server repo>/tests/mail_section_test.sh`
Expected: every line `ok`, final line `ALL PASSED`, exit code 0.

- [ ] **Step 5: Update the reviewer context doc and lab notebook**

In `trinket_monitoring_context.md`, in the section "Mail-send failure flags are always real", add one sentence after the first paragraph: `Servers running a Trinket build that includes the MAIL_SEND_FAILED change (branch `fix/mail-send-errors`; name the merge commit here once merged) log each failure as a single MAIL_SEND_FAILED type=... to=... message="..." line (the type says which flow: password-reset, verify-email, confirm-email-change, session-alert, trinket-share); older versions show the raw nodemailer "Error: Message failed: ..." header instead. Both are matched.`

Add a new top entry to `lab_notebook.md` (newest first, real date from `date +%F`) recording: the Trinket-side change (branch `fix/mail-send-errors`, helpers `mailer.logFailure`/`sendSafe`, marker format), this script change, the new `tests/mail_section_test.sh`, and the open item "deploy in this order: copy the updated `trinket_scheduled_check.sh` to the server FIRST (it is backward compatible: it behaves identically against an old Trinket), then pull/restart Trinket".

- [ ] **Step 6: Commit (in the monitoring repo)**

```bash
git -C <monitoring_trinket_server repo> add trinket_scheduled_check.sh tests/mail_section_test.sh trinket_monitoring_context.md lab_notebook.md
git -C <monitoring_trinket_server repo> commit -m "feat(health-check): match Trinket's MAIL_SEND_FAILED log line

Trinket now logs failed sends as one MAIL_SEND_FAILED line instead of letting
them escape as unhandled rejections, so the raw nodemailer header the check
looked for no longer appears. Match the marker as well as the old format, and
add tests/mail_section_test.sh to exercise the section against canned logs.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (writing-plans checklist)

- **Spec coverage:** helpers (Task 1), `sendPassReset` + the two private email functions (Task 2), `ohnoes` incl. the empty-address skip (Task 3), share-by-email logging with unchanged response (Task 4), monitoring contract (Task 5), operator docs (Task 1 Step 5). Out-of-scope items are listed in the spec, not planned.
- **Placeholders:** none; every code step shows the code.
- **Type consistency:** `logFailure(err, ctx)` and `sendSafe(to, subject, options)` are identical everywhere they are used; the `type` strings (`password-reset`, `verify-email`, `confirm-email-change`, `session-alert`, `trinket-share`) match between code, tests and the Task 5 context-doc sentence.
- **Review Focus:** items 1-2 are Task 1 tests, 3 is Task 3's second test, 4 is Task 2's two "template-render failure" tests, 5 is Task 1's success-path test plus the existing suites run in Tasks 2 and 4.

## Post-implementation amendments

Changes made after the final whole-branch review, so the plan above is not the whole story:

- `lib/models/courseInvitation.js` was added to scope (it logged its own failures, but with no marker, so the health check could not see them): log with `type=course-invitation`, rethrow, keep the existing catch. Fix-wave Commit 1.
- `mailer.logFailure` was made total (it can no longer throw on an unstringifiable error) and `oneLine` now strips control characters. Fix-wave Commit 2.
- Docs corrected: what the marker covers (and does not: export notifications), the Node/pm2 claim, the spec's out-of-scope wording, the rollout order (health-check script first, then Trinket), and absolute paths replaced with placeholders. Fix-wave Commit 3 (this commit).
- Health-check amendments in the monitoring repo: a single-count regression guard in `tests/mail_section_test.sh`, a longer `MAIL_LAST`, flag wording, and accurate coverage notes. Fix-wave Commit 4.
