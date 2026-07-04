# Future Work

Items deferred during the GCR/Firestore migration. Not bugs, not urgent — things to revisit as the system matures.

---

## Firestore document accumulation

Trinkets are only soft-deleted (`deletedAt` timestamp). Hard-delete never runs in normal app flow, so:
- Soft-deleted trinket documents accumulate forever
- Old slug aliases (`snippets:{slug}:{userId}:ids` lists) accumulate in the Firestore slug store
- Course-import copies (each has a new shortCode + `_parent` ref) accumulate with no GC

### Admin scripts to build
- **Count soft-deleted trinkets** — query `deletedAt != null`, grouped by age bucket
- **Hard-delete old soft-deleted trinkets** — e.g. `deletedAt > 90 days`, also remove GCS snapshots
- **Count orphaned copies** — trinkets with `_parent` set whose owner has never viewed them
- **Firestore document count by collection** — rough cost indicator (reads billed per doc)
- **GCS bucket sizes** — `trinket-snapshots`, `trinket-materials`, `trinket-user-assets`

These would live in `scripts/admin/` and require service-account credentials or Cloud Run job context.

---

## GCS storage setup

The materials bucket and HMAC keys for serving user-uploaded assets are not yet created. See the 7-step checklist in project memory (`project_storage_setup.md`).

---

## Snapshot coverage

Snapshots are only taken on save for embed types that override `saveClientSnapshot` (glowscript, python, python3, pygame, glowscript-blocks). Trinkets created via import or copy start with the `avatar-default.png` fallback and only get a real snapshot the first time the owner saves them with visible output.

No action needed — just good to know when interpreting "My Trinkets" thumbnails.

---

## Content management UI: delete courses, trinkets, folders

There is currently NO UI for deleting a course — the endpoint exists (`DELETE /api/courses/{courseId}`, gated on the `delete-course` permission) but nothing in the Angular app or templates calls it, so course cleanup means the Firestore console. The broader gap is content-management affordances:

- **Delete course** — settings/dashboard button for owner + admin, confirm dialog, calls the existing endpoint. (The endpoint works as of the trial-branch `deleteOne` fix; on pre-fix backends it half-deletes — roles revoked, course doc left behind — so don't wire UI to it before that fix is deployed.)
- **Delete trinkets in bulk** — select-multiple in My Trinkets; today it's one-at-a-time.
- **Folder operations** — delete/move a whole folder of trinkets at once.

Destructive controls, so they deserve deliberate UX (confirmation, perhaps a soft-delete grace period per "Firestore document accumulation" above) and a picup design conversation — the upstream omission may have been caution rather than oversight.

---

## Import: replace vs. append on re-import

When an instructor imports trinkets or a course they've imported before, they need an explicit choice:
- **Replace** the earlier import (supersede the previous copy), or
- **Add to** past imports (keep both).

Today a re-import just creates fresh copies (new shortCode + `_parent` ref each time — see "Course-import copies accumulate with no GC" above), so a second import of the same course silently duplicates rather than updating. This is the migration path M&I instructors will hit repeatedly as they move courses off trinket.io and re-test, so the duplication compounds fast.

Needs: surface the choice in the import UI, and a way to identify a prior import of the "same" source (stable source id / origin shortCode) so replace can target it.

---

## Instructor-signup integration test (endpoint-level)

`instructorAuth.ensureInstructorFlag` (login-time refresh of `isInstructor`) is
covered by unit tests on the Vitest harness (`test/lib/util/instructorAuth.test.js`,
branch `test/instructor-flag`). Still wanted: an **endpoint-level** test that drives
the actual login routes (Firebase + Google-OAuth) through `server.inject` and asserts
`isInstructor` is stamped on login — including an existing account healing from
`false`. Needs mocking Firebase `verifyIdToken` (and the Google-OAuth profile) in the
harness. Deferred as moderate effort; the wiring mirrors the proven
`ensureSeedAdminRole` seam and is verified end-to-end by a prod re-login.
