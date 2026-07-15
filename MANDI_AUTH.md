# Matter and Interactions (M&I) Auth Setup

This deployment of trinket is customized for the M&I community. The auth model
differs significantly from the upstream open-source build, so document what's
unusual here before reading the code.

## Two-tier signup gating

Anyone can hit `/login`, but creating a new Trinket account is gated by
`lib/util/instructorAuth.js isApprovedToSignup(email)`. It allows the signup if
any of the following is true:

1. **Admin email** — listed in `config.auth.adminEmails` (set via
   `ADMIN_EMAILS` env var → `NODE_CONFIG`). Bypasses everything else.
2. **Approved instructor** — present in the Datastore-backed roster in the
   external `instructormi` GCP project. That roster is managed through the
   M&I community's instructormi.org access-request flow, not from inside
   Trinket. Checked via cross-project Datastore read (uses ADC; skipped
   gracefully when credentials aren't available, e.g. on local dev).
3. **Pending course invitation** — has a `CourseInvitation` document in
   Firestore with `status` in `{pending, sent}` and matching `email`.
   This is how instructors grant access to students.

Everything else is rejected with the message at `lib/controllers/auth.js`
session handler ("not on a course roster, check the email your instructor
added you with"). There is no self-service signup.

## Student roster ≠ Firebase accounts

When an instructor pastes student emails into the course editor (or uploads a
CSV), the server creates `CourseInvitation` documents in Firestore — one per
email, with a token. **No Firebase Auth account is created at this step.**
Nothing is sent to Firebase Admin. Students don't exist as accounts until
they sign in themselves.

The invitation record serves two roles:
- gates signup approval (#3 above)
- triggers auto-enrollment in `lib/controllers/auth.js` session handler:
  the loop at "Auto-accept any pending invitations" finds every pending
  invitation for the new user's email and adds them to those courses as
  `course-student`.

When a student successfully signs in for the first time:
1. FirebaseUI (client side) creates the Firebase Auth account on submit.
2. Browser POSTs the resulting ID token to `/api/auth/session`.
3. Server verifies the token, runs `isApprovedToSignup`, creates the
   Trinket `User` document, then auto-enrolls them in every matching
   pending invitation.
4. An `acceptedCourseInvitation` flash is set so `/home` shows
   "You've joined <course>".

The Firebase Auth account and the Trinket `User` document are two separate
records, linked by `User.firebaseUid`. Deleting one does not delete the other.

## Email delivery is disabled

`config.app.mail` is not configured in `config/production-cloudrun.yaml`, so
`lib/util/mailer.js isConfigured()` returns false and `mailer.send()` silently
no-ops. This affects:

- Course invitations (`lib/models/courseInvitation.js sendInvitationEmail`)
- Password reset / email verification flows (largely dead code now that
  we're on Firebase Auth — kept in tree but unreachable)
- "Email this trinket" share feature

The course-invitation UI in `public/partials/course_editor.html` was
intentionally rewritten to stop pretending email is sent. There is no
"Resend Invitation" button; the dropdown only offers "Remove Student".
The instructor's only job is to add the email to the roster; the student
then signs in with that email and is auto-enrolled.

## Accept-link email-strictness

The legacy `/courses/accept/:token` route in `lib/controllers/classes.js
acceptInvitation` still exists, but it now requires the signed-in user's
email to match the invitation's email. This defends against a student
signing in with a personal email and then using a leaked/copied token
URL to bypass the roster. If you see this rejection in logs, the student
needs to sign in with the email the instructor rostered them under.

The accept URL is no longer surfaced anywhere in the UI — the
expandable-row that used to show it in the pending-students list was
removed. The route is kept only for backward compatibility with any old
URLs that might still exist somewhere.

## Project IDs and the Auth emulator

Production uses Firebase project `trinket-gcr-test` (see `config/local.yaml`
or whatever NODE_CONFIG injects). Local dev uses `demo-trinket`, the
Firebase-convention sandbox project ID that never touches real Firebase.

The Auth emulator complicates this because the emulator issues tokens
scoped to the project it was started with (`emulator.sh` uses
`--project demo-trinket`). If the browser config or admin SDK uses
`trinket-gcr-test` in emulator mode, `verifyIdToken` fails with
"incorrect aud claim". To handle this:

- `lib/util/firebase-admin.js` — when `FIREBASE_AUTH_EMULATOR_HOST` is
  set, the admin SDK is initialized with `GOOGLE_CLOUD_PROJECT` instead
  of `config.auth.firebase.projectId`.
- `lib/controllers/auth.js loginPage` — when `FIREBASE_AUTH_EMULATOR_URL`
  is set, the `firebaseConfig.projectId` sent to the browser is also
  overridden to `GOOGLE_CLOUD_PROJECT`.

So local-dev project IDs all collapse to `demo-trinket`; production paths
stay on `trinket-gcr-test`. The two env vars differ
(`FIREBASE_AUTH_EMULATOR_HOST=host.docker.internal:9099` vs
`FIREBASE_AUTH_EMULATOR_URL=http://localhost:9099`) because the container
and the browser reach the emulator from different network perspectives.

Run `./emulator.sh` (host) + `docker compose up -d` (container) for full
local auth. The Emulator UI at `http://localhost:4000` lets you inspect
and delete emulator users — useful for retesting the new-account flow
with the same email.

## Key files

| File | Role |
|---|---|
| `lib/controllers/auth.js` | `loginPage` (serves FirebaseUI page) and `session` (verifies ID token, gates signup, auto-enrolls). The center of the auth flow. |
| `lib/util/instructorAuth.js` | `isApprovedToSignup`, `isApprovedInstructor`, `isAdminEmail`. Encapsulates the M&I-specific gating rules. |
| `lib/util/firebase-admin.js` | Lazy admin SDK init. Project-ID override for emulator mode lives here. |
| `lib/views/login.html` | FirebaseUI bootstrap + emulator opt-in. |
| `lib/models/courseInvitation.js` | `addList` (CSV → invitation docs), `findByToken`, `sendInvitationEmail` (no-op without SMTP). |
| `lib/controllers/classes.js` | `acceptInvitation` (token-based join, email-strict), `joinFromLink` (access-code join, less strict). |
| `lib/controllers/course.js` | Instructor APIs for invitations (add list, resend, delete, update email). |
| `public/partials/course_editor.html` | Add Students textarea + CSV upload, Pending Students list. |
| `public/js/courseEditor/controllers/usersControl.js` | Angular controller for the above. |

## Things that are dead but still in the tree

- `lib/controllers/auth.js google` / `googleCallback` — legacy
  OAuth handlers superseded by FirebaseUI. Guarded so they 404 cleanly
  when `app.auth.google.clientID` is unset.
- Most of `lib/views/users/*.html` and the related controllers (password
  reset, email verification, email change) — Firebase Auth owns these
  flows now.
- `sendInvitationEmail` and `mailer` callers — kept callable but
  no-op without SMTP config.
- `course_editor.html` had a `toggleShowInvitation`/`acceptUrl`
  expandable row; the markup is gone but `usersControl.js` still
  defines the unused functions. Harmless.

These are kept rather than deleted because (a) upstream open-source
trinket still uses them and we may want to keep the diff minimal for
future merges, and (b) deleting them is its own multi-day cleanup that
isn't blocking anything.
