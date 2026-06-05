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
