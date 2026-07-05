# LTI Auth-Authority Split — design proposal

*Drafted 2026-07-05 (Claude + Steve, on the trial branch). Status: proposal —
phase 1 ready to implement; one policy decision open (see "The open
decision").*

## The problem

One knob (`config.lti.instructorAuthority`) drives one seam function
(`ltiInstructorAuthority.resolveInstructor`), which currently answers
**three different trust questions**:

1. **Registration authority** — who may connect a new LMS platform
   (`canInitiateLtiRegistration` gates `/lti/connect` and the token mint).
   Partially split already: it passes only `{ email }` (no `lmsTeacher`), so
   a bare trust-platform deploy fails closed for registration.
2. **Global `isInstructor`** — provisioned onto the user at LTI launch
   (site-wide powers: create courses, import, etc.).
3. **Course role at launch** — `course-admin` iff the LMS role claim says
   teacher *and* the authority agrees; otherwise `course-student`.

### The concrete bug-shaped consequence (uindy)

`ltiInstructorAuthority-default.js` checks `LTI_INSTRUCTOR_EMAILS` first:
when the list is set, it **replaces** trust-the-platform in
`resolveInstructor` — for launches too, not just registration. So a UIndy
teacher who isn't on the list, launching from Canvas with an Instructor role
claim, lands as `course-student`. The list was meant to gate who can
*register the platform*; it silently constrains launch roles as well.

## Proposed design

### Two knobs (old knob remains as the default for both — existing deploys
behave identically until they opt in)

```yaml
lti:
  registrationAuthority: admins | emailList | instructormi   # who may connect an LMS
  launchRoleAuthority:   platform | emailList | instructormi # how launch claims map to roles
```

### Two seam functions replacing resolveInstructor's double duty

- `resolveRegistrant({ email })` — reads `registrationAuthority`
- `resolveLaunchInstructor({ email, lmsTeacher })` — reads `launchRoleAuthority`

Call sites are exactly three lines: `lib/util/helpers.js`
(`canInitiateLtiRegistration`) and the two launch paths in
`lib/controllers/lti.js` (~lines 260 and 292).

### Per-deploy config (goes in the private deploy repos)

| Deploy | registrationAuthority | launchRoleAuthority | Change from today |
|---|---|---|---|
| mandi  | `instructormi` | `instructormi` | none |
| uindy  | `emailList` (or `admins`) | `platform` | teachers get instructor role from Canvas claims |
| oss default | `admins` | `platform` | registration tightens from fail-closed-unless-env to admins |

## The open decision: global vs. course-scoped instructor under `platform`

When `launchRoleAuthority: platform` trusts an LMS teacher claim, what does
the user get?

- **Global `isInstructor`** (today's semantics): site-wide course creation
  etc. Simpler; probably what a single-institution deploy like uindy
  expects — instructors launching from Canvas likely also want to create
  non-LTI courses.
- **Course-scoped only** (recommended conservative default): `course-admin`
  on the launched course, no global flag. Rationale: the LMS is
  authoritative about *its own course*, not about who gets site-wide powers
  on the deployment. Any Canvas admin at any connected institution being
  able to mint global instructors is a bigger grant than "trust the LMS"
  intends.

Could become a third knob later if both answers are wanted. **Ask Todd what
UIndy instructors expect before phase 1 lands, or default to course-scoped
(reversible) and revisit.**

## Phase 2: `course-ta`

Today `lib/util/ltiRoles.js` lumps `TeachingAssistant` into the teacher
regex (`/#(Instructor|TeachingAssistant|ContentDeveloper)$/`), so a TA gets
either full `course-admin` or nothing. Split the mapping:

- `Instructor` / `ContentDeveloper` → `course-admin`
- `TeachingAssistant` → new `course-ta` role: grading + review/feedback
  permissions, but no course-settings/roster powers.

Touches the roles/permissions system (grading endpoints, review UI access),
so it lands as its own change after phase 1.

## Practicalities

- **Where**: trial branch (`trial/picup-plus-prs`) — LTI lives there and the
  merge is imminent.
- **Testing**: seam-level unit tests over the knob matrix (pure functions,
  no app boot — same pattern as `checkShape` in startup-check). Pin the
  uindy scenario explicitly: platform-trusted teacher → `course-admin`,
  off-list teacher under `emailList` launch authority → `course-student`.
  There is currently **no LTI launch test coverage at all**, so this adds
  the first.
- **Size**: phase 1 ≈ one session. Phase 2 ≈ two, mostly in the permission
  checks around grading.
- **Back-compat**: with neither new knob set, both seam functions fall back
  to `instructorAuthority` semantics — no deploy changes required at merge
  time.

## Related

- `lib/util/ltiInstructorAuthority.js` (selector),
  `-default.js` (trust-platform / env list), `-instructormi.js` (Datastore).
- Design decision 3 (GCP all-or-none) in `GCR-PICUP-TRIAL-MERGE-NOTES.md` —
  same spirit: named supported shapes over knob soup.
- Memory: `project_lti_auth_requirements` (original backlog note).
