# Trinket bulk management — design

## Goal
Let a user select many trinkets at once — driven by filters — and **move them into/out of a folder** or **delete them** in one action. Today the trinket library offers only single-trinket drag-to-folder and single delete, so reorganizing a large collection means one trinket at a time. This is the pain behind the 2026-07-16 picup incident: a user with no bulk tools deleted his trinkets by hand to empty a course, which tripped a separate import bug and cost him the collection.

## Scope
**In:** multi-select on the trinket library, name/date/folder-scope filters to drive selection, bulk **move-to-folder** (incl. remove-to-root) and bulk **delete** (soft), a count-confirm before delete, one new batch endpoint.

**Out (each its own later spec):**
- **Tags** — no `tag` field exists on the trinket schema today; adding one is a data-model change with its own CRUD + UI. Deferred.
- **Courses** — the courses library is a much smaller surface (a handful per user) and already has client-side search/sort + a show/hide-archived section. Not part of this slice.
- **Trinket archive** — trinkets have no archive lifecycle; only *courses* archive. See "Soft-delete is latent archive" below — the recommended follow-on (trash/restore) delivers this without new semantics.
- **Undo toast** — a confirm dialog is the chosen safety mechanism; soft-delete is the recovery net. A visible restore path is the trash/restore follow-on, not this spec.

## Key facts (why the approach is contained)
- The list handler (`lib/controllers/trinket.js` `list`) already calls `Trinket.findByOwner(ownerId)` and does **all** filtering, sorting, and pagination **in JS in the app process** (a consequence of the Mongo/Firestore dual-backend abstraction — Firestore can't do nested `$exists`, etc.). Adding name/date filters is the same in-memory pass, not new query machinery.
- Because the server already loads the user's **full** collection per request, "select all matching the filter across all pages" is feasible without a new query path — the full filtered set is already computable server-side, and the client already receives it (paged).
- A trinket belongs to **at most one** folder, recorded on `trinket.folder = { folderId, name, folderSlug, ownerSlug }`. Folder membership rides on the trinket. Existing single-item ops are `folder.addTrinket(trinket, user)` / `folder.removeTrinket(trinketId)` plus the trinket's back-ref.
- Delete is a **soft delete**: `trinket.softDelete()` stamps `deletedAt`; the row and its `legacyShortCode` survive. (This is the same fact behind PR #53.)
- No bulk/batch endpoint exists today; folder moves and deletes are one-trinket-per-request.

## Architecture: one batch endpoint + selection state in the list controllers
No schema change, no new data model.

### New endpoint — `POST /api/trinkets/bulk`
Body:
```json
{ "action": "delete" | "move", "ids": ["<id>", ...], "folderId": "<id>" | null }
```
- `action: "delete"` → `softDelete()` each id.
- `action: "move"` → set each trinket's folder to `folderId`; `folderId: null` means **remove from folder** (move to root). Reuses `folder.addTrinket` / `removeTrinket` + the trinket back-ref, exactly as the single-item `addToFolder` / `removeFromFolder` handlers do.
- **Authorization is per id, server-side**: each trinket must be owned by `request.user`. An id the user doesn't own is never acted on — it goes to `failed`. The client's list is a request, not a grant.
- Returns:
```json
{ "ok": ["<id>", ...], "failed": [{ "id": "<id>", "reason": "not-owned" | "not-found" | "error" }] }
```

**Why a dedicated endpoint** rather than the client firing N calls to the existing single-item routes: one round trip instead of N, one authorization pass, one place to report partial success/failure, and the "N writes" cost (the `CLAUDE.md` Firestore per-write concern) is contained and visible in a single handler. N writes is the irreducible floor — moving 63 trinkets is 63 document updates either way — but this avoids N *round trips* on top of it.

**Explicit ids, not a re-resolved filter.** The client resolves the active filter to a concrete id list and sends those ids. The server does not re-run the filter. This guarantees the set the user saw and confirmed is exactly the set acted on (no time-of-check/time-of-use drift if the collection changes between preview and action).

### Selection state — `list-controller.js` and `folder-list-controller.js`
Both controllers gain selection state so bulk works at root **and** inside a folder. A checkbox per row; a header "Select all"; a bulk action bar shown when ≥1 is selected:
```
N selected  →  [Move to ▾]  [Delete]  [Cancel]
```
- **Move to ▾** — dropdown of the user's folders, plus a "Remove from folder" entry (→ `folderId: null`).
- **Delete** — opens the count-confirm dialog (below).
- **Cancel** — clears selection.

The existing single-trinket drag-to-folder is **kept** — a good affordance for one item. Bulk is additive.

## Selection scope, filters, and "Select all"
The base set is the **current view scope**; filters narrow within it; **Select all** takes the whole narrowed result (all matching, across pages — not just the visible 20).

**Scope:**
- **Inside a folder** → base set is that folder's trinkets. Fixed; no toggle. Select all = all matching *in this folder*.
- **At root** → a scope toggle, because root today shows only folderless trinkets (the existing `!t.folder` default):
  - **This folder (root)** — folderless trinkets only (current behavior).
  - **All my trinkets** — the entire collection, flattened across folders. Each row shows its folder so location is visible; this is the mode that makes "move everything from Fall 2024 into a folder" work regardless of where items currently sit.

**Filters** (combined with AND, resolved in the same in-JS pass the server already runs):
- **Name** — case-insensitive substring; the existing search directive, wired to also constrain the selectable set.
- **Folder scope** — the toggle above (root only) / implicit (in a folder).
- **Date** — **presets** over `lastUpdated`: Last 7 days / Last 30 days / This year / All time. Presets over a two-date picker because the real use is "the old stuff" or "this semester," one click. A custom range is a clean follow-on.

**Select all** surfaces the match count: "Select all 63 matching". The client holds those 63 ids and sends them to the batch endpoint.

## Delete safety
A **confirm dialog** naming the count, mirroring the existing course-delete confirmation pattern:
```
Delete 63 trinkets?
This removes them from your library.
                         [Cancel]  [Delete 63]
```
No type-to-confirm for trinkets (lighter than a whole course, and soft-delete makes it recoverable). Soft-delete is the recovery net; a user-facing restore path is the trash/restore follow-on.

## Error handling — partial failure is explicit
The batch endpoint returns `{ ok, failed }`.
- All succeed → clear the bulk bar, refresh the list.
- Some fail → message the split ("Moved 60, 3 couldn't be moved") and **leave the failed ids selected** so the user can retry or cancel. Never a silent partial success.

## Soft-delete is latent archive (the #1 follow-on, not this spec)
A soft-deleted trinket is functionally *archived* — the row persists with `deletedAt` set; the only missing pieces are a **view that lists deleted trinkets** and a **button that clears `deletedAt`**. That single follow-on — a trash/restore view — does triple duty:
1. the real safety net behind bulk delete,
2. the recovery path for incidents like the 2026-07-16 one (a button instead of a DB update), and
3. the trinket "archive" lifecycle originally asked for — **without inventing new semantics**, just surfacing state that already exists.

Recorded here so the framing isn't lost: "trinket archive" is not new work, it's exposing what soft-delete already stores.

## Testing
Following the PR #53 pattern (red→green on **both** backends — mongo default + the Firestore emulator profile, `TEST_DB_BACKEND=firestore`, recipe in `test/firestore-emulator.Dockerfile`):

**Batch endpoint API tests** (`test/lib/api/`):
- bulk delete soft-deletes exactly the given ids (others untouched; `deletedAt` set only on the targets);
- bulk move sets `folder` on each target; `folderId: null` clears it (move to root);
- an id owned by **another user** lands in `failed` with `not-owned` and is never modified (the auth gate — this is the security-critical case);
- a mixed valid/invalid/foreign id list returns the correct `ok`/`failed` split.

**Selection/scope logic** — unit tests where pure: filter-narrowing (name/date), and scope base-set resolution (in-folder vs root-only vs all).

**Frontend markup** — light static assertions as in PR #54 (menu/bar present, gated, wired to an element that exists). No Angular/DOM runtime harness exists in this repo, so the click/reveal wiring is a **manual pre-merge check**, stated in the plan.

## To pin down during planning
- The exact folder-set the "Move to ▾" dropdown reads from (reuse `libraryState.folders` already in both controllers).
- Whether `folder.addTrinket` + setting the trinket back-ref should be one shared helper for the batch path (keep the two writes in sync, as the single-item handler does).
- Cursor-pagination interaction: the client must gather all matching ids for "select all" even though the view is paged — resolve from the full set the server returns, or add a lightweight "ids only" list mode.
- Whether the batch handler should cap `ids` length (guard against a pathological request) and, if so, the limit + the message when exceeded.
- Exact permission check reused for per-id ownership (mirror the single-item `addToFolder` / `remove` handlers).
