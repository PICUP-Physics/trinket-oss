# Trinket Bulk Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select many trinkets (driven by name/date/folder-scope filters) and move them into/out of a folder or soft-delete them in one action, via a new `POST /api/trinkets/bulk` endpoint.

**Architecture:** One new Hapi route + controller method (`trinket.bulk`) that authorizes each id by intersecting the request's id list with `Trinket.findByOwner(user)` (the same finder the list uses — this *is* the ownership gate) and reuses existing model methods (`softDelete`, `addFolder`/`removeFolder`, `folder.addTrinket`/`removeTrinket`). No schema change. The AngularJS library gains per-row selection, a bulk action bar, filters, and a root scope toggle in the two existing list controllers.

**Tech Stack:** Node 20, Hapi 20+, Mongoose + Firestore dual backend, Joi validation, Vitest (container loop, both backends), AngularJS 1.x + Restangular + Foundation.

## Global Constraints

- **Backend-neutral:** every backend behavior must pass on BOTH the mongoose default and the Firestore emulator profile. Firestore has no nested `$exists` and `== null` matches only an explicit null — never a missing field (this is why the codebase filters/sorts in JS after `findByOwner`, and why PR #53 needed care). Do not introduce a query that assumes mongo semantics.
- **Ownership is server-side, per id.** The client's id list is a request, not a grant. An id the user does not own must never be acted on — it goes to `failed`.
- **No schema change.** Reuse `trinket.folder`, `deletedAt`, and existing model methods.
- **Explicit ids, not a re-resolved filter.** The endpoint acts on the exact ids sent; it never re-runs the filter server-side.
- **Response shape (exact):** `{ data: { ok: [<id>...], failed: [{ id, reason }] } }` where `reason ∈ {'not-owned','folder-not-found','bad-action','error'}`.
- **The trinket `id` the client holds and sends is the Mongo `_id`** (the list handler sets `trinket.id = trinket._id`; `createTrinket` returns `data.id` = `_id`).
- **Out of scope (do not build):** tags, courses, a trinket "archive" concept, an undo toast. A trash/restore view is a separate follow-on.

---

## Setup (one-time, on intelmini — do before Task 1)

The container test loop needs a per-machine deps volume and (for the Firestore profile) a built emulator image. These exist on aluminum but NOT on intelmini.

- [ ] **Confirm branch and clean tree**

Run: `cd ~/Development/glow-repos/gcr-firestore-base && git checkout design/trinket-bulk-management && git status --short`
Expected: on `design/trinket-bulk-management`, clean (the spec + this plan are already committed here).

- [ ] **Build the Firestore emulator test image (once)**

Run:
```bash
docker build --platform linux/amd64 -t trinket-test-firestore -f test/firestore-emulator.Dockerfile .
```
Expected: image `trinket-test-firestore` built. (Header of that Dockerfile documents both profiles.)

- [ ] **Prime the deps volume (first mongo run installs deps + downloads mongod)**

Run:
```bash
docker run --rm --platform linux/amd64 \
  -v "$PWD":/app -v gcr-base-nm:/app/node_modules -w /app \
  -e MONGOMS_DOWNLOAD_DIR=/app/node_modules/.mongo-binaries \
  node:20-bullseye bash -lc "npm ci --legacy-peer-deps && npx vitest run test/lib/api/imports.test.js"
```
Expected: `imports.test.js` passes (5 tests). This proves the harness works on intelmini before you add anything.

**Test commands used throughout this plan** (the deps volume `gcr-base-nm` and image are now built):

*Mongo (default):*
```bash
docker run --rm --platform linux/amd64 \
  -v "$PWD":/app -v gcr-base-nm:/app/node_modules -w /app \
  -e MONGOMS_DOWNLOAD_DIR=/app/node_modules/.mongo-binaries \
  node:20-bullseye bash -lc "npx vitest run <FILE>"
```

*Firestore emulator profile:*
```bash
docker run --rm --platform linux/amd64 \
  -v "$PWD":/app -v gcr-base-nm:/app/node_modules -w /app \
  trinket-test-firestore bash -lc '
    java -jar /emulator/firestore.jar --host 127.0.0.1 --port 8089 >/tmp/emu.log 2>&1 &
    until curl -s 127.0.0.1:8089 >/dev/null; do sleep 0.5; done
    TEST_DB_BACKEND=firestore FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 \
      npx vitest run --fileParallelism=false <FILE>'
```

---

## Task 1: Bulk endpoint — delete action

**Files:**
- Modify: `config/api_routes.js` (add the `POST /api/trinkets/bulk` route near the other `/api/trinkets` routes, ~line 1066)
- Modify: `lib/controllers/trinket.js` (add a `bulk` handler to the exported controller object; `Folder` is already required at the top)
- Test: `test/lib/api/bulk.test.js` (create)

**Interfaces:**
- Consumes: `Trinket.findByOwner(ownerId)` → Promise of the user's **live** trinket instances (filters `deletedAt: null`); each instance has `.softDelete()` → Promise. `request.user`, `request.payload`, `request.success(obj)` (→ body `{ data: obj }`... actually wraps as `{ data: obj }`; the tests below assert the real shape), `reply(err)`.
- Produces: `POST /api/trinkets/bulk` accepting `{ action, ids, folderId? }`, returning `{ data: { ok, failed } }`. Task 2 extends the SAME handler with `action: 'move'`.

- [ ] **Step 1: Write the failing test**

Create `test/lib/api/bulk.test.js`:
```js
'use strict';

// POST /api/trinkets/bulk — batch delete/move with a per-id ownership gate.
// Ownership is enforced by intersecting the requested ids with the caller's own
// live trinkets (Trinket.findByOwner), so a foreign or unknown id is never acted
// on. Delete is soft (deletedAt), matching the single-item delete.

const flow = require('../../helpers/flow.cjs');

beforeEach(() => { flow.cookies = {}; });

async function makeTrinkets(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    await flow.createTrinket();
    ids.push(flow.lastResponse.body.data.id);
  }
  return ids;
}

async function liveIds(user) {
  const owner = await new Promise((res, rej) =>
    User.findByLogin(user, (e, d) => (e ? rej(e) : res(d))));
  const live = await Trinket.findByOwner(owner._id || owner.id);
  return live.map((t) => String(t._id));
}

describe('POST /api/trinkets/bulk — delete', () => {
  it('soft-deletes exactly the given ids', async () => {
    await flow.switchUser('user');
    const ids = await makeTrinkets(3);

    const r = await flow.post('/api/trinkets/bulk', { action: 'delete', ids: [ids[0], ids[1]] });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.ok.sort()).toEqual([ids[0], ids[1]].sort());
    expect(r.body.data.failed).toEqual([]);

    const remaining = await liveIds('test@dummy.com');
    expect(remaining).toContain(ids[2]);
    expect(remaining).not.toContain(ids[0]);
    expect(remaining).not.toContain(ids[1]);
  });

  it('routes a foreign id to failed and never deletes it', async () => {
    await flow.switchUser('admin');
    const foreign = (await makeTrinkets(1))[0];

    await flow.switchUser('user');
    const mine = (await makeTrinkets(1))[0];

    const r = await flow.post('/api/trinkets/bulk', { action: 'delete', ids: [mine, foreign] });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.ok).toEqual([mine]);
    expect(r.body.data.failed).toEqual([{ id: foreign, reason: 'not-owned' }]);

    // The foreign trinket is still live for its real owner.
    expect(await liveIds('admin@dummy.com')).toContain(foreign);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run the *Mongo* command with `<FILE>` = `test/lib/api/bulk.test.js`.
Expected: FAIL — the route 404s (`statusCode` 404, not 200) because `trinket.bulk` doesn't exist yet.

- [ ] **Step 3: Add the route**

In `config/api_routes.js`, add near the other `/api/trinkets` routes (e.g. just before `POST /api/trinkets/{trinketId}/folder` at ~line 1066). `Joi` is already required at the top of the file:
```js
  {
    route : 'POST /api/trinkets/bulk trinket.bulk',
    config : {
      auth : 'session',
      validate : {
        payload : {
          action   : Joi.string().valid('delete', 'move').required(),
          ids      : Joi.array().items(Joi.string()).min(1).required(),
          folderId : Joi.string().allow(null).optional()
        }
      }
    }
  },
```
(The static `bulk` segment does not collide with `{trinketId}` routes — Hapi prefers the literal path.)

- [ ] **Step 4: Add the handler (delete only for now)**

In `lib/controllers/trinket.js`, add to the exported controller object (alongside `addToFolder`, `remove`):
```js
  bulk : function(request, reply) {
    var action = request.payload.action;
    var ids    = request.payload.ids || [];
    var user   = request.user;
    var result = { ok : [], failed : [] };

    return Trinket.findByOwner(user._id)
      .then(function(owned) {
        var byId = {};
        owned.forEach(function(t) { byId[String(t._id)] = t; });

        // Sequential: keeps writes ordered and the code simple; N writes is the
        // floor either way (Firestore bills per write — see CLAUDE.md).
        return ids.reduce(function(chain, id) {
          return chain.then(function() {
            var t = byId[String(id)];
            if (!t) { result.failed.push({ id : id, reason : 'not-owned' }); return; }

            var op;
            if (action === 'delete') {
              op = t.softDelete();
            } else {
              result.failed.push({ id : id, reason : 'bad-action' });
              return;
            }
            return op
              .then(function() { result.ok.push(id); })
              .catch(function() { result.failed.push({ id : id, reason : 'error' }); });
          });
        }, Promise.resolve());
      })
      .then(function() {
        return request.success({ data : result });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
```

- [ ] **Step 5: Run test to verify it passes (Mongo)**

Run the *Mongo* command with `<FILE>` = `test/lib/api/bulk.test.js`.
Expected: PASS (2 tests).

> If `r.body.data.ok` is `undefined`, `request.success` may wrap differently than assumed. Inspect one response (`console.log(r.body)`) and adjust the assertions to the real shape — but keep `{ ok, failed }` as the handler's own structure. Note the real shape here for later tasks.

- [ ] **Step 6: Run the SAME test on Firestore**

Run the *Firestore* command with `<FILE>` = `test/lib/api/bulk.test.js`.
Expected: PASS (2 tests). This proves the ownership intersection and soft-delete work on both backends.

- [ ] **Step 7: Commit**

```bash
git add config/api_routes.js lib/controllers/trinket.js test/lib/api/bulk.test.js
git commit -m "feat: POST /api/trinkets/bulk — batch soft-delete with per-id ownership gate"
```

---

## Task 2: Bulk endpoint — move action (into a folder / to root)

**Files:**
- Modify: `lib/controllers/trinket.js` (add a module-scope `applyMove` helper; extend `bulk` to handle `action: 'move'`)
- Test: `test/lib/api/bulk.test.js` (extend)

**Interfaces:**
- Consumes: `Folder.findById(folderId)` → Promise of a folder instance (or falsy); folder has `_owner`, `.addTrinket(trinket, user)`, `.removeTrinket(trinketId)`. Trinket instance has `.folder = { folderId, name, folderSlug, ownerSlug }` (or unset), `.addFolder(folder)`, `.removeFolder()`.
- Produces: `action: 'move'` with `folderId` (a folder id → move there) or `folderId: null` (→ remove from folder, to root). Same `{ data: { ok, failed } }` shape.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib/api/bulk.test.js`:
```js
describe('POST /api/trinkets/bulk — move', () => {
  async function makeFolder(name) {
    await flow.post('/api/folders', { name });
    await flow.get('/api/folders');
    const f = flow.lastResponse.body.data.find((x) => x.name === name);
    expect(f).toBeTruthy();
    return f.id || f._id;
  }

  function folderIdOf(id) {  // read a trinket's current folder via the list
    return flow.get('/api/trinkets?scope=all').then(() => {
      const t = flow.lastResponse.body.data.find((x) => String(x.id) === String(id));
      return t && t.folder ? String(t.folder.folderId) : null;
    });
  }

  it('moves the given trinkets into a folder', async () => {
    await flow.switchUser('user');
    const ids = await makeTrinkets(2);
    const folderId = await makeFolder('Fall2024');

    const r = await flow.post('/api/trinkets/bulk', { action: 'move', ids, folderId });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.ok.sort()).toEqual(ids.slice().sort());
    expect(r.body.data.failed).toEqual([]);

    expect(await folderIdOf(ids[0])).toBe(String(folderId));
    expect(await folderIdOf(ids[1])).toBe(String(folderId));
  });

  it('removes trinkets from their folder when folderId is null', async () => {
    await flow.switchUser('user');
    const ids = await makeTrinkets(1);
    const folderId = await makeFolder('Temp');
    await flow.post('/api/trinkets/bulk', { action: 'move', ids, folderId });
    expect(await folderIdOf(ids[0])).toBe(String(folderId));

    const r = await flow.post('/api/trinkets/bulk', { action: 'move', ids, folderId: null });
    expect(r.body.data.ok).toEqual(ids);
    expect(await folderIdOf(ids[0])).toBe(null);
  });

  it('fails the whole move when the target folder is not the caller\'s', async () => {
    await flow.switchUser('admin');
    const foreignFolder = await makeFolder('AdminFolder');

    await flow.switchUser('user');
    const ids = await makeTrinkets(1);
    const r = await flow.post('/api/trinkets/bulk', { action: 'move', ids, folderId: foreignFolder });
    expect(r.body.data.ok).toEqual([]);
    expect(r.body.data.failed).toEqual([{ id: ids[0], reason: 'folder-not-found' }]);
  });
});
```
(This assumes Task 4's `?scope=all` list param exists for read-back. If Task 2 is implemented before Task 4, replace `folderIdOf` with a direct model read: `Trinket.findByOwner(owner._id)` then find by id and read `.folder`. Use whichever is available; the assertion — folder set/cleared — is the same.)

- [ ] **Step 2: Run to verify failure**

Run *Mongo* on `test/lib/api/bulk.test.js`.
Expected: the three move tests FAIL — `action: 'move'` currently returns `failed: [{reason:'bad-action'}]`.

- [ ] **Step 3: Add the `applyMove` helper (module scope, near the top of `lib/controllers/trinket.js`, after the requires)**

```js
// Move a trinket to targetFolder (a Folder instance) or, when targetFolder is
// null, to the root (out of any folder). Mirrors addToFolder/removeFromFolder:
// leave the current folder first, then join the new one (or none).
function applyMove(trinket, targetFolder, user) {
  var leaveCurrent = (trinket.folder && trinket.folder.folderId)
    ? Folder.findById(trinket.folder.folderId).then(function(f) {
        return f ? f.removeTrinket(trinket.id) : Promise.resolve();
      })
    : Promise.resolve();

  return leaveCurrent.then(function() {
    if (!targetFolder) {
      return trinket.removeFolder();
    }
    return targetFolder.addTrinket(trinket, user)
      .then(function() { return trinket.addFolder(targetFolder); });
  });
}
```

- [ ] **Step 4: Extend the `bulk` handler to resolve the folder and dispatch move**

Replace the body of `bulk` so it resolves the target folder once (for `move`) before the per-id loop, and calls `applyMove`:
```js
  bulk : function(request, reply) {
    var action   = request.payload.action;
    var ids      = request.payload.ids || [];
    var folderId = request.payload.folderId || null;
    var user     = request.user;
    var result   = { ok : [], failed : [] };

    return Trinket.findByOwner(user._id)
      .then(function(owned) {
        var byId = {};
        owned.forEach(function(t) { byId[String(t._id)] = t; });

        var resolveFolder = (action === 'move' && folderId)
          ? Folder.findById(folderId)
          : Promise.resolve(null);

        return resolveFolder.then(function(targetFolder) {
          // A move to a missing/foreign folder can touch nothing.
          if (action === 'move' && folderId &&
              (!targetFolder || String(targetFolder._owner) !== String(user._id))) {
            ids.forEach(function(id) { result.failed.push({ id : id, reason : 'folder-not-found' }); });
            return;
          }

          return ids.reduce(function(chain, id) {
            return chain.then(function() {
              var t = byId[String(id)];
              if (!t) { result.failed.push({ id : id, reason : 'not-owned' }); return; }

              var op;
              if (action === 'delete')     op = t.softDelete();
              else if (action === 'move')  op = applyMove(t, targetFolder, user);
              else { result.failed.push({ id : id, reason : 'bad-action' }); return; }

              return op
                .then(function() { result.ok.push(id); })
                .catch(function() { result.failed.push({ id : id, reason : 'error' }); });
            });
          }, Promise.resolve());
        });
      })
      .then(function() { return request.success({ data : result }); })
      .catch(function(err) { return reply(err); });
  },
```

- [ ] **Step 5: Run to verify pass (Mongo)**

Run *Mongo* on `test/lib/api/bulk.test.js`.
Expected: PASS (all delete + move tests).

- [ ] **Step 6: Run on Firestore**

Run *Firestore* on `test/lib/api/bulk.test.js`.
Expected: PASS. (Folder read-back is where a mongo-only assumption would bite — this proves it on Firestore too.)

- [ ] **Step 7: Commit**

```bash
git add lib/controllers/trinket.js test/lib/api/bulk.test.js
git commit -m "feat: bulk move — into a folder or to root, foreign-folder guarded"
```

---

## Task 3: List filtering + scope on the server (name, date, scope=all)

**Files:**
- Modify: `lib/controllers/trinket.js` `list` handler (~lines 109-211): add `name`, `updatedWithin`, and `scope` query params to the existing in-JS filter pass.
- Test: `test/lib/api/bulk.test.js` or a new `test/lib/api/trinket-list-filter.test.js` (create)

**Interfaces:**
- Consumes: existing `list` handler that does `Trinket.findByOwner(ownerId)` then filters/sorts/paginates in JS; `request.query`.
- Produces: `GET /api/trinkets` additionally honors `name` (case-insensitive substring on `t.name`), `updatedWithin` (`7d`|`30d`|`year`|`all`, filters `t.lastUpdated`), and `scope` (`root` = folderless only, the current default; `all` = every trinket regardless of folder). Task 5's "select all matching" relies on `scope=all` + these filters returning the full matching set (raise `limit` or page to gather ids).

- [ ] **Step 1: Write the failing test**

Create `test/lib/api/trinket-list-filter.test.js`:
```js
'use strict';
const flow = require('../../helpers/flow.cjs');
beforeEach(() => { flow.cookies = {}; });

async function make(name) {
  await flow.createTrinket();
  const id = flow.lastResponse.body.data.id;
  await flow.put('/api/trinkets/' + id + '/name', { name });
  return id;
}

describe('GET /api/trinkets filtering', () => {
  it('filters by name substring (case-insensitive)', async () => {
    await flow.switchUser('user');
    await make('Pendulum Lab');
    await make('Wave Demo');

    await flow.get('/api/trinkets?scope=all&name=pend');
    const names = flow.lastResponse.body.data.map((t) => t.name);
    expect(names).toContain('Pendulum Lab');
    expect(names).not.toContain('Wave Demo');
  });

  it('scope=all returns foldered trinkets; scope=root (default) does not', async () => {
    await flow.switchUser('user');
    const id = await make('In A Folder');
    await flow.post('/api/folders', { name: 'F' });
    await flow.get('/api/folders');
    const folderId = flow.lastResponse.body.data.find((f) => f.name === 'F').id;
    await flow.post('/api/trinkets/bulk', { action: 'move', ids: [id], folderId });

    await flow.get('/api/trinkets');                // default scope = root
    expect(flow.lastResponse.body.data.map((t) => String(t.id))).not.toContain(String(id));

    await flow.get('/api/trinkets?scope=all');
    expect(flow.lastResponse.body.data.map((t) => String(t.id))).toContain(String(id));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run *Mongo* on `test/lib/api/trinket-list-filter.test.js`.
Expected: FAIL — `name` is ignored (Wave Demo present), and `scope=all` still hides foldered trinkets (the folder filter drops them).

- [ ] **Step 3: Implement the filters in the `list` handler**

In `lib/controllers/trinket.js`, in `list`, locate the folder-filter block (the `var folderId = request.query.folder;` filter, ~line 158) and replace/extend the in-JS filtering so scope + name + date are applied. Insert after the `toObject()` normalization and replace the existing folder filter:
```js
        var scope    = request.query.scope || 'root';
        var folderId = request.query.folder;
        var nameQ    = (request.query.name || '').toLowerCase();
        var within   = request.query.updatedWithin || 'all';

        // Scope: an explicit folder, or root(=folderless), or all(=every trinket).
        trinkets = trinkets.filter(function(t) {
          if (folderId) {
            return t.folder && t.folder.folderId &&
                   t.folder.folderId.toString() === folderId;
          }
          if (scope === 'all') return true;
          return !t.folder;   // scope 'root' (default): folderless only
        });

        // Name substring (case-insensitive).
        if (nameQ) {
          trinkets = trinkets.filter(function(t) {
            return (t.name || '').toLowerCase().indexOf(nameQ) !== -1;
          });
        }

        // Date preset over lastUpdated.
        if (within !== 'all') {
          var days = within === '7d' ? 7 : within === '30d' ? 30 : within === 'year' ? 365 : 0;
          if (days) {
            var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            trinkets = trinkets.filter(function(t) {
              var lu = t.lastUpdated ? (t.lastUpdated.toDate ? t.lastUpdated.toDate() : new Date(t.lastUpdated)) : null;
              return lu && lu >= cutoff;
            });
          }
        }
```
(The `lastUpdated`/Timestamp normalization already happens a few lines below for sorting; this cutoff comparison tolerates both a Date and a Firestore Timestamp.)

- [ ] **Step 4: Run to verify pass (Mongo, then Firestore)**

Run *Mongo* then *Firestore* on `test/lib/api/trinket-list-filter.test.js`.
Expected: PASS on both.

- [ ] **Step 5: Commit**

```bash
git add lib/controllers/trinket.js test/lib/api/trinket-list-filter.test.js
git commit -m "feat: trinket list — name/date filters and scope=all|root"
```

---

## Task 4: Client — selection state, bulk bar, filters UI, scope toggle

**Files:**
- Modify: `public/js/library/components/trinkets/trinket-service.js` (add `bulk` method)
- Modify: `public/js/library/trinkets/list/list-controller.js` (selection state, filter model, scope toggle)
- Modify: `public/js/library/trinkets/list/folder-list-controller.js` (selection state; scope fixed to the folder)
- Modify: `public/js/library/trinkets/list/list.html` (root list; repeats over `items`, uses `#trinkets-list`, infinite-scroll `moreTrinkets()`) and `public/js/library/trinkets/list/folder.html` (in-folder view) — add per-row checkbox, bulk action bar, filter row.
- Test: `test/unit/library-selection.test.js` (create) — pure selection/filter helpers only.

**Interfaces:**
- Consumes: `trinketsApi` (Restangular `all('trinkets')`), `libraryState.folders`.
- Produces: `trinketsApi.bulk(action, ids, folderId)` → Promise of `{ ok, failed }`; controller scope has `selected` (a Set/hash of ids), `toggleSelect(id)`, `clearSelection()`, `selectionCount()`, and filter model `filters = { name, updatedWithin, scope }`.

- [ ] **Step 1: Add the client service method + a pure selection helper (test-first)**

Create `test/unit/library-selection.test.js` (pure functions — no DOM/Angular):
```js
'use strict';
// Pure selection-model helpers used by the list controllers. Kept as plain
// functions so they are unit-testable without an Angular/DOM harness (none
// exists in this repo).
const sel = require('../../public/js/library/trinkets/list/selection-model.js');

describe('selection model', () => {
  it('toggles ids on and off', () => {
    const s = sel.create();
    sel.toggle(s, 'a'); sel.toggle(s, 'b'); sel.toggle(s, 'a');
    expect(sel.ids(s)).toEqual(['b']);
    expect(sel.count(s)).toBe(1);
  });
  it('selectAll adds every id in the matching set; clear empties it', () => {
    const s = sel.create();
    sel.selectAll(s, ['a', 'b', 'c']);
    expect(sel.count(s)).toBe(3);
    sel.clear(s);
    expect(sel.count(s)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run *Mongo* on `test/unit/library-selection.test.js` (any profile works; it touches no DB).
Expected: FAIL — `selection-model.js` does not exist.

- [ ] **Step 3: Implement the selection model**

Create `public/js/library/trinkets/list/selection-model.js`:
```js
// Plain, framework-free selection set. Exported for unit tests; also attached to
// the AngularJS global namespace for the controllers to consume.
(function(root) {
  var selection = {
    create   : function() { return { map: {} }; },
    toggle   : function(s, id) { if (s.map[id]) delete s.map[id]; else s.map[id] = true; },
    selectAll: function(s, ids) { ids.forEach(function(id) { s.map[id] = true; }); },
    clear    : function(s) { s.map = {}; },
    ids      : function(s) { return Object.keys(s.map); },
    count    : function(s) { return Object.keys(s.map).length; },
    has      : function(s, id) { return !!s.map[id]; }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = selection;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('library.selection', selection);
})(typeof window !== 'undefined' ? window : this);
```

- [ ] **Step 4: Run to verify pass**

Run *Mongo* on `test/unit/library-selection.test.js`.
Expected: PASS (2 tests).

- [ ] **Step 5: Add `trinketsApi.bulk`**

In `public/js/library/components/trinkets/trinket-service.js`, inside `TrinketService`, add:
```js
  this.bulk = function(action, ids, folderId) {
    return _all.customPOST({ action: action, ids: ids, folderId: folderId === undefined ? null : folderId }, 'bulk')
      .then(function(res) {
        var data = Restangular.stripRestangular(res);
        return (data && data.data) ? data.data : data;   // { ok, failed }
      });
  };
```

- [ ] **Step 6: Wire selection + filters into the controllers and template**

In `list-controller.js` and `folder-list-controller.js`: initialize `$scope.selection = TrinketIO.import('library.selection').create();` plus `$scope.toggleSelect`, `$scope.selectionCount`, `$scope.clearSelection`, and (list-controller only) `$scope.filters = { name:'', updatedWithin:'all', scope:'root' }` and a `$scope.reloadWithFilters()` that re-fetches `trinketsApi.getList` with the filter params. In the folder controller, scope is the folder (no scope toggle).

In the list template add: a filter row (name input bound to `filters.name`; a date-preset `<select>` bound to `filters.updatedWithin` with options 7d/30d/year/all; at root, a scope toggle bound to `filters.scope` with `root`/`all`), a per-row checkbox (`ng-checked="selection.has(...)" ng-click="toggleSelect(trinket.id)"`), and the bulk action bar shown `ng-if="selectionCount() > 0"`.

- [ ] **Step 7: Add a static markup assertion (guards the bar wiring, PR #52-style)**

Append to `test/unit/library-selection.test.js`:
```js
const fs = require('fs');
const path = require('path');
describe('library list markup', () => {
  it('has a bulk bar gated on selection and Move/Delete actions', () => {
    // The root list partial edited in Step 6.
    const p = path.join(__dirname, '../../public/js/library/trinkets/list/list.html');
    const html = fs.readFileSync(p, 'utf8');
    expect(html).toContain('selectionCount()');
    expect(html).toMatch(/Move|move/);
    expect(html).toMatch(/Delete|delete/);
  });
});
```
(Adjust the partial path to the file edited in Step 6.)

- [ ] **Step 8: Run pass + manual check**

Run *Mongo* on `test/unit/library-selection.test.js` → PASS. Then a manual note in the commit: the Angular click/reveal wiring is verified by loading the library page (no runtime DOM harness exists).

- [ ] **Step 9: Commit**

```bash
git add public/js/library test/unit/library-selection.test.js public/js/library/trinkets/list/list.html public/js/library/trinkets/list/folder.html
git commit -m "feat: library selection model, bulk bar, filters, scope toggle"
```

---

## Task 5: Client — select-all-matching, action wiring, confirm dialog, partial failure

**Files:**
- Modify: `list-controller.js` / `folder-list-controller.js` (select-all-matching; action handlers; partial-failure messaging)
- Modify: the list template (Select-all control with match count; confirm-delete dialog; result message)
- Test: extend `test/unit/library-selection.test.js` (pure "gather matching ids" helper) + static markup assertions

**Interfaces:**
- Consumes: `trinketsApi.bulk`, `trinketsApi.getList`, the selection model, `filters`.
- Produces: `Select all N matching` selects every id returned by the filtered/scoped list (fetched with a high `limit` or paged to completion, not just the visible page); `[Move to ▾]` and `[Delete]` call `trinketsApi.bulk`; delete opens a count-confirm dialog first; a `{ ok, failed }` result renders "Moved/Deleted X, Y couldn't be …" and leaves failed ids selected.

- [ ] **Step 1: Write the failing pure-helper test**

Append to `test/unit/library-selection.test.js`:
```js
const sel2 = require('../../public/js/library/trinkets/list/selection-model.js');
describe('select-all over a matching set', () => {
  it('selects every matching id, not just a page', () => {
    const s = sel2.create();
    const matching = ['a', 'b', 'c', 'd', 'e'];   // full filtered set, all pages
    sel2.selectAll(s, matching);
    expect(sel2.count(s)).toBe(5);
  });
  it('after a partial failure, only failed ids remain selected', () => {
    const s = sel2.create();
    sel2.selectAll(s, ['a', 'b', 'c']);
    const failedIds = ['c'];
    sel2.ids(s).forEach(function(id) { if (failedIds.indexOf(id) === -1) sel2.toggle(s, id); });
    expect(sel2.ids(s)).toEqual(['c']);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run *Mongo* on `test/unit/library-selection.test.js`. The first assertion passes trivially; the intent of this task is the CONTROLLER wiring. If both helper assertions already pass (they exercise existing model methods), treat Step 2 as green for the helper and proceed to wire the controller — the "failing test" for the UI portion is the markup assertion in Step 4, which fails until the dialog/select-all markup exists.

- [ ] **Step 3: Implement select-all-matching + action handlers**

In `list-controller.js` (and folder-list): add `$scope.selectAllMatching()` which calls `trinketsApi.getList` with the current filter params and a large limit (or pages until the returned page is short), then `selection.selectAll(scope.selection, ids)` and stores `$scope.matchCount`. Add `$scope.bulkMove(folderId)` and `$scope.bulkDelete()`:
```js
  $scope.bulkMove = function(folderId) {
    var ids = TrinketIO.import('library.selection').ids($scope.selection);
    trinketsApi.bulk('move', ids, folderId).then(function(res) {
      applyBulkResult(res, 'Moved');
    });
  };
  $scope.confirmBulkDelete = function() { $('#bulkDeleteDialog').foundation('reveal', 'open'); };
  $scope.bulkDelete = function() {
    var ids = TrinketIO.import('library.selection').ids($scope.selection);
    trinketsApi.bulk('delete', ids).then(function(res) {
      $('#bulkDeleteDialog').foundation('reveal', 'close');
      applyBulkResult(res, 'Deleted');
    });
  };
  function applyBulkResult(res, verb) {
    var s = $scope.selection, model = TrinketIO.import('library.selection');
    // Keep only failed ids selected; report the split.
    var failed = (res.failed || []).map(function(f) { return f.id; });
    model.ids(s).forEach(function(id) { if (failed.indexOf(id) === -1) model.toggle(s, id); });
    $scope.bulkMessage = verb + ' ' + (res.ok || []).length +
      (failed.length ? (', ' + failed.length + " couldn't be " + verb.toLowerCase()) : '');
    $scope.reloadWithFilters();
  }
```

- [ ] **Step 4: Add the confirm dialog + select-all control to the template, and assert markup**

Add a Foundation reveal-modal `#bulkDeleteDialog` ("Delete {{selectionCount()}} trinkets? [Cancel] [Delete]"), a "Select all N matching" control bound to `selectAllMatching()` shown when a filter is active, and a `{{ bulkMessage }}` line. Extend the markup assertion:
```js
it('has a count-confirm delete dialog and a select-all-matching control', () => {
  const p = path.join(__dirname, '../../public/js/library/trinkets/list/list.html');
  const html = fs.readFileSync(p, 'utf8');
  expect(html).toContain('bulkDeleteDialog');
  expect(html).toContain('selectAllMatching');
});
```

- [ ] **Step 5: Run pass + manual click-through**

Run *Mongo* on `test/unit/library-selection.test.js` → PASS. Manually load the library page: filter, Select-all-matching, Move and Delete (confirm), verify a partial failure leaves failed rows selected. Note this manual check in the commit message (no runtime DOM harness).

- [ ] **Step 6: Full-suite regression on both backends**

Run *Mongo* then *Firestore* with `<FILE>` omitted (whole suite):
```bash
... node:20-bullseye bash -lc "npx vitest run"
... trinket-test-firestore bash -lc '<emulator boot> ... npx vitest run --fileParallelism=false'
```
Expected: all green on both, no regressions.

- [ ] **Step 7: Commit**

```bash
git add public/js/library public/js/library/trinkets/list/list.html public/js/library/trinkets/list/folder.html test/unit/library-selection.test.js
git commit -m "feat: select-all-matching, bulk actions, count-confirm, partial-failure UX"
```

---

## Notes for the executor
- **Backend tasks (1-3) are the high-value, fully-tested core** and are backend-neutral-verified. If time is short, these alone deliver a usable bulk API.
- **Frontend tasks (4-5)** lean on static markup + pure-function tests because this repo has no Angular/DOM runtime harness (same constraint as PR #54). The click/reveal wiring is a **manual pre-merge check** — say so in the PR, as #54 did.
- **PR target:** cross-fork `MIAuthors:<branch>` → `picup-physics/trinket-oss:main`, same as #53/#54 (push to `origin` over SSH; `gh pr create --repo picup-physics/trinket-oss --head MIAuthors:<branch>`).
- The list partials are `public/js/library/trinkets/list/list.html` (root) and `folder.html` (in-folder). The markup assertions read `list.html`.
