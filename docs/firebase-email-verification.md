# Firebase email verification + account-takeover fix

Addresses **GHSA-w66h-rw9x-7h24** (account takeover via unverified Firebase email
on session login) and adds the verification flow that makes email/password a
safe first-class signup path on Firebase-backed deploys.

## The vulnerability

`session()` in `lib/controllers/auth.js` verifies the Firebase ID token's
*signature* but never checks `decoded.email_verified` before using the email to
resolve an account. Firebase's email/password provider issues a valid token
immediately on signup, with `email_verified: false`. So an attacker can sign up
via the Firebase SDK using a victim's email, POST the token to
`/api/auth/session`, and the server matches the victim's existing account by
email and links the attacker's UID onto it (line 114) — full takeover. Google
tokens are always `email_verified: true`, so the vector is specifically the
email/password provider (confirmed enabled on mandi + the trials).

## Why local-auth and LTI are immune

- **Local/mongoose auth** verifies the *password* (bcrypt) on every login — the
  password is the identity proof, so no email claim is trusted for linking.
- **LTI** anchors identity on `(iss, sub)` from a *platform-signed* launch
  (`ltiProvision.provisionUser`), and email-linking is an explicit per-platform
  `trustEmail` flag. An attacker can't forge a launch, so nothing is
  self-asserted. Neither path needs this fix.

## Part A — The security gate (surgical)

In `session()`, after the `firebaseUid` lookup: if the UID isn't linked to any
account, resolving by email (fallback match / creation / linking) trusts the
email claim, so require verification first:

```js
var user = await User.findOne({ firebaseUid: uid });
if (!user) {
  if (decoded.email_verified !== true) {
    // do NOT fall back to email — return EMAIL_NOT_VERIFIED
  }
  user = await findByLogin(email);   // now safe
}
```

- Already-linked users (UID match) are never disrupted.
- Google users (always verified) sail through.
- Unverified email/password tokens can neither link to nor create an account.

The rejection returns a 403 carrying `code: 'EMAIL_NOT_VERIFIED'` so the client
shows a "check your inbox" state rather than a generic error. This gate sits
*before* `isApprovedToSignup`, so verification is consistent across all
Firebase provisioning paths (including roster instructors).

## Part B — The verification flow

1. **Send-on-signup** — `login-firebase.html` FirebaseUI
   `signInSuccessWithAuthResult`: on `isNewUser` + password provider +
   `!emailVerified`, call `user.sendEmailVerification()` (Firebase's built-in
   email/template/handler; custom branding is a later option).
2. **Graceful response** — the login page recognizes `EMAIL_NOT_VERIFIED` and
   shows "we emailed a link to <email>; click it, then sign in", with a
   **Resend** button (`sendEmailVerification()` on the still-present client
   Firebase user).
3. **Landing** — Firebase's default action handler verifies the email; the user
   returns and signs in → `email_verified: true` → session succeeds.

## Test harness note (important)

The firebase-auth Vitest profile (`flow.cjs firebaseIdToken`) currently mints
**unverified** tokens (`accounts:signUp` default) — so the gate would fail all
of them. Fixed by: after signUp, admin-set `emailVerified: true` via the
emulator (`accounts:update`, `Authorization: Bearer owner`) then
`signInWithPassword` for a fresh *verified* token. A separate
`firebaseIdTokenUnverified` helper mints an unverified token for the security
(prove-it) test.

## Rollout

Gate + flow ship together (the gate alone breaks new email/password signup).
Tested on both trials; **mandi held for explicit approval** (per Steve,
2026-07-09).
