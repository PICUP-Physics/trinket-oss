# Library search: ranked results, a total, "See all", fewer reads (#344)

Status: design approved in conversation 2026-10-18; spec under review.
Issue: PICUP-Physics/trinket-oss#344. Base: `main` @ 8d20dc4.

## What we are solving

A user with a large library types in the library search box and gets at most 20 matches, in database order, with no count and no way to see the rest (#344). On the Firestore deploys, every search also reads *every* trinket the user owns.

**Success:**
- Results come in an order that can be explained: best matches first.
- The dropdown says how many matched and how many it shows.
- From the library, "See all" reaches every match (description matches included), paged.
- The other places that use the search box keep working.
- One-character terms never reach the database.
- Everything passes on both backends (Mongo and Firestore).

**Out of scope:**
- Searching inside code.
- The library list's own full-library read on every page and filter change (noted below as a follow-up).
- Any change to the existing Name filter's meaning.

## Where the search box is used

`<trinket-search>` (`public/partials/directives/trinket-search.{js,html}`) appears in four places:

| Page | File | On select |
|---|---|---|
| Library list | `public/js/library/trinkets/list/list.html:8` | go to the trinket |
| Folder view | `public/js/library/trinkets/list/folder.html:16` | add it to the folder |
| Assignment editor | `public/partials/assignment_editor.html:25` | add it to the assignment |
| Course-page editor toolbar | `public/partials/material.html:56` | insert it into the page |

The toolbar uses the directive's markup, but its *own* fetch in `public/js/courseEditor/controllers/toolbarControl.js:31-50`. That fetch reads `results.data.results`. The server answers `{ data: [...], flash, context }`, and no `$http` interceptor reshapes it (the app's interceptors are Restangular-only). So the toolbar search appears to always return an empty list today. **To verify in a browser before acting** (see §4).

## Design

### 1. One matcher: `lib/util/trinketSearch.js` (new)

Server-only, pure functions, no I/O:

- `normalize(term)`: trims and lower-cases. Returns `''` when the term has fewer than 2 characters.
- `matches(trinket, term)`: a case-insensitive substring match on `name` or `description`, the same rule as today.
- `rank(trinkets, term)`: returns the matches, ordered by:
  1. **group:**
     - (0) the name starts with the term;
     - (1) the name contains it elsewhere;
     - (2) only the description matches.
  2. **then** `lastUpdated` descending, so the most recently updated come first.
  3. **then** lower-cased `name` ascending, then `shortCode` ascending, so ties are deterministic.

  It accepts Firestore Timestamps, Dates and missing `lastUpdated`; a missing date sorts last.

Both the search endpoint and the list's `q` use this module, so they cannot drift apart.

### 2. `GET /api/trinkets/search?q=`

- **Response:** `{ data: [up to 20, ranked], total: <all matches>, limit: 20 }`. `data` items keep today's fields: `name`, `lang`, `shortCode`, `snapshot`. `total` and `limit` are added, and nothing is renamed or removed. The route has no reply spec, so the new fields reach the client.
- **Short terms:** a term shorter than 2 characters (after trimming) returns `{ data: [], total: 0, limit: 20 }` **without reading the database**. The Joi rule stays `Joi.string().required()`. The client normally won't send these (§3); this check is for any client that does.
- **Where it reads from:** `Trinket.model.find({ _owner, deletedAt: null })`, as today; then `trinketSearch.rank`. No cache (see "Why no cache").

### Why no cache

A per-user, in-memory search cache was designed and then dropped (2026-10-18), because usage doesn't justify it. Request logs for the 30 days to 2026-10-18:
- mandi had 42 search requests on 9 days;
- uindy had 18, almost all in one session.

At about 3,500 trinkets on mandi, even a worst-case read count costs a few cents a month on Firestore. On Mongo deploys, reads aren't billed at all. The 2-character minimum (§3) removes about a sixth of today's requests at no cost. The cache is listed under follow-ups in case usage grows.

### 3. The search box (`trinket-search` directive)

- **2-character minimum:** `typeahead-min-length="2"` on the input. The typeahead already waits 400 ms and discards stale responses, so **no request cancelling** is added; it would not save server reads.
- **Count footer:** when `total > data.length`, the dropdown ends with a footer row: *"Showing 20 of 143, best matches first"*.
  - It appears in all four places.
  - The directive's `searchTrinkets` keeps returning an array for the typeahead and stores `total` on the scope for the footer.
  - The trinkets API client (`trinket-service.js`, `customGETLIST("search")`) must make `total` available. If Restangular's list handling drops it, the directive switches to `customGET` and unwraps `data` itself.
- **"See all":** a new optional attribute `see-all="onSeeAll"`. Only the library list sets it. When the attribute is set and `total > data.length`, the footer adds a link: *"See all 143 results"*. Clicking it closes the dropdown and calls `onSeeAll(term)`.

**Library list (`list-controller.js`, `list.html`):**
- `onSeeAll(term)` sets:
  - `filters.q = term`;
  - `filters.scope = 'all'`, because search covers every folder;
  - `sortBy = 'relevance'`.
  
  Then it calls `reloadWithFilters()`.
- **Search chip:** while `filters.q` is set, the list shows a chip: *Search: "term" (name or instructions)* with a ✕. Clearing it removes `q`, restores the previous sort and scope, and reloads.
- `applyFilterParams` sends `q`, and `isFiltering()` counts it, so the empty-result message shows.
- **"Select all matching"** acts on the current params, including `q` when set. The user sees the chip, so what gets selected is explicit.
- **The relevance sort option** is offered only while `q` is set. The saved `library-sort-by` preference is **not** overwritten with `relevance`.

### 4. Course editor toolbar

Check first, on a trial, with a known trinket name.

- **If the insert-trinket search is empty today (expected):** fix `toolbarControl.searchTrinkets` to read `results.data.data`. Add a unit test that drives the parsing with a server-shaped response, written red first.
- **If it works:** change nothing; a test pins that the added `total` doesn't disturb it.

Either way, the toolbar gets the 2-character minimum, because it uses the same directive markup.

### 5. List endpoint: `GET /api/trinkets`

- **`q`:** after the existing scope, folder and date filters, keep only `trinketSearch.matches(t, q)`. It combines with `name`, which is still name-only (AND).
- **`sort=relevance`:** valid only with `q`; otherwise it falls back to the default sort. It orders with `trinketSearch.rank` and pages with **`offset` only**: `from` is ignored for this sort, since a cursor can't follow a relevance order. The client sends `offset` for this sort and not `from`.
- **Validation:** `q` and `sort` are added to the route's query keys. The validator already allows unknown keys (`Joi.object(schema).unknown(true)`, `routeParser.js`), so this is for documentation and type.
- **Unchanged:** the list still reads full documents through `Trinket.findByOwner`. Its reply spec still controls the fields returned.

## Testing (red first, both backends)

**Unit:**
- `test/unit/trinket-search-rank.test.js`:
  - each group in order;
  - recency within a group;
  - deterministic ties;
  - description-only matches included;
  - terms with regex-special characters (e.g. `a.b`, `(`) match literally;
  - Timestamp, Date and missing `lastUpdated`;
  - `normalize` returns `''` under 2 characters.

**API** (`test/lib/api/trinket_search.test.js`, through the real routes):
- 25 matches → 20 items, `total: 25`, in rank order.
- A 1-character `q` → empty result, and **no** `Trinket.model.find` call (spy).
- `GET /api/trinkets?q=…`:
  - includes a description-only match;
  - `sort=relevance` with `offset` pages without gaps or repeats;
  - `name=` alone behaves exactly as before.

**Static/markup:**
- The directive template has `typeahead-min-length="2"`, the footer and the `see-all` gate.
- `list.html` passes `see-all`; the other three usages do not.

**Browser** (Playwright deploy suite, on a trial):
- With more than 20 matching trinkets: the footer shows the count; "See all" lists every match, including a description-only one that wasn't in the first 20; clearing the chip returns to the normal list.
- The toolbar insert-trinket search returns the known trinket.

## Rollout

- **No migrations, no new config.**
- **Order:** trials first, both backends' unit runs green, then uindy → mandi. Andrew and Todd approve the PR.

## Follow-ups (not in this PR)

- The library list reads the whole library on every page and filter change. It could share a per-user index the same way, but it needs full documents (metrics, folder, assets), so that's a separate design.
- A per-user search index cache (60 s expiry, cleared by a Trinket post-save hook), if search use grows enough to matter. The design notes are in this spec's git history (commit 1175809).
