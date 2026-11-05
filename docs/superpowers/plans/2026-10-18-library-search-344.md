# Library search (#344) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Library search returns ranked results with a total, the dropdown says "Showing 20 of N", and from the library "See all" opens every match in the paged list using the same matching rule.

**Architecture:** One pure server module (`lib/util/trinketSearch.js`) owns matching and ranking. Both `GET /api/trinkets/search` and the list's new `q` / `sort=relevance` use it. On the client, a small framework-free helper builds the dropdown rows (results plus a footer row), the `trinket-search` directive uses it, and a second helper holds the library list's enter/leave-search state so it can be unit-tested without Angular.

**Tech Stack:** Node 20, hapi (via the repo's shim), Mongo and Firestore backends, AngularJS 1.3 + Restangular, vitest (`globals: true`), Playwright deploy specs.

**Spec:** `docs/superpowers/specs/2026-10-18-library-search-344-design.md` (v2, no cache, commit da8959e).

## Global Constraints

- Work in worktree `~/Development/glow-repos/library-search`, branch `feat/344-library-search`, base `main` @ 8d20dc4. Don't push until Steve says so.
- Minimum search term: **2 characters after trimming**. Shorter terms return `{ data: [], total: 0, limit: 20 }` without reading the database.
- Search response: `{ data: [up to 20], total, limit: 20 }`. `data` items keep exactly `name`, `lang`, `shortCode`, `snapshot`.
- Ranking: group 0 = name starts with the term, 1 = name contains it elsewhere, 2 = description only; then `lastUpdated` descending (missing last); then lower-cased `name` ascending, then `shortCode` ascending.
- Matching is a case-insensitive **literal** substring on `name` or `description`.
- Footer copy: `Showing 20 of 143, best matches first`. See-all copy: `See all 143 results`. Chip copy: `Search: "term" (name or instructions)`.
- `sort=relevance` only applies with a usable `q`; it pages by `offset` only and ignores `from`.
- The saved `library-sort-by` preference must never become `relevance`.
- The existing `name` filter stays name-only and combines with `q` by AND.
- No cache, no migrations, no new config.
- Every bug fix and feature is red first: run the new test, see it fail for the right reason, then implement. **Both** unit legs (Mongo and Firestore) must pass before the branch is called done.
- Client modules follow the repo's UMD-lite pattern: `module.exports` for vitest and a `window` global for Angular, registered in `config/default.yaml`.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QNw6KLiif2r9zSoSQug4iL
  ```

## Running the tests

Set once per shell (create the empty overlay mask if it's missing):

```bash
SCRATCH=/private/tmp/claude-503/-Users-steve-Development-glow-repos/60525fd7-4663-40d2-a57a-a785c4a1f477/scratchpad
[ -f "$SCRATCH/empty.yaml" ] || printf '{}\n' > "$SCRATCH/empty.yaml"
```

**Mongo leg** (replace `<files>` with test paths, or omit for the full suite):

```bash
docker run --rm --platform linux/amd64 -v "$PWD":/app -v gcr-trial-nm:/app/node_modules \
  -v "$SCRATCH/empty.yaml":/app/config/local.yaml:ro -w /app \
  -e MONGOMS_DOWNLOAD_DIR=/app/node_modules/.mongo-binaries \
  node:20-bullseye bash -lc "npx vitest run <files>"
```

**Firestore leg:**

```bash
docker run --rm --platform linux/amd64 -v "$PWD":/app -v gcr-trial-nm:/app/node_modules \
  -v "$SCRATCH/empty.yaml":/app/config/local.yaml:ro -w /app trinket-test-firestore \
  bash -lc "java -jar /emulator/firestore.jar --host 127.0.0.1 --port 8089 & sleep 8; \
    TEST_DB_BACKEND=firestore FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 \
    npx vitest run --fileParallelism=false <files>"
```

Pure unit tests (`test/unit/*`) only need the Mongo-leg command.

## Review Focus

1. **Unnamed trinkets** (`name` null or missing) whose description matches: the server must not throw, they rank in group 2, and the dropdown shows "Untitled". Test: Task 1 (`rank` with `name: null`) and Task 2 (API).
2. **Terms that are only whitespace, or padded** (`"  "`, `"  pend "`): `"  "` is a short term (no read); `"  pend "` searches for `pend`. Test: Task 1 (`normalize`), Task 2 (API with `%20%20`).
3. **Deleted trinkets and other users' trinkets** never appear in search or in `q` results. Test: Task 2 (soft delete, then search; second user).
4. **`sort=relevance` without `q`, and unknown `sort` values**, return the default order instead of a 500. Today an unknown `sort` crashes on `sortMap[sort][0]`. Test: Task 3.
5. **A stale `from` sent with `sort=relevance`** (the client can carry one over from a previous sort) is ignored, and paging by `offset` still returns every match exactly once. Test: Task 3.

---

### Task 1: Matching and ranking module

**Files:**
- Create: `lib/util/trinketSearch.js`
- Test: `test/unit/trinket-search-rank.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalize(term: any) → string`: trimmed, lower-cased; `''` if fewer than 2 characters or not a string.
  - `matches(trinket: {name?, description?}, normTerm: string) → boolean`: `normTerm` must already be normalized.
  - `rank(trinkets: Array, normTerm: string) → Array`: a new array of only the matching trinkets, in rank order. Does not mutate its input.
  - `MIN_LENGTH = 2`, `LIMIT = 20`.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const s = require('../../lib/util/trinketSearch');

const d = (iso) => new Date(iso);
const ts = (iso) => ({ toDate: () => new Date(iso) });   // Firestore Timestamp shape

describe('trinketSearch.normalize', () => {
  it('trims and lower-cases', () => {
    expect(s.normalize('  Pend ')).toBe('pend');
  });
  it('returns "" for terms under 2 characters, blanks and non-strings', () => {
    expect(s.normalize('a')).toBe('');
    expect(s.normalize('  a  ')).toBe('');
    expect(s.normalize('   ')).toBe('');
    expect(s.normalize(undefined)).toBe('');
    expect(s.normalize(42)).toBe('');
  });
});

describe('trinketSearch.matches', () => {
  it('matches name or description, case-insensitively', () => {
    expect(s.matches({ name: 'Pendulum' }, 'pend')).toBe(true);
    expect(s.matches({ name: 'x', description: 'A PENDULUM lab' }, 'pend')).toBe(true);
    expect(s.matches({ name: 'Wave' }, 'pend')).toBe(false);
  });
  it('treats regex characters literally', () => {
    expect(s.matches({ name: 'a.b test' }, 'a.b')).toBe(true);
    expect(s.matches({ name: 'axb test' }, 'a.b')).toBe(false);
    expect(s.matches({ name: 'f(x) plot' }, 'f(')).toBe(true);
  });
  it('tolerates missing name and description', () => {
    expect(s.matches({}, 'pend')).toBe(false);
    expect(s.matches({ name: null, description: 'pendulum' }, 'pend')).toBe(true);
  });
});

describe('trinketSearch.rank', () => {
  it('orders by group: name prefix, then name contains, then description only', () => {
    const out = s.rank([
      { name: 'Lab notes', description: 'pendulum', shortCode: 'c' },
      { name: 'Big pendulum', shortCode: 'b' },
      { name: 'Pendulum', shortCode: 'a' },
      { name: 'Wave', shortCode: 'z' }
    ], 'pend');
    expect(out.map((t) => t.shortCode)).toEqual(['a', 'b', 'c']);
  });
  it('orders by lastUpdated descending within a group, missing dates last', () => {
    const out = s.rank([
      { name: 'Pend old', lastUpdated: d('2025-01-01'), shortCode: 'old' },
      { name: 'Pend none', shortCode: 'none' },
      { name: 'Pend new', lastUpdated: ts('2026-10-01'), shortCode: 'new' }
    ], 'pend');
    expect(out.map((t) => t.shortCode)).toEqual(['new', 'old', 'none']);
  });
  it('breaks ties by lower-cased name, then shortCode', () => {
    const same = d('2026-01-01');
    const out = s.rank([
      { name: 'pend B', lastUpdated: same, shortCode: '2' },
      { name: 'Pend a', lastUpdated: same, shortCode: '9' },
      { name: 'pend B', lastUpdated: same, shortCode: '1' }
    ], 'pend');
    expect(out.map((t) => t.shortCode)).toEqual(['9', '1', '2']);
  });
  it('ranks an unnamed description match in group 2 without throwing', () => {
    const out = s.rank([{ name: null, description: 'pendulum', shortCode: 'u' }, { name: 'Pendulum', shortCode: 'p' }], 'pend');
    expect(out.map((t) => t.shortCode)).toEqual(['p', 'u']);
  });
  it('does not mutate its input', () => {
    const input = [{ name: 'b pend', shortCode: 'b' }, { name: 'pend a', shortCode: 'a' }];
    s.rank(input, 'pend');
    expect(input.map((t) => t.shortCode)).toEqual(['b', 'a']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run the Mongo-leg command with `test/unit/trinket-search-rank.test.js`.
Expected: FAIL, `Cannot find module '../../lib/util/trinketSearch'`.

- [ ] **Step 3: Implement**

```js
'use strict';
// Library search matching and ranking (#344). Pure functions, no I/O: the
// search endpoint and the list's `q` filter both use this so they can't drift.

var MIN_LENGTH = 2;
var LIMIT      = 20;

function normalize(term) {
  if (typeof term !== 'string') return '';
  var t = term.trim().toLowerCase();
  return t.length < MIN_LENGTH ? '' : t;
}

function lower(v) {
  return typeof v === 'string' ? v.toLowerCase() : '';
}

function matches(trinket, normTerm) {
  if (!normTerm) return false;
  return lower(trinket.name).indexOf(normTerm) !== -1 ||
         lower(trinket.description).indexOf(normTerm) !== -1;
}

function group(trinket, normTerm) {
  var i = lower(trinket.name).indexOf(normTerm);
  if (i === 0) return 0;
  if (i > 0)   return 1;
  return 2;
}

// Firestore Timestamp, Date, string or missing → ms (missing sorts last).
function updatedMs(trinket) {
  var v = trinket.lastUpdated;
  if (!v) return -Infinity;
  var t = (typeof v.toDate === 'function') ? v.toDate().getTime() : new Date(v).getTime();
  return isNaN(t) ? -Infinity : t;
}

function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function rank(trinkets, normTerm) {
  return trinkets
    .filter(function(t) { return matches(t, normTerm); })
    .map(function(t) {
      return { t: t, g: group(t, normTerm), u: updatedMs(t), n: lower(t.name), s: String(t.shortCode || '') };
    })
    .sort(function(a, b) {
      return cmp(a.g, b.g) || cmp(b.u, a.u) || cmp(a.n, b.n) || cmp(a.s, b.s);
    })
    .map(function(x) { return x.t; });
}

module.exports = {
  MIN_LENGTH : MIN_LENGTH,
  LIMIT      : LIMIT,
  normalize  : normalize,
  matches    : matches,
  rank       : rank
};
```

(`cmp(b.u, a.u)` with two `-Infinity` values returns 0, so missing dates tie and fall through to the name.)

- [ ] **Step 4: Run it and watch it pass**

Same command. Expected: all tests in the file PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/util/trinketSearch.js test/unit/trinket-search-rank.test.js
git commit -m "feat(#344): trinketSearch matching and ranking module"
```

---

### Task 2: Search endpoint returns ranked results and a total

**Files:**
- Modify: `lib/models/trinket.js:326-339` (`searchForOwner`)
- Modify: `lib/controllers/trinket.js:1299-1309` (`search`)
- Test: `test/lib/api/trinket-search.test.js` (new)

**Interfaces:**
- Consumes: `trinketSearch.normalize`, `trinketSearch.rank`, `trinketSearch.LIMIT` (Task 1).
- Produces: `Trinket.searchForOwner(user, term) → Promise<{ data: Array<{name, lang, shortCode, snapshot}>, total: number, limit: 20 }>`. With a short term it resolves without calling `this.model.find`.
  - `GET /api/trinkets/search?q=` responds `{ data, total, limit, flash, context }` (the route has no reply spec, so `total` and `limit` reach the client).

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const flow = require('../../helpers/flow.cjs');
const Trinket = require('../../../lib/models/trinket');
beforeEach(() => { flow.cookies = {}; });
afterEach(() => { vi.restoreAllMocks(); });

async function make(name, description) {
  await flow.createTrinket();
  const id = flow.lastResponse.body.data.id;
  await flow.put('/api/trinkets/' + id + '/name', { name });
  if (description) await flow.put('/api/trinkets/' + id + '/description', { description });
  return id;
}

describe('GET /api/trinkets/search', () => {
  it('returns at most 20, ranked, with the total of all matches', async () => {
    await flow.switchUser('user');
    const tag = 'zq' + Date.now().toString(36);
    for (let i = 0; i < 24; i++) await make('Other ' + tag + ' ' + i);
    await make(tag + ' prefix');
    await make('Notes', 'about ' + tag);

    await flow.get('/api/trinkets/search?q=' + tag);
    const body = flow.lastResponse.body;
    expect(body.total).toBe(26);
    expect(body.limit).toBe(20);
    expect(body.data).toHaveLength(20);
    expect(body.data[0].name).toBe(tag + ' prefix');
    expect(Object.keys(body.data[0]).sort()).toEqual(['lang', 'name', 'shortCode', 'snapshot']);
  });

  it('includes description-only matches after name matches', async () => {
    await flow.switchUser('user');
    const tag = 'zd' + Date.now().toString(36);
    await make('Notes', 'see ' + tag);
    await make('A ' + tag + ' lab');

    await flow.get('/api/trinkets/search?q=' + tag);
    expect(flow.lastResponse.body.data.map((t) => t.name)).toEqual(['A ' + tag + ' lab', 'Notes']);
  });

  it('answers a short or blank term with an empty result and no database read', async () => {
    await flow.switchUser('user');
    const find = vi.spyOn(Trinket.model, 'find');

    await flow.get('/api/trinkets/search?q=p');
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(flow.lastResponse.body.data).toEqual([]);
    expect(flow.lastResponse.body.total).toBe(0);

    await flow.get('/api/trinkets/search?q=%20%20');
    expect(flow.lastResponse.body.total).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });

  it('trims a padded term', async () => {
    await flow.switchUser('user');
    const tag = 'zp' + Date.now().toString(36);
    await make(tag + ' padded');
    await flow.get('/api/trinkets/search?q=%20%20' + tag + '%20');
    expect(flow.lastResponse.body.total).toBe(1);
  });

  it('never returns deleted trinkets or another user\'s trinkets', async () => {
    await flow.switchUser('user');
    const tag = 'zx' + Date.now().toString(36);
    const gone = await make(tag + ' deleted');
    await flow.post('/api/trinkets/bulk', { action: 'delete', ids: [gone] });

    await flow.switchUser('user2');
    await make(tag + ' theirs');

    await flow.switchUser('user');
    await flow.get('/api/trinkets/search?q=' + tag);
    expect(flow.lastResponse.body.total).toBe(0);
  });
});
```

If `vi.spyOn(Trinket.model, 'find')` fails on one backend because `model` isn't exposed on the public model, spy on `Trinket.findByOwner`'s underlying call instead: read `lib/models/trinket.js:679-741` to find what `this.model` refers to, and spy on that object. The assertion (no read on a short term) must not change.

- [ ] **Step 2: Run it and watch it fail**

Run both legs with `test/lib/api/trinket-search.test.js`.
Expected: the first test FAILS (`body.total` is `undefined`); the short-term test FAILS (`find` was called, or a 1-character term returned matches).

- [ ] **Step 3: Implement**

In `lib/models/trinket.js`, add near the other requires at the top:

```js
    trinketSearch = require('../util/trinketSearch'),
```

(match the surrounding `var a = …, b = …` comma style), and replace `searchForOwner`:

```js
function searchForOwner(user, term) {
  var q = trinketSearch.normalize(term);
  var limit = trinketSearch.LIMIT;
  if (!q) {
    return Promise.resolve({ data: [], total: 0, limit: limit });
  }
  // Firestore can't do substring queries — fetch the owner's trinkets and rank in memory.
  return this.model.find({ _owner: user.id, deletedAt: null }).then(function(trinkets) {
    var ranked = trinketSearch.rank(trinkets, q);
    return {
      data: ranked.slice(0, limit).map(function(t) {
        return { name: t.name, lang: t.lang, shortCode: t.shortCode, snapshot: t.snapshot };
      }),
      total: ranked.length,
      limit: limit
    };
  });
}
```

If `escStrRegexp` has no other user in the file after this change, remove its `require` line too (`grep -n escStrRegexp lib/models/trinket.js`).

In `lib/controllers/trinket.js`, replace the `search` handler body:

```js
  search : function(request, reply) {
    return Trinket.searchForOwner(request.user, request.query.q)
      .then(function(result) {
        return request.success({
          data  : result.data,
          total : result.total,
          limit : result.limit
        });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
```

- [ ] **Step 4: Run it and watch it pass**

Both legs, same file. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/models/trinket.js lib/controllers/trinket.js test/lib/api/trinket-search.test.js
git commit -m "feat(#344): ranked search results with a total; no read for short terms"
```

---

### Task 3: List endpoint `q` filter and `sort=relevance`

**Files:**
- Modify: `lib/controllers/trinket.js:150-295` (`list`)
- Modify: `config/api_routes.js:914-925` (list route query keys)
- Test: `test/lib/api/trinket-list-filter.test.js` (append)

**Interfaces:**
- Consumes: `trinketSearch.normalize`, `trinketSearch.matches`, `trinketSearch.rank` (Task 1).
- Produces: `GET /api/trinkets?q=<term>&sort=relevance&offset=<n>&limit=<n>`. `q` combines with `scope`, `folder`, `name` and the date filters. Unknown `sort`, or `relevance` without a usable `q`, falls back to `-lastView.viewedOn`.

- [ ] **Step 1: Write the failing tests** (append inside the existing file, below the current `describe`)

```js
describe('GET /api/trinkets q + relevance', () => {
  async function makeD(name, description) {
    const id = await make(name);
    if (description) await flow.put('/api/trinkets/' + id + '/description', { description });
    return id;
  }

  it('q matches name or description', async () => {
    await flow.switchUser('user');
    const tag = 'lq' + Date.now().toString(36);
    await makeD('Notes ' + Date.now(), 'about ' + tag);
    await makeD(tag + ' lab');
    await makeD('Unrelated');

    await flow.get('/api/trinkets?scope=all&q=' + tag);
    expect(flow.lastResponse.body.data).toHaveLength(2);
  });

  it('q and name combine by AND; name stays name-only', async () => {
    await flow.switchUser('user');
    const tag = 'la' + Date.now().toString(36);
    await makeD('Pendulum', 'about ' + tag);
    await makeD('Wave', 'about ' + tag);

    await flow.get('/api/trinkets?scope=all&q=' + tag + '&name=pend');
    expect(flow.lastResponse.body.data.map((t) => t.name)).toEqual(['Pendulum']);

    await flow.get('/api/trinkets?scope=all&name=' + tag);   // description isn't searched by name=
    expect(flow.lastResponse.body.data).toHaveLength(0);
  });

  it('sort=relevance pages by offset with no gaps or repeats, ignoring a stale from', async () => {
    await flow.switchUser('user');
    const tag = 'lr' + Date.now().toString(36);
    for (let i = 0; i < 7; i++) await makeD('X ' + tag + ' ' + i);
    await makeD(tag + ' first');

    const seen = [];
    for (let offset = 0; offset < 8; offset += 3) {
      await flow.get('/api/trinkets?scope=all&q=' + tag + '&sort=relevance&limit=3&offset=' + offset + '&from=zzz');
      expect(flow.lastResponse.statusCode).toBe(200);
      seen.push(...flow.lastResponse.body.data.map((t) => String(t.id)));
      if (offset === 0) expect(flow.lastResponse.body.data[0].name).toBe(tag + ' first');
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it('relevance without q, and an unknown sort, fall back instead of failing', async () => {
    await flow.switchUser('user');
    await makeD('Fallback ' + Date.now());

    await flow.get('/api/trinkets?scope=all&sort=relevance');
    expect(flow.lastResponse.statusCode).toBe(200);
    await flow.get('/api/trinkets?scope=all&sort=bogus');
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(flow.lastResponse.body.data.length).toBeGreaterThan(0);
  });

  it('a 1-character q is ignored (the list is not narrowed)', async () => {
    await flow.switchUser('user');
    const tag = 'l1' + Date.now().toString(36);
    await makeD(tag + ' alpha');
    await makeD(tag + ' beta');
    // The Firestore emulator is shared across files, so scope by a unique name.
    await flow.get('/api/trinkets?scope=all&name=' + tag + '&q=a');
    expect(flow.lastResponse.body.data).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Both legs with `test/lib/api/trinket-list-filter.test.js`.
Expected: the `q` tests FAIL (unfiltered lists); the fallback test FAILS with a 500 on `sort=bogus` (and on `sort=relevance`).

- [ ] **Step 3: Implement**

In `lib/controllers/trinket.js` add to the top requires (same comma style):

```js
    trinketSearch = require('../util/trinketSearch'),
```

In `list`, right after `sortMap` is declared, replace the first line's effect with a validated sort:

```js
    var q = trinketSearch.normalize(request.query.q);
    var relevance = request.query.sort === 'relevance' && !!q;
    if (!relevance && !sortMap[sort]) {
      sort = '-lastView.viewedOn';
    }
```

After the name-substring filter block, add:

```js
        // Search (#344): name OR description, same rule as /api/trinkets/search.
        if (q) {
          trinkets = trinkets.filter(function(t) { return trinketSearch.matches(t, q); });
        }
```

Replace the `// Sort` block and the `// Cursor pagination (from)` block with:

```js
        if (relevance) {
          // Offset-only paging: a value cursor can't follow a relevance order.
          trinkets = trinketSearch.rank(trinkets, q);
        } else {
          // Sort
          var sortKey = sortMap[sort][0];
          var sortDir = sortMap[sort][1];
          trinkets.sort(function(a, b) {
            if (a[sortKey] < b[sortKey]) return -sortDir;
            if (a[sortKey] > b[sortKey]) return sortDir;
            return 0;
          });

          // Cursor pagination (from)
          if (request.query.from) {
            /* … the existing from-filter body, unchanged … */
          }
        }
```

Move the existing `from` block into the `else` exactly as it is (don't retype it; cut and paste).

In `config/api_routes.js`, list route `validate.query`, add:

```js
          q      : Joi.string().allow('').optional(),
```

(`sort` is already there as `Joi.string().optional()`, which accepts `relevance`.)

- [ ] **Step 4: Run them and watch them pass**

Both legs, `test/lib/api/trinket-list-filter.test.js` and `test/lib/api/trinket.test.js` (the existing list tests must still pass). Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/controllers/trinket.js config/api_routes.js test/lib/api/trinket-list-filter.test.js
git commit -m "feat(#344): list q filter and offset-paged relevance sort; unknown sort falls back"
```

---

### Task 4: Search box: 2-character minimum, count footer, optional "See all"

**Files:**
- Create: `public/partials/directives/trinket-search-results.js`
- Modify: `public/js/library/components/trinkets/trinket-service.js:3,58` (inject `$http`; `search` returns the whole body)
- Modify: `public/partials/directives/trinket-search.js`
- Modify: `public/partials/directives/trinket-search.html`
- Modify: `config/default.yaml:347` and `:389` (register the helper before `trinket-search.js` in both bundles)
- Test: `test/unit/trinket-search-results.test.js` (new)

**Interfaces:**
- Consumes: the Task 2 response `{ data, total, limit }`.
- Produces:
  - `trinketSearchResults.rows(body, opts) → Array`. `body` = `{ data, total }`; `opts.seeAll` = boolean. Returns the result items (each with `name` defaulted to `'Untitled'`), plus, when `total > data.length`, one footer item `{ __footer: true, text: 'Showing 20 of 143, best matches first', seeAllText: 'See all 143 results' | null }`.
  - `trinketsApi.search(q) → Promise<{ data, total, limit }>`.
  - Directive attribute `see-all="onSeeAll"`: a function `(term: string) → void` on the parent scope. When absent, the footer has no link and selecting it does nothing.

Why a footer *row*: the typeahead's popup is absolutely positioned under the input, so markup placed after the input would sit underneath it. A last item rendered differently by the match template is the only place guaranteed to show inside the dropdown.

Why `$http` and not `customGETLIST`: every app's Restangular response interceptor returns `response.data` (`public/js/library/app.js:26`, `courseEditor/app.js:29`), which throws `total` away.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const fs = require('fs');
const path = require('path');
const r = require('../../public/partials/directives/trinket-search-results.js');

const items = (n) => Array.from({ length: n }, (_, i) => ({ name: 'T' + i, shortCode: 's' + i }));

describe('trinketSearchResults.rows', () => {
  it('returns just the items when everything is shown', () => {
    const out = r.rows({ data: items(3), total: 3 }, { seeAll: true });
    expect(out).toHaveLength(3);
    expect(out.some((x) => x.__footer)).toBe(false);
  });
  it('adds a footer with the count when there are more matches', () => {
    const out = r.rows({ data: items(20), total: 143 }, {});
    expect(out).toHaveLength(21);
    expect(out[20]).toEqual({ __footer: true, text: 'Showing 20 of 143, best matches first', seeAllText: null });
  });
  it('adds the See-all text only when asked', () => {
    const out = r.rows({ data: items(20), total: 143 }, { seeAll: true });
    expect(out[20].seeAllText).toBe('See all 143 results');
  });
  it('names unnamed trinkets Untitled', () => {
    expect(r.rows({ data: [{ name: '' }, { name: null }], total: 2 }, {}).map((x) => x.name)).toEqual(['Untitled', 'Untitled']);
  });
  it('tolerates a missing body or total', () => {
    expect(r.rows(undefined, {})).toEqual([]);
    expect(r.rows({ data: items(2) }, {})).toHaveLength(2);
  });
});

describe('trinket-search markup', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

  it('waits for 2 characters and renders a footer row', () => {
    const html = read('public/partials/directives/trinket-search.html');
    expect(html).toContain('typeahead-min-length="2"');
    expect(html).toContain('match.model.__footer');
    expect(html).toContain('match.model.seeAllText');
  });
  it('the helper is loaded before the directive in every bundle that has it', () => {
    const yaml = read('config/default.yaml');
    const lines = yaml.split('\n');
    lines.forEach((line, i) => {
      if (line.includes("'/partials/directives/trinket-search.js'")) {
        expect(lines[i - 1]).toContain("'/partials/directives/trinket-search-results.js'");
      }
    });
  });
  it('the API client keeps total (does not use customGETLIST for search)', () => {
    const svc = read('public/js/library/components/trinkets/trinket-service.js');
    expect(svc).not.toContain('customGETLIST("search"');
    expect(svc).toContain("'/api/trinkets/search'");
  });
});
```

(The test that only the library list passes `see-all` lives in Task 5, which adds it.)

- [ ] **Step 2: Run it and watch it fail**

Mongo-leg command with `test/unit/trinket-search-results.test.js`.
Expected: FAIL, `Cannot find module …/trinket-search-results.js`.

- [ ] **Step 3: Implement**

`public/partials/directives/trinket-search-results.js`:

```js
// Rows for the trinket-search dropdown (#344): the results, then a footer row
// when there are more matches than shown. Framework-free so vitest can load it;
// also exposed as window.trinketSearchResults for the directive.
(function(root) {
  function rows(body, opts) {
    var data  = (body && body.data) || [];
    var total = (body && typeof body.total === 'number') ? body.total : data.length;
    var out = data.map(function(t) {
      if (!t.name) t.name = 'Untitled';
      return t;
    });
    if (total > data.length) {
      out.push({
        __footer   : true,
        text       : 'Showing ' + data.length + ' of ' + total + ', best matches first',
        seeAllText : (opts && opts.seeAll) ? 'See all ' + total + ' results' : null
      });
    }
    return out;
  }

  var api = { rows: rows };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.trinketSearchResults = api;
})(typeof window !== 'undefined' ? window : null);
```

`trinket-service.js`: change the constructor and registration, and `search`:

```js
function TrinketService(Restangular, $http) {
```

```js
  // $http, not Restangular: the apps' response interceptors keep only
  // response.data, which would drop `total`.
  this.search = function(q) {
    return $http.get('/api/trinkets/search', { params : { q : q } })
      .then(function(res) { return res.data; });
  }
```

```js
module.service('trinketsApi', ['Restangular', '$http', TrinketService]);
```

`trinket-search.js`: replace `searchTrinkets` and `onSelectResult`, and add `seeAll` to the scope:

```js
      scope.searchTrinkets = function(val) {
        scope.loadingTrinkets   = true;
        scope.searchInputActive = true;
        scope.lastTerm          = val;

        return trinketsApi.search(val).then(function(body) {
          scope.loadingTrinkets = false;
          return window.trinketSearchResults.rows(body, { seeAll : !!scope.seeAll });
        });
      }

      scope.onSelectResult = function(item) {
        if (item && item.__footer) {
          var term = scope.lastTerm;
          scope.trinketSearchValue = "";
          if (item.seeAllText && scope.seeAll) {
            scope.searchInputOpen   = false;
            scope.searchInputActive = false;
            scope.seeAll(term);
          }
          return;
        }
        scope.trinketSearchValue = "";
        scope.onSelect(item);
      }
```

```js
          , noLabel         : '='
          , seeAll          : '=?'
```

`trinket-search.html`: add `typeahead-min-length="2"` to the input (next to `typeahead-wait-ms="400"`) and replace the match template:

```html
<script type="text/ng-template" id="searchResultsTemplate.html">
  <a ng-if="!match.model.__footer" class="trinket-list-with-lang lang-{{ match.model.lang }}" bind-html-unsafe="match.model.name | typeaheadHighlight:query"></a>
  <a ng-if="match.model.__footer" class="trinket-search-footer">
    <span class="subheader">{{ match.model.text }}</span>
    <strong ng-if="match.model.seeAllText"> · {{ match.model.seeAllText }}</strong>
  </a>
</script>
```

`config/default.yaml`: in both bundles (lines ~347 and ~389) insert, directly above `'/partials/directives/trinket-search.js'`:

```yaml
      - '/partials/directives/trinket-search-results.js'
```

- [ ] **Step 4: Run it and watch it pass**

Same command. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add public/partials/directives/trinket-search-results.js public/partials/directives/trinket-search.js \
  public/partials/directives/trinket-search.html public/js/library/components/trinkets/trinket-service.js \
  config/default.yaml test/unit/trinket-search-results.test.js
git commit -m "feat(#344): search box 2-char minimum, count footer, optional See all"
```

---

### Task 5: Library list "See all", search chip and relevance sort

**Files:**
- Create: `public/js/library/trinkets/list/search-state.js`
- Modify: `public/js/library/trinkets/list/list-controller.js` (filters, `applyFilterParams`, `isFiltering`, `clearFilters`, sort options, `sortBy` watch, `$destroy`)
- Modify: `public/js/library/trinkets/list/list.html:8` (pass `see-all`) and the bulk-toolbar area (chip)
- Modify: `config/default.yaml:394` (register `search-state.js` before `list-controller.js`)
- Test: `test/unit/library-search-state.test.js` (new)

**Interfaces:**
- Consumes: directive `see-all` (Task 4); list `q` + `sort=relevance` (Task 3).
- Produces: `librarySearchState` (`window.librarySearchState`, `module.exports`):
  - `enter(state, term) → state`: `state = { filters, sortBy, saved }`. Saves `{ sortBy, scope }` into `saved` (only if not already in search), then sets `filters.q = term`, `filters.scope = 'all'`, `sortBy = 'relevance'`.
  - `leave(state) → state`: deletes `filters.q`, restores `sortBy` and `filters.scope` from `saved` (if `sortBy` is still `relevance`; a sort the user picked while searching is kept), clears `saved`.
  - `persistableSort(sortBy, saved) → string`: `relevance` maps to `saved.sortBy` (or `-lastView.viewedOn`); anything else is returned unchanged.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const fs = require('fs');
const path = require('path');
const s = require('../../public/js/library/trinkets/list/search-state.js');

const fresh = () => ({ filters: { name: '', scope: 'root' }, sortBy: '-lastUpdated', saved: null });

describe('library search state', () => {
  it('enter switches to all folders, relevance, and the term', () => {
    const st = s.enter(fresh(), 'pend');
    expect(st.filters.q).toBe('pend');
    expect(st.filters.scope).toBe('all');
    expect(st.sortBy).toBe('relevance');
  });
  it('leave restores the previous sort and scope', () => {
    const st = s.leave(s.enter(fresh(), 'pend'));
    expect(st.filters.q).toBeUndefined();
    expect(st.filters.scope).toBe('root');
    expect(st.sortBy).toBe('-lastUpdated');
    expect(st.saved).toBeNull();
  });
  it('a second See all keeps the original saved sort', () => {
    const st = s.leave(s.enter(s.enter(fresh(), 'pend'), 'wave'));
    expect(st.sortBy).toBe('-lastUpdated');
  });
  it('a sort picked while searching survives leaving', () => {
    const st = s.enter(fresh(), 'pend');
    st.sortBy = 'name';
    expect(s.leave(st).sortBy).toBe('name');
  });
  it('never persists relevance', () => {
    expect(s.persistableSort('relevance', { sortBy: '-lastUpdated' })).toBe('-lastUpdated');
    expect(s.persistableSort('relevance', null)).toBe('-lastView.viewedOn');
    expect(s.persistableSort('name', null)).toBe('name');
  });
});

describe('library list wiring', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
  it('list.html shows a removable search chip', () => {
    const html = read('public/js/library/trinkets/list/list.html');
    expect(html).toContain('filters.q');
    expect(html).toContain('clearSearch()');
    expect(html).toContain('(name or instructions)');
  });
  it('only the library list passes see-all', () => {
    expect(read('public/js/library/trinkets/list/list.html')).toContain('see-all="onSeeAll"');
    for (const p of ['public/js/library/trinkets/list/folder.html',
                     'public/partials/assignment_editor.html',
                     'public/partials/material.html']) {
      expect(read(p)).not.toContain('see-all=');
    }
  });
  it('the controller sends q and never caches relevance', () => {
    const js = read('public/js/library/trinkets/list/list-controller.js');
    expect(js).toContain('params.q');
    expect(js).toContain('persistableSort');
  });
  it('search-state.js is loaded before list-controller.js', () => {
    const lines = read('config/default.yaml').split('\n');
    const i = lines.findIndex((l) => l.includes("'/js/library/trinkets/list/list-controller.js'"));
    expect(lines.slice(0, i).some((l) => l.includes("'/js/library/trinkets/list/search-state.js'"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Mongo-leg command with `test/unit/library-search-state.test.js test/unit/trinket-search-results.test.js`.
Expected: FAIL, `Cannot find module …/search-state.js` (and the `see-all` wiring test fails on `list.html`).

- [ ] **Step 3: Implement**

`public/js/library/trinkets/list/search-state.js`:

```js
// Library list "See all" search state (#344): entering a search switches to all
// folders and relevance order; leaving restores what the user had. Plain
// functions so vitest can test them; also window.librarySearchState.
(function(root) {
  var DEFAULT_SORT = '-lastView.viewedOn';

  function enter(state, term) {
    if (!state.saved) {
      state.saved = { sortBy: state.sortBy, scope: state.filters.scope };
    }
    state.filters.q     = term;
    state.filters.scope = 'all';
    state.sortBy        = 'relevance';
    return state;
  }

  function leave(state) {
    var saved = state.saved || {};
    delete state.filters.q;
    if (state.sortBy === 'relevance') {
      state.sortBy = saved.sortBy || DEFAULT_SORT;
    }
    state.filters.scope = saved.scope || 'root';
    state.saved = null;
    return state;
  }

  function persistableSort(sortBy, saved) {
    if (sortBy !== 'relevance') return sortBy;
    return (saved && saved.sortBy) || DEFAULT_SORT;
  }

  var api = { enter: enter, leave: leave, persistableSort: persistableSort };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.librarySearchState = api;
})(typeof window !== 'undefined' ? window : null);
```

`list-controller.js` changes:

1. Near the other `var` declarations at the top: `searchState = window.librarySearchState,` and `searchSaved = null;`.
2. `applyFilterParams`: add `if ($scope.filters.q) { params.q = $scope.filters.q; }`.
3. `isFiltering`: add `f.q ||` at the start of the boolean.
4. Add, after `clearFilters`:

```js
  // "See all" from the search box (#344).
  var RELEVANCE_OPTION = { label : 'Best match', class : 'fa fa-search fa-fw' };

  $scope.onSeeAll = function(term) {
    var st = searchState.enter({ filters : $scope.filters, sortBy : $scope.sortBy, saved : searchSaved }, term);
    searchSaved = st.saved;
    $scope.sortOptions.relevance = RELEVANCE_OPTION;
    $scope.sortBy = st.sortBy;
    $scope.reloadWithFilters();
  };

  $scope.clearSearch = function() {
    var st = searchState.leave({ filters : $scope.filters, sortBy : $scope.sortBy, saved : searchSaved });
    searchSaved = null;
    delete $scope.sortOptions.relevance;
    $scope.sortBy = st.sortBy;
    $scope.reloadWithFilters();
  };
```

5. `clearFilters`: if `$scope.filters.q` is set, call `searchState.leave(...)` the same way (and delete the relevance option) before resetting `$scope.filters`, so the sort doesn't stay on `relevance`. Then reset as today.
6. `$scope.$watch('sortBy', …)`: `cache.set("library-sort-by", searchState.persistableSort(newValue, searchSaved));`
7. `$destroy` handler: `sort : searchState.persistableSort($scope.sortBy, searchSaved),`.
8. On load, if the cached sort is `relevance` (from before this fix), treat it as unset: right after `$scope.sortBy = cache.get(...) || ...`, add `if ($scope.sortBy === 'relevance') { $scope.sortBy = searchState.persistableSort('relevance', null); }`.

Paging needs no change: `moreTrinkets` derives `last` from `trinketUtil.getProperty(trinket, 'relevance')`, which is always undefined, so `from` is never sent and `lastCount` becomes the offset. Confirm this by reading `moreTrinkets` (`list-controller.js:335-400`) before moving on; if `last` can be non-undefined after `reloadWithFilters()`, set it to `undefined` there.

`list.html`:
- line 8: add `see-all="onSeeAll"` to the `<trinket-search>` element.
- Directly above the bulk toolbar row (`<div class="row bulk-toolbar" …>`, ~line 45), add:

```html
<div class="row" ng-if="filters.q">
  <div class="small-12 columns">
    <span class="label radius secondary library-search-chip">
      Search: "{{ filters.q }}" (name or instructions)
      <a ng-click="clearSearch()" title="Clear search" aria-label="Clear search">&times;</a>
    </span>
  </div>
</div>
```

`config/default.yaml`: insert `- '/js/library/trinkets/list/search-state.js'` directly above `'/js/library/trinkets/list/list-controller.js'`.

- [ ] **Step 4: Run it and watch it pass**

Mongo-leg command with `test/unit/library-search-state.test.js test/unit/trinket-search-results.test.js test/unit/library-selection.test.js`. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add public/js/library/trinkets/list/search-state.js public/js/library/trinkets/list/list-controller.js \
  public/js/library/trinkets/list/list.html config/default.yaml test/unit/library-search-state.test.js
git commit -m "feat(#344): library See all opens the paged list with a search chip and relevance order"
```

---

### Task 6: Course-editor toolbar: verify, pin, don't change

The spec says to check the insert-trinket search before acting. Reading the code while planning: `material.html:56` renders `<trinket-search toolbar="true">`. The directive has an **isolated scope** with its own `searchTrinkets` (through `trinketsApi`), so `toolbarControl.js:31-50`'s `$scope.searchTrinkets` (which reads `results.data.results`) is never called by that markup. So the toolbar most likely **works today** and picks up Task 4 automatically. Per the spec: change nothing, pin it with a test, and confirm in a browser (Task 7).

**Files:**
- Test: `test/unit/trinket-search-results.test.js` (append)

- [ ] **Step 1: Write the pinning test**

```js
describe('course editor toolbar search', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
  it('uses the shared directive (isolated scope, trinketsApi), not toolbarControl.searchTrinkets', () => {
    expect(read('public/partials/material.html')).toMatch(/<trinket-search[^>]*toolbar="true"/);
    const dir = read('public/partials/directives/trinket-search.js');
    expect(dir).toMatch(/scope\s*:\s*\{/);          // isolated scope
    expect(dir).toContain('trinketsApi.search(');
  });
});
```

- [ ] **Step 2: Run it**

Expected: PASS (it pins today's behaviour; there is no red step for a no-change task). If it FAILS, stop: the reading above is wrong, and the spec's "fix `toolbarControl.searchTrinkets` to read `results.data.data`, red first" branch applies instead. Report to Steve before doing that.

- [ ] **Step 3: Commit**

```bash
git add test/unit/trinket-search-results.test.js
git commit -m "test(#344): pin that the toolbar insert search goes through the shared directive"
```

Note for the PR description: `toolbarControl.$scope.searchTrinkets` looks unreachable and reads the wrong field. Mention it as a possible follow-up cleanup; don't delete it in this PR.

---

### Task 7: Browser check on a trial (deploy spec)

**Files:**
- Create: `test/browser/specs-deploy/library-search.spec.js`

**Interfaces:**
- Consumes: `signIn`, `apiFor`, `unwrap` from `test/browser/deploy-auth.js`; `fixtures.runId()` from `test/browser/fixtures`.

Runs only against a **trial** (never a prod: no test identities in prod). Creates 22 trinkets tagged with the run id and deletes them at the end.

- [ ] **Step 1: Write the spec**

Model it on `test/browser/specs-deploy/trinket-authoring.spec.js` (read it first for the `apiFor` method names and the sign-in/skip preamble; reuse that preamble verbatim).

```js
const { test, expect } = require('@playwright/test');
const fixtures = require('../fixtures');
const { signIn, apiFor, unwrap } = require('../deploy-auth');

// #344 against a real deployment: count footer, See all with a description-only
// match beyond the first 20, clearing the chip, and the course-editor toolbar
// insert search. Run against a TRIAL only.

const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const STATE = process.env.SMOKE_STORAGE_STATE;

test.describe('library search', () => {
  test.skip(!STATE && !(EMAIL && PASSWORD),
    'set SMOKE_EMAIL+SMOKE_PASSWORD, or SMOKE_STORAGE_STATE from save-session.js');
  test.use(STATE ? { storageState: STATE } : {});

  test('footer, See all, chip', async ({ page, baseURL }) => {
    const api = apiFor(page, baseURL);
    const tag = 's' + fixtures.runId().replace(/[^a-z0-9]/gi, '').slice(-8).toLowerCase();
    const ids = [];

    if (STATE) { await page.goto('/home'); } else { await signIn(page, baseURL, EMAIL, PASSWORD); }

    try {
      // 21 name matches + 1 description-only match = 22 > 20.
      for (let i = 0; i < 21; i++) {
        const t = unwrap(await api.post('/api/trinkets', { lang: 'python3', name: tag + ' ' + i, code: 'pass' }), 'data');
        ids.push(t.id);
      }
      const d = unwrap(await api.post('/api/trinkets', { lang: 'python3', name: 'notes', code: 'pass' }), 'data');
      await api.put('/api/trinkets/' + d.id + '/description', { description: 'see ' + tag });
      ids.push(d.id);

      await page.goto('/library');
      await page.locator('#search-label').click();
      await page.locator('#trinket-search').fill(tag);
      await expect(page.getByText('Showing 20 of 22, best matches first')).toBeVisible();
      await page.getByText('See all 22 results').click();

      await expect(page.locator('.library-search-chip')).toContainText(tag);
      // scroll/paging: the description-only match is the 22nd and appears.
      await expect(page.getByText('notes').first()).toBeVisible({ timeout: 15000 });

      await page.locator('.library-search-chip a').click();
      await expect(page.locator('.library-search-chip')).toHaveCount(0);
    } finally {
      if (ids.length) await api.post('/api/trinkets/bulk', { action: 'delete', ids });
    }
  });
});
```

Adjust the create payload and `api` method names to what `apiFor` actually provides (read `test/browser/deploy-auth.js:83-110`). Add a second test for the toolbar insert search: open a course page editor on the trial's test course, click the toolbar trinket key (`title="Insert Trinket"`), type the tag, and expect a result row. Use the existing course used by `course-journey.spec.js` for the course URL pattern.

- [ ] **Step 2: Deploy the branch to a trial and run it**

Follow `reference_gcr_trial_deploy` (memory): in `~/glow-repos/gcr-trial`, check out the branch, then `TRINKET_DEPLOY=trial-gcr bash deploy-cloudrun.sh`. Check `/version` shows the branch commit. Then:

```bash
cd test/browser && SMOKE_STORAGE_STATE=... TRINKET_BASE_URL=https://<trial> \
  npx playwright test -c playwright.deploy.config.js specs-deploy/library-search.spec.js
```

Expected: both tests PASS. **Ask Steve before deploying** (outward action). If any step fails, debug with the browser before changing code.

- [ ] **Step 3: Commit**

```bash
git add test/browser/specs-deploy/library-search.spec.js
git commit -m "test(#344): deploy spec for footer, See all, chip and toolbar insert search"
```

---

### Task 8: Full suites, secret check, PR draft

- [ ] **Step 1: Full Mongo leg** (no file argument). Expected: 0 failed. Record the pass count.
- [ ] **Step 2: Full Firestore leg.** Expected: 0 failed. Record the pass count.
- [ ] **Step 3: Secret hygiene:** `cat .gitignore` (covers `.env`, `.env.*`, `*.pem`); `git diff main --name-only` shows only the files named in this plan plus the spec and plan docs.
- [ ] **Step 4: Draft the PR text** in `~/Desktop/pr-344-library-search.md` (via desktop-handoff): what changed, both suite counts, the trial run, the "no cache" decision with the usage numbers, the toolbar dead-code note, and `Closes #344`. End the body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01QNw6KLiif2r9zSoSQug4iL
```

- [ ] **Step 5: Stop.** Ask Steve before pushing the branch or opening the PR. Andrew and Todd approve the merge.
