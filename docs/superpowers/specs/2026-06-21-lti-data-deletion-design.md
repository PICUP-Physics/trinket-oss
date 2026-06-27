# LTI Data Deletion / Retention — design

- **Date:** 2026-06-21
- **Status:** Approved (design); not yet implemented
- **Branch:** `lti-1.3`
- **Related:** `docs/compliance/ferpa-data-privacy-assessment.md` (the gap this closes),
  `lib/util/ltiProvision.js`, `lib/models/ltiUserIdentity.js`, `lib/models/user.js`,
  `lib/models/course.js`, `lib/models/trinket.js`, `lib/models/interaction.js`,
  `lib/models/ltiPlatform.js`

## Problem

Trinket acquires student PII through LTI launches (name, email, an opaque LMS `sub`, course role)
and persists it across **four locations** — `User`, `LtiUserIdentity`, the redundant
`Course.users[].email` on each membership, and the **IP `address`** on `Interaction` records —
plus the student's created content (`Trinket`s). FERPA designates the institution the data
controller and Trinket the processor under the "school official" exception; an institution can
require Trinket to **delete a student's (or all of its) records on request**. Trinket has no such
mechanism today. This is the #1 question an institutional InfoSec/privacy review asks, and the top
open gap in the FERPA assessment.

A complication: an LTI `User` is **shared** — `ltiProvision` links by email, so the same person
launching from two institutions (same email) is one `User` enrolled in many courses. So "delete a
student" cannot mean "nuke the `User`" without affecting another institution's records.

## Goal

Provide an **on-request, manual** deletion capability that satisfies FERPA "delete on request":
de-identify a student account-wide by default; hard-purge on institution offboarding; never
collaterally erase a still-active shared account; and leave an audit trail proving the deletion
happened — all portable to the oss mongo/redis backend.

## Decisions (locked)

1. **On-request, manual trigger** (not time-based expiry, not roster-sync). A person — a Trinket
   admin or ops via CLI — initiates it, typically in response to an institution's request.
   Time-based retention expiry is a later layer (out of scope).
2. **Anonymize by default; hard-delete for institution offboarding.** Per-student requests
   de-identify in place (FERPA-sufficient, preserves roster/gradebook integrity, no dangling
   references). A whole-institution offboarding (`purgeIssuer`) hard-purges.
3. **Keep content, de-identify it.** On anonymize, the student's `Trinket`s and `Interaction`s are
   kept but de-identified (owner repointed to a sentinel, IP scrubbed). The code text is generally
   not PII and the work may matter to the instructor; de-identification satisfies FERPA.
4. **Shared-`User` safety: delete the institution's footprint, keep the account when it's still
   active elsewhere.** Determined by an orphan check on remaining `LtiUserIdentity` links. A
   `User` is only purged/anonymized account-wide when it has no other institutional link.
5. **Audit without re-storing PII.** Every deletion writes a deletion-log entry (who/when/scope/
   counts) — never the deleted PII itself.
6. **v1 scope:** `anonymizeUser` + `purgeIssuer`, exposed via an admin affordance + a CLI.
   Instructor-initiated per-course scrub is deferred to v2.

## The operations

### `anonymizeUser(userId)` — the "delete this student on request" path

De-identifies a `User` account-wide and keeps de-identified content. Used when an institution asks
to delete a specific student. Because the account is the unit, this is the right, complete tool when
the student belongs to **one** institution (the overwhelming common case). For a genuinely shared
account, account-wide anonymize is unsafe (it would scrub the other institution's record too), so the
operation reports the conflict and defaults to the safe partial action — see Shared-User handling.

### `purgeIssuer(issuer)` — institution offboarding

Hard-purges an institution's footprint: deletes the `LtiPlatform(issuer)` and all
`LtiUserIdentity(iss=issuer)` links. For each `User` reachable through those links: if it has **no
other** `LtiUserIdentity`, hard-delete the `User` + its content (`Trinket`s, `Interaction`s) and
remove it from course rosters; if it is **still linked to another issuer**, only remove this
issuer's link (the account persists — it's the other institution's record).

## Components

### 1. `lib/util/ltiDeletion.js` (new — the portable service seam)

No Hapi/Firestore coupling; works through the model layer (portable). Functions:
- `anonymizeUser(userId, opts)` → `{ userId, action: 'account-wide'|'partial-link'|'conflict',
  scrubbed: {...counts}, sharedAccountKept: bool }`. `opts.requestingIssuer` identifies the
  institution making the request (the admin/CLI knows it — the request comes from an institution);
  `opts.force` overrides to account-wide. Branching: not-shared → account-wide; shared +
  `requestingIssuer` → partial (remove that issuer's link only); shared + no `requestingIssuer` +
  no `force` → `conflict` (no writes, the caller must supply an issuer or force).
- `purgeIssuer(issuer)` → `{ issuer, identitiesRemoved, usersPurged, usersUnlinked, platformDeleted }`.
- internal `accountIsShared(userId)` → true if `LtiUserIdentity.findByUserId(userId)` returns links
  spanning more than one issuer.
- internal `deIdentifyContent(userId)` → repoint `Trinket._owner` → sentinel; null `Interaction.address`.
- internal `writeDeletionLog(entry)` → append an audit record.

### 2. New model query methods (small additions)

- `LtiUserIdentity.findByUserId(userId, cb)` — the orphan check.
- `LtiUserIdentity.findByIssuer(iss, cb)` — offboarding enumeration.
- `Course.scrubMemberEmail(userId, cb)` (or extend membership handling) — null/scrub
  `users[].email` for a user across courses while keeping the membership entry (anonymize path);
  reuse existing `removeDeletedUser(userId)` (`$pull`) for the hard-purge path.
- `Trinket.repointOwner(fromUserId, toSentinelId, cb)` and `Interaction.scrubOwnerPII(userId, cb)`
  (or a bulk update over `findByOwner`) — content de-identification.

### 3. The "deleted user" sentinel

A single reserved `User` account (e.g. username `deleted-user`, no email/PII, flagged
`isSentinel`/`source:'system'`) that anonymized content repoints to, so `Trinket._owner` (a required
ref) stays valid without attributing work to a real person. Created once (idempotent, on first use
or via a seed step).

### 4. Audit log

A new `DeletionLog` record (or an append-only collection): `{ at, actor, operation
('anonymizeUser'|'purgeIssuer'), target (userId or issuer), counts, sharedAccountKept }`. **No
deleted PII.** This is the compliance evidence ("we honored the request on date Y").

### 5. Callers (thin, DRY over the service)

- **CLI** `scripts/delete-lti-data.js` — `--user <id>` (anonymize; optional
  `--requesting-issuer <iss>` for the shared-account partial, `--force` for account-wide) or
  `--issuer <iss>` (offboard), with a `--confirm` guard and a dry-run that prints what would change.
  The realistic trigger for an emailed institution request.
- **Admin affordance** — a control in the existing `/admin` area (gated by the unified
  `isAdmin`/`hasRole("admin")` role, per `docs/authority-model.md`): look up a user → "Anonymize",
  and an issuer → "Offboard", each behind a confirm. Both call the service functions.

## The cascade (field-level, account-wide anonymize path)

This is the **non-shared** account-wide anonymize. (The shared-account partial action below touches
only that institution's `LtiUserIdentity` link.)

| Location | Action |
| --- | --- |
| `User` | `email` → unique non-PII placeholder (`deleted+<hash>@…`), `fullname` → "Removed user", `avatar` → null; keep the row + id (referential integrity) |
| `LtiUserIdentity` | scrub `email`/`name` to null (keep the `iss`/`sub`→userId link, or delete it on offboarding) |
| `Course.users[].email` | scrub the redundant membership email for this user across courses |
| `Interaction.address` | null the IP address on the user's interaction records |
| `Trinket._owner` | repoint to the sentinel — content kept, no longer attributable |

(Hard-purge path: delete `User`, `LtiUserIdentity` link(s), `Trinket`s, `Interaction`s, and `$pull`
the user from course rosters.)

## Shared-`User` handling

`anonymizeUser` branches on `accountIsShared(userId)`:

- **Not shared** (one `LtiUserIdentity`, the common case) → full account-wide anonymize (the cascade
  above). Complete and correct.
- **Shared** (links span multiple issuers) → the **safe v1 default is the partial action**: remove
  **only the requesting issuer's** `LtiUserIdentity(iss, sub)` link (which holds that institution's
  stored `email`/`name`/`sub` for the student), and write the audit entry, leaving the shared `User`
  row, its content, and other institutions' memberships untouched. The admin is told plainly: "this
  account is also linked to issuer J; only issuer I's identity link was removed — the shared account
  persists because it is J's active record." Account-wide anonymize is still available but only on an
  explicit override confirm.

`purgeIssuer` always runs the per-user orphan check and unlinks-vs-purges accordingly. Together these
keep Trinket from erasing one institution's records on another's request.

> **Known v1 limitation (honest):** there is no precise *per-student, per-institution full scrub* for
> a shared account — because course memberships and content are **not tagged with the originating
> issuer**, Trinket cannot tell which of a shared student's courses/work belong to institution I.
> The partial action (remove I's identity link) is the most we can do safely without account-wide
> impact. Precise per-institution scrubbing would require issuer-tagging memberships/content — a
> deferred enhancement. In practice shared accounts are rare (same email across institutions), and
> the single-institution path is complete.

## Audit / evidence

Each operation writes one `DeletionLog` entry before returning. The log is retained (it's the proof)
and contains counts + scope but no personal data. Surface a simple admin view of recent deletions.

## Portability

`ltiDeletion.js` and the new model methods use only the model layer (Firestore in gcr, mongoose in
oss). No `@google-cloud/datastore`, no backend-specific calls. The sentinel + `DeletionLog` are
ordinary models. Works on both backends unchanged.

## Error handling

- Unknown `userId`/`issuer` → clear error, no log entry, no partial writes where avoidable.
- Partial-failure: operations should be resilient (continue scrubbing remaining locations, report
  per-location counts) so one failed sub-step doesn't leave the rest un-scrubbed; the log records
  actual counts. A re-run is safe (idempotent — already-scrubbed fields stay scrubbed).
- Sentinel creation races → idempotent get-or-create.

## Testing

In-container `scripts/test-lti-deletion.js` (gitignored) with fabricated data through the model
layer:
- anonymize single-institution user → PII gone in all four locations, content kept + repointed to
  sentinel + IP nulled, `DeletionLog` written, row/id preserved.
- anonymize shared user → partial action: requesting issuer's `LtiUserIdentity` link removed,
  shared `User` row + content + other issuer's link untouched, conflict reported, audit written;
  account-wide scrub only on explicit override.
- `purgeIssuer` → platform + identities deleted; orphan user purged (content gone, removed from
  rosters); shared user only unlinked (survives).
- idempotency: re-running anonymize is a no-op-ish (no error, no new PII).
- audit entry contains counts + scope, no PII.

## Out of scope (later)

- **Time-based retention expiry** (auto-purge after inactivity / course archival) — the v2 layer.
- **NRPS roster-sync** auto-deletion (needs Names-and-Roles, not built).
- **Instructor-initiated per-course scrub** (v2 — course-scoped UI + "which work belongs to this
  course" scoping).
- The DPA / HECVAT / VPAT / public privacy-policy artifacts — separate compliance track
  (`docs/compliance/`), not code.
