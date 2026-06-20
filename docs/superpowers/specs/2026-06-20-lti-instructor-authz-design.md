# LTI instructor authorization — design

- **Date:** 2026-06-20
- **Status:** Approved (design); not yet implemented
- **Branch:** `lti-1.3`
- **Related:** `LTI-SPEC.md`, `lib/util/ltiRoles.js`, `lib/util/ltiProvision.js`,
  `lib/controllers/lti.js`, `lib/util/instructorAuth.js`, `lib/util/helpers.js`,
  `lib/models/user.js`

## Problem

trinket's LTI v1 maps the LMS `Instructor` role to `course-admin` **unconditionally**
(`ltiRoles.mapCourseRole`), and `ltiProvision` creates the user with no instructor check. So once an
institution's LMS is registered as a trusted `LtiPlatform`, **any** Instructor-role launcher from it
becomes `course-admin` of the linked course and can create/edit its content — bypassing trinket's
approved-instructor allowlist (`instructorAuth`, backed by the `instructormi` Datastore). The intent
is that **only approved instructors** get instructor powers.

## Goal

Make a launch grant `course-admin` only when the launcher is **both** asserted as an Instructor by
the LMS **and** an approved instructor (or admin) in trinket's records — re-evaluated on every
launch — while keeping the whole feature portable to the upstream mongo/redis (trinket-oss) backend,
where no allowlist exists.

## Decisions (locked)

1. `course-admin` requires **LMS Instructor role AND approved-instructor/admin**; otherwise
   `course-student`. A non-approved Instructor still gets a working (read-only) launch.
2. "Approved" matches the launch email against **either** `emailOfficial` **or** `emailSignin`
   (already how `instructorAuth.isApprovedInstructor` queries).
3. **Re-evaluate every launch** — upgrade (newly approved) and downgrade (revoked) the enrolment role.
4. **Approach A (mirror signup):** an approved instructor arriving via LTI becomes a *full* trinket
   instructor — i.e., LTI provisioning stamps global `user.isInstructor` exactly as Google signup
   does, so they can also create their own trinket courses. One definition of "instructor"
   regardless of entry path.
5. **oss default = trust-the-platform** (preserve upstream's current behavior; gating is opt-in via
   an env list).

## Design

### 1. The `instructorAuthority` seam

A standalone module beside `ltiVerify`/`ltiNonceStore` that depends on **nothing** in the storage
layer. One responsibility: judge whether a launcher should be treated as a trinket instructor.

```
authority.resolveInstructor({ email, lmsTeacher }) → Promise<boolean>
```

- **gcr impl** (`instructorAuthority.instructormi.js`): returns
  `isAdminEmail(email) || isApprovedInstructor(email)` via the existing `instructorAuth` module
  (the `instructormi` Datastore). Role-independent (gcr trusts its own list). **Only the gcr build
  loads this file**, so `@google-cloud/datastore` and the allowlist concept never enter the oss code
  path or its `node_modules`.
- **default impl** (`instructorAuthority.default.js`): returns `lmsTeacher` (trust-the-platform); or,
  if `LTI_INSTRUCTOR_EMAILS` is set, `list.includes(email.toLowerCase())`. No GCP dependency.
- **Selection:** a config key (`config.lti.instructorAuthority`, values `"instructormi" | "default"`),
  resolved once at load — same pattern as `db.backend`. Default value is `"default"`.

The role logic (`ltiRoles`, the launch controller) depends only on this abstract function — never on
`instructorAuth` or any backend. This is the seam that makes the feature drop cleanly onto mongo/redis.

### 2. Role resolution on launch

After the LMS roles claim is parsed in the launch flow:

```js
var lmsTeacher   = ltiRoles.isTeacherRole(roles);   // Instructor / TeachingAssistant / ContentDeveloper
var isInstructor = await authority.resolveInstructor({ email: email, lmsTeacher: lmsTeacher });
var courseRole   = (lmsTeacher && isInstructor) ? 'course-admin' : 'course-student';
```

`ltiRoles` is refactored from `mapCourseRole(roles) → role` to expose `isTeacherRole(roles) → bool`
(pure LMS-claim parsing); the intersection with `isInstructor` lives in the launch controller.

Resulting matrix:

| LMS role | approved (gcr listed / oss trusted) | global `isInstructor` | launched-course role |
|---|---|---|---|
| Instructor | yes | true | **course-admin** |
| Instructor | no | false | course-student |
| Learner | yes (gcr listed) | true | course-student |
| Learner | no | false | course-student |

Notes: a gcr approved instructor who launches as a **Learner** is still a global instructor (can
make their own courses) but is correctly a **student** in *that* course (because `lmsTeacher` is
false). A non-approved Instructor gets a working launch, just read-only.

### 3. Mirror-signup stamping + re-evaluate every launch

`ltiProvision` is extended so that **on every launch** it sets, on the resolved user:
- `user.approved = true` (the launch came from a trusted platform), and
- `user.isInstructor = isInstructor` (the resolver result) — the same fields `auth.js:86` stamps at
  Google signup.

The launch then makes the member's role equal to `courseRole`: on the **first** launch the user is
enrolled (`course.addUser(user, [courseRole])`); on **subsequent** launches the role is set with
`course.updateRole` to the freshly-recomputed value (rather than relying on `addUser`'s idempotent
"don't change existing role"). So a newly-approved teacher's next launch **upgrades** student→admin,
and a revoked instructor's next launch **downgrades** admin→student.

**Guardrail:** re-evaluation only touches the LTI-launched member's role. It never changes course
**ownership** and never downgrades the course **owner** — a launcher who happens to own the course
keeps owner rights regardless of list status.

### 4. Edge cases & error handling

- **No email asserted** (platform privacy not sharing email) → `resolveInstructor` can't match →
  `course-student`; log a one-line hint ("launch carried no email; instructor check skipped").
- **Authority lookup throws** (e.g. Datastore hiccup) → **fail closed** to `course-student` (never
  grant admin on error); logged. `instructorAuth` already swallows query errors and returns false,
  which is consistent with fail-closed.
- **Admins** (`ADMIN_EMAILS`) → `isInstructor` true via the gcr impl.
- The resolver is always called (even for Learners) so global `user.isInstructor` is correct for a
  listed person who launches as a student.

### 5. Testing

- **Resolver unit tests**, both impls — gcr (mock `instructorAuth`: admin / listed / unlisted);
  default (trust-platform true/false by `lmsTeacher`; `LTI_INSTRUCTOR_EMAILS` variant).
- **Role-matrix tests** — the four rows above, plus admin and the no-email / lookup-error paths;
  assert both `courseRole` and the stamped `isInstructor`.
- **Re-evaluation tests** — launch-as-student → approve → relaunch upgrades to admin; revoke →
  relaunch downgrades; course owner never downgraded.
- **Isolation test** — the default build never `require`s `instructorAuthority.instructormi.js` or
  `@google-cloud/datastore`.

Tests follow the existing in-container LTI test pattern (mock platform harness; run via
`docker exec trinket-gcr node …`).

## Portability summary (mongo/redis / trinket-oss)

Nothing in the role/authz logic touches Firestore or Datastore directly — it goes through the
`instructorAuthority` seam (gcr=`instructormi`, oss=`default`), exactly like `ltiVerify`/
`ltiNonceStore`. The gcr-only `@google-cloud/datastore` dependency is confined to the gcr impl file,
which oss never loads. Upstream forks get working LTI out of the box (trust-the-platform) and can
opt into gating with `LTI_INSTRUCTOR_EMAILS`.

## Out of scope (separate sub-project)

**Self-service / guided LMS registration for approved instructors** (let an approved instructor stand
up their own `LtiPlatform`, optionally via LTI Dynamic Registration). It builds on this authz layer
and shares the same allowlist, but is a distinct, larger piece of work — its own spec later.
