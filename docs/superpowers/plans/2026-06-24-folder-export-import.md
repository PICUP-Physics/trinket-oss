# Folder Export/Import Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a user's folder organization across a bulk export/import — re-importing restores each trinket to its folder.

**Architecture:** A trinket belongs to ≤1 folder, recorded in `trinket.folder`. The exporter writes that folder (`name` + `slug`) into each trinket's `metadata.json`; the importer reads it back and adds the trinket to a folder it reuses or creates per the existing "replace existing" checkbox. No separate folder manifest — folders carry no data beyond their name.

**Tech Stack:** Node, mongoose 6, the project's custom model layer (`lib/models/model.js`), `archiver` (export zip), `jszip` (import), Bull worker (export).

## Global Constraints

- Work on branch `test/import-export-minio` (has both the export worker harness and the importer). Export-side change later cherry-picks to the PR #15 branch (`export-trinket-instructions`); import-side to the PR #8 branch (`feature/course-import`).
- Mongoose-version-agnostic on the **export** side (it ships upstream): no `.stream()`, no callback queries — build objects only.
- Additive and backward-compatible: a trinket with no folder produces no `folder` key; an archive lacking `folder` imports exactly as today.
- Folder match key is **name, scoped to the user** (`{_owner, slug}` is uniquely indexed; slug derives from name, so name is effectively unique per owner).

## Testing approach

This code is integration-coupled (mongo + archiver/jszip + the Bull worker) and the repo's mocha suite has pre-existing breaks, so verification is **integration on the Docker/MinIO stack**, not mocha unit tests. Each task ends with a concrete, observable deliverable (zip contents or DB state). The stack is already running (`docker compose up -d`); `mongodb` is reachable via `docker exec mongodb mongosh trinket`.

---

### Task 1: Folder lookup helper (`findByOwnerAndName`)

**Files:**
- Modify: `lib/models/folder.js` (add a classMethod near `findByOwner`)

**Interfaces:**
- Produces: `Folder.findByOwnerAndName(user, name) -> Promise<folder|null>` — used by Task 3.

- [ ] **Step 1: Add the classMethod function** (next to `findByOwner`, ~line 20)

```javascript
function findByOwnerAndName(user, name) {
  // Match by name, scoped to the owner. slug is uniquely indexed per owner and
  // derived from name, so a user has at most one folder with a given name.
  return this.model.findOne({ _owner : user.id, name : name }).exec();
}
```

- [ ] **Step 2: Register it in `classMethods`** (in the `model.create('Folder', {...})` block)

```javascript
  , classMethods : {
      findByOwner        : findByOwner
    , findByOwnerAndName : findByOwnerAndName
    }
```

- [ ] **Step 3: Verify it loads + returns null for a missing name**

Run:
```bash
docker exec trinket node -e "
require('./config/db');
var Folder = require('./lib/models/folder');
var mongoose = require('mongoose');
mongoose.connection.once('open', function(){
  Folder.findByOwnerAndName({id:new mongoose.Types.ObjectId()}, 'nope')
    .then(function(f){ console.log('result:', f); process.exit(0); })
    .catch(function(e){ console.log('ERR', e.message); process.exit(1); });
});
"
```
Expected: `result: null` (no crash).

- [ ] **Step 4: Commit**

```bash
git add lib/models/folder.js
git commit -m "Add Folder.findByOwnerAndName lookup helper"
```

---

### Task 2: Export folder membership in `metadata.json`

**Files:**
- Modify: `lib/workers/exports.js` (the `.select(...)` in `createExportArchive`, and the `metadata` object in `addTrinketToArchive`)

**Interfaces:**
- Produces: each trinket's `metadata.json` gains `folder: { name, slug }` when the trinket has a folder. Task 3 consumes this.

- [ ] **Step 1: Add `folder` to the trinket select** (in `createExportArchive`)

Change:
```javascript
    .select('shortCode name description lang code assets settings created lastUpdated')
```
to:
```javascript
    .select('shortCode name description folder lang code assets settings created lastUpdated')
```

- [ ] **Step 2: Write `folder` into the metadata object** (in `addTrinketToArchive`, right after the `metadata` object is declared and before `archive.append(... 'metadata.json')`)

```javascript
  // Record the trinket's folder (membership rides on each trinket; a trinket
  // belongs to at most one folder). Reconstructed on import.
  if (trinket.folder && trinket.folder.name) {
    metadata.folder = { name: trinket.folder.name, slug: trinket.folder.folderSlug };
  }
```

- [ ] **Step 3: Syntax check**

Run: `node -c lib/workers/exports.js`
Expected: no output (valid).

- [ ] **Step 4: Verify end-to-end — folder appears in the exported zip**

Seed a folder + a trinket in it (mongo), then export and inspect:
```bash
# put the first trinket into a folder named "Physics 101"
docker exec mongodb mongosh trinket --quiet --eval '
var u = db.users.findOne({}, {_id:1, username:1});
var t = db.snippets.findOne({_owner:u._id});
var slug = "physics-101";
var fid = db.folders.insertOne({name:"Physics 101", slug:slug, ownerSlug:u.username, _owner:u._id, trinkets:[]}).insertedId;
db.snippets.updateOne({_id:t._id}, {$set:{folder:{folderId:fid, name:"Physics 101", folderSlug:slug, ownerSlug:u.username}}});
print("seeded folder on trinket", t.shortCode);
'
# restart worker to pick up new code, then trigger an export
docker compose restart app && sleep 6
docker exec mongodb mongosh trinket --quiet --eval 'db.exports.deleteMany({})'
docker exec trinket node scripts/trigger-export.js $(docker exec mongodb mongosh trinket --quiet --eval 'print(db.users.findOne().email||db.users.findOne().username)')
sleep 8
# pull the zip from the public bucket and check metadata.json
KEY=$(docker exec mongodb mongosh trinket --quiet --eval 'print(db.exports.findOne({status:"completed"}).s3Key)')
curl -s "http://localhost:9000/trinket-exports/$KEY" -o /tmp/fexp.zip
unzip -p /tmp/fexp.zip '*/metadata.json' | grep -A2 '"folder"'
```
Expected: a `metadata.json` containing `"folder": { "name": "Physics 101", "slug": "physics-101" }`.

- [ ] **Step 5: Commit** (this is the commit that later cherry-picks to PR #15)

```bash
git add lib/workers/exports.js
git commit -m "Include trinket folder membership in bulk export metadata"
```

---

### Task 3: Import folder membership (recreate/reuse + link)

**Files:**
- Modify: `lib/controllers/imports.js` (add `Folder` require; read `folder` in `readTrinketFromZip`; add `linkTrinketFolder` + `createImportedFolder` helpers; thread `user` into `importOneTrinket` and call the linker after each save)

**Interfaces:**
- Consumes: `Folder.findByOwnerAndName(user, name)` (Task 1); `metadata.folder` (Task 2); `folder.addTrinket(trinket, user)` and `new Folder({name})` + `setOwner` + `ownerSlug` (existing Folder model).
- Produces: imported trinkets are added to a folder (its `trinkets[]` entry + the trinket's `folder` back-ref) per the `replace` flag.

- [ ] **Step 1: Require the Folder model** (with the other model requires at the top of `imports.js`)

```javascript
var Folder   = require('../models/folder');
```

- [ ] **Step 2: Carry `folder` out of the zip** (in `readTrinketFromZip`'s returned object)

Add `folder : meta.folder,` to the returned `data` object (alongside `name`, `description`, `lang`, `code`, `settings`).

- [ ] **Step 3: Add the folder helpers** (above `importOneTrinket`)

```javascript
// Create a folder for the user during import. If the name's slug is already
// taken (unique per owner), suffix the name and retry — used for the
// "replace unchecked, folder exists" case (create a fresh folder).
function createImportedFolder(baseName, user, startAttempt) {
  function attempt(n) {
    var name = n > 1 ? baseName + ' (' + n + ')' : baseName;
    var folder = new Folder({ name: name });
    folder.setOwner(user);
    folder.ownerSlug = user.username;
    return folder.save()
      .then(function(saved) {
        return user.grant('folder-owner', 'folder', { id: saved.id })
          .then(function() { return saved; });
      })
      .catch(function(err) {
        if (err.code === 11000 && n < 50) return attempt(n + 1);
        throw err;
      });
  }
  return attempt(startAttempt || 1);
}

// Add an imported trinket to its folder. replace=true reuses an existing
// same-named folder; replace=false always creates a new (suffixed) one.
function linkTrinketFolder(trinket, folderMeta, user, replace) {
  if (!folderMeta || !folderMeta.name) return Promise.resolve();
  return Folder.findByOwnerAndName(user, folderMeta.name)
    .then(function(existing) {
      if (existing && replace) return existing;
      return createImportedFolder(folderMeta.name, user, existing ? 2 : 1);
    })
    .then(function(folder) {
      return folder.addTrinket(trinket, user).then(function() {
        trinket.folder = {
          folderId   : folder.id,
          name       : folder.name,
          folderSlug : folder.slug,
          ownerSlug  : folder.ownerSlug
        };
        return trinket.save();
      });
    });
}
```

- [ ] **Step 4: Thread `user` into `importOneTrinket` and link after each save**

Change the signature from `(zip, entry, userId, replace, results)` to `(zip, entry, user, replace, results)` and add `var userId = user.id;` at the top. Then, in **both** save paths, link the folder after the trinket is saved:

Replace path:
```javascript
            return existing.save().then(function(saved) {
              results.updated = (results.updated || 0) + 1;
              results.mapping[legacyShortCode] = saved.shortCode;
              return linkTrinketFolder(saved, data.folder, user, replace);
            });
```
New path:
```javascript
          return trinket.save().then(function(saved) {
            results.imported++;
            results.mapping[legacyShortCode] = saved.shortCode;
            return linkTrinketFolder(saved, data.folder, user, replace);
          });
```

- [ ] **Step 5: Update the caller** (in `importTrinkets`, where `importOneTrinket` is invoked)

Change the call to pass `request.user` instead of `userId`:
```javascript
          return importOneTrinket(ctx.zip, entry, request.user, replace, results);
```

- [ ] **Step 6: Syntax check**

Run: `node -c lib/controllers/imports.js`
Expected: no output (valid).

- [ ] **Step 7: Verify the round-trip on the Docker stack**

Using the zip from Task 2 (`/tmp/fexp.zip`), import it through the UI (Settings → import trinkets) — once with **replace unchecked**, once with **replace checked** — then inspect folders in mongo:
```bash
docker exec mongodb mongosh trinket --quiet --eval '
printjson(db.folders.find({}, {name:1, slug:1, "trinkets.shortCode":1}).toArray());
'
```
Expected:
- First import (replace **unchecked**) into the same account where "Physics 101" exists → a **new** folder `Physics 101 (2)` containing the imported trinket.
- Import (replace **checked**) → the imported trinket is added to the **existing** `Physics 101`, no duplicate folder.
- Import into a clean account → `Physics 101` is created and contains the trinket.

- [ ] **Step 8: Commit** (this is the commit that later cherry-picks to PR #8)

```bash
git add lib/controllers/imports.js
git commit -m "Restore trinket folder membership on import"
```

---

## Post-implementation (not part of task execution)

Once verified on `test/import-export-minio`:
- Cherry-pick the **Task 2** commit → `export-trinket-instructions` (updates upstream PR #15).
- Cherry-pick the **Task 1 + Task 3** commits → `feature/course-import` (updates fork PR #8). (Task 1's Folder helper is needed by the import side.)

## Self-review against the spec

- Export records `folder:{name,slug}` → Task 2. ✓
- Import recreates/reuses per replace checkbox (checked=reuse, unchecked=new suffixed, none=create) → Task 3 `linkTrinketFolder`/`createImportedFolder`. ✓
- Match by name scoped to user → Task 1 `findByOwnerAndName`. ✓
- Updates both `Folder.trinkets[]` and the trinket back-ref → Task 3 Step 3 (`addTrinket` + set `trinket.folder`). ✓
- Bulk path only; additive; mongoose-agnostic export → Global Constraints + Task 2. ✓
- No placeholders; every code step shows the code. ✓
