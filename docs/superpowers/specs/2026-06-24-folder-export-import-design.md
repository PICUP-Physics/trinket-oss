# Folder export/import round-trip — design

## Goal
Re-importing a user's bulk export restores their **folder organization**: each trinket lands back in the folder it came from. Folders are the only thing missing from today's round-trip.

## Key facts (why the approach is simple)
- A trinket belongs to **at most one** folder, recorded in `trinket.folder = { folderId, name, folderSlug, ownerSlug }` (kept in sync on create/move/rename).
- A `Folder` carries **no unique data beyond its `name`** (+ derived `slug`). `Folder.trinkets[]` only denormalizes trinket info we already export (its per-trinket `instructions` == `trinket.description`).
- Therefore folder membership rides on each trinket; no separate folder manifest is needed.

## Approach: per-trinket folder field (Approach A)
Record the folder on each trinket's `metadata.json`; reconstruct folders on import from those fields. (Rejected alternative: a separate `folders.json` manifest — more code, no payoff since folders hold no extra data.)

## Export — `lib/workers/exports.js` (→ upstream export PR #15)
- Add `folder` to the trinket stream `.select(...)`.
- In `addTrinketToArchive`, when `trinket.folder` is present, include in `metadata.json`:
  `folder: { name: trinket.folder.name, slug: trinket.folder.folderSlug }`
- Purely additive; omitted when the trinket has no folder. Mongoose-version-agnostic.

## Import — `lib/controllers/imports.js` (→ fork import PR #8)
- `readTrinketFromZip`: read `meta.folder` and carry it on the returned `data`.
- `importOneTrinket`: after the trinket is saved/updated, if `data.folder`:
  1. Resolve the target folder for the user (see replace semantics below).
  2. Add the trinket to it — update `Folder.trinkets[]` (`Folder.addTrinket(trinket, user)`) **and** set the trinket's `folder` back-ref (`{ folderId, name, folderSlug, ownerSlug }`), then save the trinket.

### Replace semantics (folders) — extends the existing `replace` checkbox
| `replace` | folder of that name exists | action |
|-----------|----------------------------|--------|
| checked   | yes | **reuse** the existing folder |
| checked   | no  | create it |
| unchecked | yes | **create a new folder** (suffix the name/slug on collision) |
| unchecked | no  | create it |

Matching is by folder **name** (scoped to the user). Mirrors trinket behavior: checked = merge into existing, unchecked = make fresh.

## Out of scope
- Course export/import folders (this is the **bulk** path only).
- Folders containing non-owned trinkets, or folders with no owned trinkets — bulk export only includes `Trinket.find({_owner})`, so only the user's own trinkets carry folder info.
- Folder-directory layout inside the archive (unnecessary; membership is per-trinket).

## To pin down during planning
- The exact Folder lookup API for "find this user's folder by name" (query vs. a model helper).
- The slug-collision/suffix mechanism for the unchecked → new-folder case (reuse the trinket-style "(2)" suffix or the slug plugin's uniqueness handling).
- Whether `Folder.addTrinket` + setting the trinket back-ref should be one helper to keep them in sync.

## Testing (on `test/import-export-minio`, Docker + MinIO)
1. Create 2 trinkets, put them in a folder; bulk export.
2. Import with **replace checked** → trinkets rejoin the existing folder, no duplicate folder.
3. Import into a clean account → folder is created and populated.
4. Import with **replace unchecked** where the folder exists → a new (suffixed) folder is created.
