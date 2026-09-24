# Testing against a deployed server

How we test real deployments, and — more usefully — the decisions behind it,
because most of them were reached by getting something wrong first.

## The layers

| suite | signs in? | writes? | safe against |
|---|---|---|---|
| `test/browser/specs/` | yes (Firebase Auth **emulator**) | yes | a local `make gcp` stack only |
| `test/browser/specs-deploy/` | no | no | any deployment, including production |
| `specs-deploy/instructor-journey.spec.js` | yes | yes | **trials only**, opt-in via env |
| `specs-deploy/course-journey.spec.js` | yes | yes | **trials only**, opt-in via env |
| `specs-deploy/trinket-authoring.spec.js` | yes | yes | **trials only**, opt-in via env |
| `specs-deploy/student-loop.spec.js` | yes, **two accounts** | yes | **trials only**, opt-in via env |
| `specs-deploy/math-output-noop.spec.js` (#247) | no | no | any deployment, including production, via `playwright.noop.config.js` |

## Why authenticated deploy tests exist at all

Everything in `specs-deploy/` was anonymous by design — a good safety property
that turned out to hide things. Both production bugs found in one week lived on
authenticated paths and were invisible to the whole suite:

* `#176` — `/login` returned 500 for an **already signed-in** visitor.
* `#178` — the export status endpoint 500'd on a Firestore-shaped date.

`instructor-journey.spec.js` covers that gap: sign in, revisit `/login` while
signed in, build a course and assignment, export student work, poll to
completion, assert the download is offered.

## A 200 does not mean it worked

The single most important assertion in these specs is **not** `status === 200`.

This framework answers a schema rejection with **HTTP 200 and the errors in
`flash.validation`**. That is exactly how #204 shipped: Add Students returned
200, added nobody, and every status-only check agreed it was fine. Writing the
student-loop spec caught a second instance immediately — a feedback POST with an
empty `trinketId` was rejected the same silent way, and the spec's own
`expect(status).toBe(200)` sailed past it.

Use `assertOk(expect, res, what)` from `test/browser/deploy-auth.js`, which fails
on a validation or error flash as well as on a bad status. And where you can,
assert the OUTCOME rather than the response — the roster test re-reads the
invitation list and requires it to have grown, because that is the thing an
instructor actually cares about.

## Two identities, not one

`student-loop.spec.js` needs `SMOKE_STUDENT_EMAIL` / `SMOKE_STUDENT_PASSWORD`
alongside the instructor pair. Submitting as the course owner would exercise
none of the permission boundaries — the owner can do everything, so it proves
nothing about what a student can do. The student account also exercises #10:
an invitation does not enrol an existing user, their next sign-in does.

## Fixture policy: standing identity, ephemeral data

The two halves have very different costs.

**Identities are expensive.** Creating one needs the email marked verified (an
admin REST call) and then roster approval, because trials run
`requireApprovedAccount: true`. Doing that per run means handing the test runner
privileged Firebase credentials on every run. So: **one standing test account per
deploy**, created and approved once, credentials in the gitignored deploy `.env`
or Secret Manager — never in this repo.

**Data is cheap, and it is where drift comes from.** Courses, assignments and
submissions accumulate and quietly change what a test means. So: **created and
destroyed per run**, named from `test/browser/fixtures.js`.

**Tests must never depend on cleanup having worked.** Runs crash, time out and
get killed. Each run creates its own namespaced scope and asserts only within it;
`scripts/smoke-cleanup.js` sweeps what is left behind, deleting only names
matching the shared prefix and only past an age threshold, dry-run by default.
The convention lives in one file so the spec and the sweeper cannot drift apart.

## Signing in on a Firebase deploy, without a human and without weakening it

`save-session.js` (below) still works, but it is no longer the only way, and it
is no longer the preferred one: captured sessions expire, and capturing TWO of
them (needed for the student loop) means two manual browser sessions.

Instead, sign in through the **Email/Password provider** over the Identity
Toolkit REST API and exchange the ID token at `POST /api/auth/session`. This is
the same seam the local suite drives via the emulator. `deploy-auth.js`'s
`signIn()` picks it automatically: a password field on `/login` means form auth,
its absence means Firebase.

Nothing is dialled down to make this work, which matters — the temptation is to
relax the deploy instead:

* the server **never inspects which provider minted the token**
  (`lib/controllers/auth.js` → `verifyIdToken`, then email/uid), so an
  Email/Password token is exactly as good as a Google one;
* the provider was **already enabled** on `trinket-merge-test`;
* the `apiKey` is **public by design** — it ships in the login page;
* the `email_verified` gate that protects account linking
  (GHSA-w66h-rw9x-7h24) **still applies**. The test identities were marked
  verified once, administratively, via the Identity Toolkit admin API using a
  short-lived `gcloud` token — **not** a long-lived service-account key.

Do NOT extend this to uindy: it is Google-only by a decision documented to UIndy
IT, and mandi/production keep the no-test-identities rule regardless.

## Signing in without a human (captured sessions)

Firebase-driven deploys (gcr trial, mandi, uindy) have no login form to fill.
`test/browser/save-session.js` opens a headed Chrome, waits while you sign in —
Google included — and saves the session for reuse.

This works because the Firebase SDK's own state lives in **IndexedDB**, which
Playwright's `storageState` does not capture, but the server does not care: what
it trusts is trinket's `__session` cookie from `POST /api/auth/session`. Sessions
are server-side (`maxCookieSize: 0`), so the cookie is only a key and survives
deploys. Cookies *are* captured.

⚠️ A saved session file is a **live credential** for as long as the session
lasts. `.auth/` is gitignored. Capture production sessions only with an account
you would be comfortable leaking.

## Decisions, and why

**No test identities in production.** uindy enables *only* Google sign-in — a
deliberate choice, documented to UIndy IT. Automating there would mean either
re-enabling password sign-in for everyone, or holding a service-account key able
to mint a token for **any** user including real instructors. And uindy's
`requireApprovedAccount` + `restrictCourseCreation` mean a *useful* test account
must be instructor-equivalent, i.e. able to read and export real student work.
The credential's compromise would be a student-data exposure.

The argument that makes this affordable: everything after `verifyIdToken` is
provider-agnostic. Which provider issued the token changes Firebase's issuance
and the claims, not our session handling, roster checks, or course/export flows.
Automating on the **gcr trial** therefore exercises essentially all of our code.
What stays manual is Google sign-in itself — Firebase's responsibility — and
uindy's config, which is data rather than code.

**No auth emulator on a deployed trial.** Considered, rejected. Both the browser
and the server would need to reach it, so it would have to be publicly exposed —
and an internet-reachable auth emulator mints a token for *any* identity, against
a database shared with the gcr trial. It would also exercise the
emulator-trusting verification path, which production never uses. The emulator
remains right where it already is: the local stack.

**Production stays read-only.** `specs-deploy/` minus the journey spec is safe to
point anywhere. The journey spec is gated on credentials production does not
have, so pointing it at production in a hurry fails closed.

## Running them

```sh
cd test/browser

# anonymous, safe anywhere
TRINKET_BASE_URL=https://<host> npx playwright test -c playwright.deploy.config.js

# authenticated (trials only) — form auth
SMOKE_EMAIL=... SMOKE_PASSWORD=... TRINKET_BASE_URL=https://<host> \
  npx playwright test -c playwright.deploy.config.js specs-deploy/instructor-journey.spec.js

# authenticated — Firebase/Google, after capturing a session once
node save-session.js https://<host>
SMOKE_STORAGE_STATE=.auth/<host>.json TRINKET_BASE_URL=https://<host> \
  npx playwright test -c playwright.deploy.config.js

# sweep orphans (dry run without --yes)
node ../../scripts/smoke-cleanup.js --base-url https://<host> \
  --state test/browser/.auth/<host>.json --older-than 6
```

`EXPECT_COMMIT=<sha>` additionally asserts which build is live.

The #247 gate for `features.mathOutput` is two runs against one deploy, with the
flag flipped and the server restarted between them; the second run compares.
It uses its own config, because the deploy config's global setup refuses
production before any test runs:

```sh
# run once with mathOutput off and once with it on, in either order
TRINKET_CORPUS=<short codes on that deploy> TRINKET_BASE_URL=https://<host> \
  npx playwright test -c playwright.noop.config.js math-output-noop math-output
```

Without `TRINKET_CORPUS` it runs built-in program shapes instead, which proves
the no-op for programs like them, not for the trinkets stored on that deploy.
See the spec's header for what it asserts and what it refuses to compare.
