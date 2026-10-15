# Log failed email sends instead of leaving them as unhandled rejections

Status: implemented on `fix/mail-send-errors` (RED-first); final review: ready to merge with fixes (all applied). Plan: `docs/superpowers/plans/2026-10-11-mail-send-failure-logging.md`.

## Problem

Four controllers send email fire-and-forget and drop the promise `mailer.send()` returns:

| Site | Handler | What the user sees |
|---|---|---|
| `lib/controllers/users.js` | `sendPassReset` | "success", before the email is even rendered |
| `lib/controllers/users.js` | `send_email_confirmation` (via `resendEmailChange`; `sendEmailChange` also calls it but never reaches it, see out of scope) | "success" |
| `lib/controllers/users.js` | `send_email_verification` (via `sendEmailVerification`) | "success" |
| `lib/controllers/admin.js` | `ohnoes` (`POST /api/ohnoes`) | "success" |

When SMTP refuses the message (Mailgun sandbox `421`, bad login `535`, DNS or port failure) or, for `ohnoes`, when `config.app.adminEmail` is empty (the default) so nodemailer has no recipient, `send()` rejects and nothing handles it:

1. The failure is invisible. A self-hosted deployment ran for weeks with password reset silently broken (Mailgun sandbox, `421 … Free accounts are for test purposes only`); the only trace was an unhandled-rejection dump in `docker compose logs`.
2. An unhandled rejection is fatal under plain `node` (and in tests), whereas the production image runs `pm2-docker`, which is expected to log it instead of exiting (to be verified on the server with `docker compose exec trinket sh -c 'grep -n unhandledRejection $(npm root -g)/pm2/lib/ProcessContainer*.js'`); the failure is invisible either way. The repo installs no `unhandledRejection` handler.

`lib/controllers/trinket.js` (share by email) already has a `.catch`, but it logs nothing, so those failures are invisible too.

## Decision

Add two helpers to `lib/util/mailer.js` and use them at the call sites that drop the promise:

- `mailer.logFailure(err, ctx)` writes **one stable line**, `MAIL_SEND_FAILED type=<type> to=<address> code=<code> responseCode=<n> message="<text>"`, with the message collapsed to one line, quote-neutralised and capped. The fixed `MAIL_SEND_FAILED` marker is what monitoring greps for.
- `mailer.sendSafe(to, subject, options)` wraps `send()`; it **never rejects**, logs failures through `logFailure`, returns `send()`'s value on success and `{ failed: true, error }` on failure. It calls `module.exports.send`, so existing `vi.spyOn(mailer, 'send')` tests keep working.

Call sites:

- `sendPassReset`: render and send inside one `try/catch`; any failure is logged with `type=password-reset`.
- `send_email_confirmation` / `send_email_verification`: `sendSafe` inside the `.then`, plus a trailing `.catch` for render failures.
- `admin.ohnoes`: skip entirely when no admin address is configured; otherwise `sendSafe` with `type=session-alert`.
- `trinket.js` share: log with `type=trinket-share` and rethrow, so the existing `.catch` still decides the response.
- `courseInvitation.js` (added after the final review): log with `type=course-invitation` around `mailer.send`, then rethrow, keeping its existing final catch. It already caught and logged its own failures, but its line (`Failed to send course invitation email: ...`) carried no marker, so the health check could not see instructor invitations fail. A later `invitation.save()` failure is still not reported as a mail failure, and the old log line is still written.

## What does not change

User-visible responses are identical. The handlers still answer "success" before the email goes out; the only difference is that a failure is now logged on one greppable line and cannot become an unhandled rejection. `ohnoes` with no admin address configured now does nothing instead of attempting a send to `''`.

## Deliberately out of scope

- `workers/exports.js`: it propagates the rejection into the job's own failure handling, so export-ready and export-failed notification failures surface through the export job's failure handling, not through the `MAIL_SEND_FAILED` line.
- A process-wide `unhandledRejection` handler. Other, non-mail code can still reject unhandled; that is a separate decision.
- Telling the user their email failed. Changing what users see is a separate product decision.
- Found while planning: when the share-by-email send fails, the HTTP request **never completes** (its `.catch` calls the legacy `reply()` shim from inside a callback, after the handler has returned). Pre-existing and separate; this change leaves the response behaviour exactly as it was and pins it with a test.
- Retry or queueing of failed sends.
- Found during implementation (all pre-existing, none fixed here; each deserves its own issue):
  - `users.sendEmailChange` never answers and never sends. It calls `Store.set(key, val, callback)`, but `Store.set` takes two arguments and ignores the callback (`lib/util/store.js`), so the change-email request hangs and its `send_email_confirmation` call is unreachable. `resendEmailChange` is the only live path to that mail, so the test for that flow goes through it.
  - `admin.ohnoes` builds the alert text from `var msg;` without initialising it, so every alert starts with the literal word "undefined".
  - `sendPassReset` and `sendEmailVerification` `await Store.set/expire` outside any `try`; a Store failure there is still an unhandled rejection with no response sent. It is not a mail-send failure, so it is outside this change.

## Monitoring contract

The log line is the interface between this change and the deployment's health check (kept in a separate repo, `monitoring_trinket_server/trinket_scheduled_check.sh`). Its `MAIL SEND FAILURES` section currently matches the raw nodemailer error headers that an unhandled rejection prints (`Error: Message failed: …`). After this change those headers no longer appear, so the check must also match the `MAIL_SEND_FAILED` marker; the old patterns stay for servers still running an older Trinket. Do not rename the marker or reorder its `key=value` fields without updating that script. Roll out the updated health-check script BEFORE the Trinket change: the new script on an old Trinket behaves identically, whereas the new Trinket logs a marker the old script does not match.
