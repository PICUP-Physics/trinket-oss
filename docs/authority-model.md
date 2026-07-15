# Trinket authority model

A map of every distinct authorization signal in trinket and what it gates. Written because the word
"admin" means at least three different things here, and conflating them causes real bugs (e.g.
assuming an email in `config.auth.adminEmails` grants access to the `/admin` area — it does not, by
itself).

Read this before touching any auth gate.

## Site-level (global) authority

| Signal | Where it lives | What it gates |
| --- | --- | --- |
| **`hasRole("admin")`** | the `admin` role in the **user doc** (`context:"site"`) | the `/admin` area, the Admin nav link, impersonation, view-as-user |
| **`adminEmails` allowlist** | `config.auth.adminEmails` / env `ADMIN_EMAILS` | a **seed only** — see below. Not a per-request gate. |
| **approved-instructor list** | instructormi **Datastore** (gcr) / `LTI_INSTRUCTOR_EMAILS` (oss) | course creation, the LTI instructor-authority seam, signup approval |
| **`user.isInstructor`** | boolean flag on the user doc (stamped at signup / LTI launch) | `userCanCreateCourse` |
| **`user.approved`** | boolean flag on the user doc | `isApproved` — whether the user can edit/fork trinkets |
| **`hasRole("disabled")`** | `disabled` role in the user doc | *negative* — blocks the account |
| **`loggedInAs()`** | `_realUserId` on the session user | admin impersonation ("Login as") |

### adminEmails is a seed, not a gate

`adminEmails` used to be checked at many gates in parallel with `hasRole("admin")`, which is exactly
what made "admin" ambiguous. It no longer is. As of the site-admin unification
(`lib/util/siteAdmin.js`):

- At **login** (both the Firebase `session` path and Google OAuth), `ensureSeedAdminRole(user)`
  stamps the site `admin` role onto any user whose email is in the list, if they don't already have
  it (idempotent — one write per admin, ever).
- **Every post-login gate checks only `hasRole("admin")`.**
- The list is still consulted at exactly two points that pre-date a user's role:
  1. **signup approval** (`instructorAuth.isApprovedToSignup`) — runs before a user/role exists;
  2. the **login stamp** above.

Consequences to know:
- A newly-added admin email takes effect on that person's **next login**, not instantly.
- Removing an email from the list does **not** auto-revoke a stamped role — revoke explicitly
  (remove the role via `/admin`, or a script). For admin (rare, high-trust) this is acceptable.
- This is fully portable to oss/mongo+redis: `siteAdmin.js` has no GCP/Datastore dependency. The
  genuinely gcr-only signal is the **approved-instructor Datastore list**, isolated in
  `instructorAuth.js` + `ltiInstructorAuthority-instructormi.js`.

### isInstructor vs the approved-instructor list

Related but not the same: the **list** (instructormi Datastore, or the oss env list) is the source of
truth for "is this person an approved instructor"; **`user.isInstructor`** is a cached stamp written
onto the user doc at signup / LTI launch. Gates that run for logged-in users read the flag; signup and
the LTI authority seam consult the list.

## Course-level authority (per-course, `context: "course:<id>"`)

Defined in `lib/models/roles.js`:

| Role | Powers |
| --- | --- |
| `course-owner` | everything, incl. delete course + change owner |
| `course-admin` | manage access/content/assignments/submissions (no delete / owner-transfer). **An LTI Instructor launch maps to this.** |
| `course-collaborator` | manage + view content |
| `course-associate` | make a copy + view |
| `course-student` | view content only |

These are independent of site-level authority: a `course-admin` on someone else's course is **not** a
site admin, and a site admin is not automatically privileged inside an arbitrary course.

(There are also `folder-owner` and `trinket-connect*` roles; those are folder ownership and an
integration flag, not "admin".)

## The three "admins", side by side

1. **site `admin` role** (`hasRole("admin")`) — gates `/admin`. Seeded from `adminEmails` at login.
2. **`adminEmails` config list** — the seed for #1; not itself a gate anymore.
3. **`course-admin`** — a per-course role; nothing to do with the site.

When you write a new gate: decide whether you mean #1 (site) or #3 (course), and check the **role**.
Never reintroduce a parallel `adminEmails` check at a gate — that is the bug this document exists to
prevent.
