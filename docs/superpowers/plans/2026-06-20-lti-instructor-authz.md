# LTI Instructor Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grant `course-admin` on an LTI launch only when the LMS asserts an Instructor role AND the launcher is an approved instructor/admin in trinket's records — re-evaluated every launch — while keeping the feature portable to upstream mongo/redis.

**Architecture:** A standalone `ltiInstructorAuthority` seam (gcr → `instructormi` Datastore via existing `instructorAuth`; oss → `default` trust-the-platform) answers "is this launcher a trinket instructor?". The launch controller intersects that with the parsed LMS role to pick the course role, stamps the user's global `isInstructor` like Google signup does, and sets the enrolment (upgrade/downgrade) without touching course ownership.

**Tech Stack:** Node.js, Hapi, `config` (YAML), Firestore (gcr) / mongoose (oss), `@google-cloud/datastore` (gcr-only). Tests are standalone node scripts run in-container.

## Global Constraints

- Branch: `lti-1.3`. Each task's **Commit** step runs the shown `git add` then `git commit -m "<message>"` (the message is given as a `#` comment in the step). Committing `trinket-gcr` directly is fine.
- Portability: role/authz logic MUST depend only on the abstract authority interface — never `require` `instructorAuth` or `@google-cloud/datastore` outside the gcr impl file.
- Seam naming follows existing siblings (`ltiNonceStore`, `ltiVerify`): `lib/util/ltiInstructorAuthority.js` (selector) + `-default.js` / `-instructormi.js` impls.
- Authority interface (exact): `resolveInstructor({ email, lmsTeacher }) → Promise<boolean>`. `email` is a lowercased string or `''`; `lmsTeacher` is a boolean.
- Fail closed: any authority error → treat as `false` (→ `course-student`).
- Tests run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js` (test file is gitignored by the `test-*.js` rule). A passing run prints `ALL PASS` and exits 0; a failure prints `FAIL: <case>` and exits 1.
- Reuse, don't duplicate: `instructorAuth.isAdminEmail`, `instructorAuth.isApprovedInstructor`, `course.addUser`, `course.updateRole` already exist.

---

### Task 1: `ltiRoles.isTeacherRole` (pure LMS-claim parsing)

**Files:**
- Modify: `lib/util/ltiRoles.js`
- Test: `scripts/test-lti-instructor-authz.js` (create; this task adds the first cases)

**Interfaces:**
- Produces: `ltiRoles.isTeacherRole(rolesClaim) → boolean` (true if any role matches `#(Instructor|TeachingAssistant|ContentDeveloper)$`). `ltiRoles.mapCourseRole` stays exported and is re-expressed in terms of it (backward-compatible for existing `scripts/test-lti-launch.js`).

- [ ] **Step 1: Write the failing test** — create `scripts/test-lti-instructor-authz.js`:

```js
#!/usr/bin/env node
// scripts/test-lti-instructor-authz.js — self-tests for LTI instructor authorization.
// Run in-container: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js
'use strict';
var assert = require('assert');
var ROOT = '/usr/local/node/trinket/lib/';
var failures = [];
function check(name, fn) { try { fn(); console.log('  ok  ' + name); } catch (e) { failures.push(name); console.log('FAIL: ' + name + ' — ' + e.message); } }

// ── Task 1: ltiRoles.isTeacherRole ────────────────────────────────────────────
var ltiRoles = require(ROOT + 'util/ltiRoles');
var INSTR = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';
var LEARN = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
var TA    = 'http://purl.imsglobal.org/vocab/lis/v2/membership#TeachingAssistant';
check('isTeacherRole: Instructor → true',  function () { assert.strictEqual(ltiRoles.isTeacherRole([INSTR]), true); });
check('isTeacherRole: TA → true',          function () { assert.strictEqual(ltiRoles.isTeacherRole([TA]), true); });
check('isTeacherRole: Learner → false',    function () { assert.strictEqual(ltiRoles.isTeacherRole([LEARN]), false); });
check('isTeacherRole: string claim',       function () { assert.strictEqual(ltiRoles.isTeacherRole(INSTR), true); });
check('isTeacherRole: empty → false',      function () { assert.strictEqual(ltiRoles.isTeacherRole(undefined), false); });
check('mapCourseRole still works',         function () { assert.strictEqual(ltiRoles.mapCourseRole([INSTR]), 'course-admin'); assert.strictEqual(ltiRoles.mapCourseRole([LEARN]), 'course-student'); });

// (later tasks append their cases here)

console.log(failures.length ? ('\nFAILURES: ' + failures.length) : '\nALL PASS');
process.exit(failures.length ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: FAIL on `isTeacherRole: *` (`ltiRoles.isTeacherRole is not a function`).

- [ ] **Step 3: Implement `isTeacherRole` and re-express `mapCourseRole`** — replace the body of `lib/util/ltiRoles.js`:

```js
// Map the LTI `roles` claim to trinket course roles (LTI-SPEC §8.4).
//   Instructor / TeachingAssistant / ContentDeveloper count as "teacher" roles.
var TEACHER_RE = /#(Instructor|TeachingAssistant|ContentDeveloper)$/;

function isTeacherRole(rolesClaim) {
  var roles = Array.isArray(rolesClaim) ? rolesClaim : (rolesClaim ? [rolesClaim] : []);
  return roles.some(function (r) { return TEACHER_RE.test(r); });
}

// Back-compat: pure LMS-claim → role (no instructor-authority intersection). The launch
// controller no longer calls this; it combines isTeacherRole with ltiInstructorAuthority.
function mapCourseRole(rolesClaim) {
  return isTeacherRole(rolesClaim) ? 'course-admin' : 'course-student';
}

module.exports = { isTeacherRole: isTeacherRole, mapCourseRole: mapCourseRole };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: the six Task-1 cases print `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiRoles.js     # test-lti-instructor-authz.js is gitignored
# commit message: "lti: add ltiRoles.isTeacherRole (pure LMS-claim parse)"
```

---

### Task 2: `ltiInstructorAuthority` seam — default impl

**Files:**
- Create: `lib/util/ltiInstructorAuthority-default.js`
- Test: `scripts/test-lti-instructor-authz.js` (append cases)

**Interfaces:**
- Produces: module exporting `resolveInstructor({ email, lmsTeacher }) → Promise<boolean>`. Default policy: if `process.env.LTI_INSTRUCTOR_EMAILS` (JSON array of lowercased emails) is set, return whether `email` is in it; otherwise return `lmsTeacher` (trust-the-platform).

- [ ] **Step 1: Write the failing test** — append to `scripts/test-lti-instructor-authz.js` (before the summary lines):

```js
// ── Task 2: default authority (trust-platform + env list) ─────────────────────
(function () {
  delete process.env.LTI_INSTRUCTOR_EMAILS;
  var def = require(ROOT + 'util/ltiInstructorAuthority-default');
  check('default: teacher launch → true', function () {
    return def.resolveInstructor({ email: 'x@u.edu', lmsTeacher: true }).then(function (r) { assert.strictEqual(r, true); });
  }());
  check('default: learner launch → false', function () {
    return def.resolveInstructor({ email: 'x@u.edu', lmsTeacher: false }).then(function (r) { assert.strictEqual(r, false); });
  }());
})();
(function () {
  process.env.LTI_INSTRUCTOR_EMAILS = JSON.stringify(['allow@u.edu']);
  delete require.cache[require.resolve(ROOT + 'util/ltiInstructorAuthority-default')];
  var def = require(ROOT + 'util/ltiInstructorAuthority-default');
  check('default+envlist: listed teacher → true', function () {
    return def.resolveInstructor({ email: 'allow@u.edu', lmsTeacher: true }).then(function (r) { assert.strictEqual(r, true); });
  }());
  check('default+envlist: unlisted teacher → false', function () {
    return def.resolveInstructor({ email: 'nope@u.edu', lmsTeacher: true }).then(function (r) { assert.strictEqual(r, false); });
  }());
  delete process.env.LTI_INSTRUCTOR_EMAILS;
})();
```

Note: `check` cases that perform async work return a promise; this test file runs them eagerly and they settle before the synchronous summary because each `resolveInstructor` resolves on the microtask queue after all `check` calls — to keep ordering simple, wrap the summary in `setImmediate`. Update the summary lines at the bottom of the file to:

```js
setImmediate(function () {
  console.log(failures.length ? ('\nFAILURES: ' + failures.length) : '\nALL PASS');
  process.exit(failures.length ? 1 : 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: FAIL — `Cannot find module '.../ltiInstructorAuthority-default'`.

- [ ] **Step 3: Implement** — create `lib/util/ltiInstructorAuthority-default.js`:

```js
// Default (oss/upstream) instructor-authority: trust the platform. No GCP / Datastore dependency.
// If LTI_INSTRUCTOR_EMAILS (JSON array of lowercased emails) is set, gate on that list instead.
'use strict';

function envList() {
  if (!process.env.LTI_INSTRUCTOR_EMAILS) return null;
  try {
    var arr = JSON.parse(process.env.LTI_INSTRUCTOR_EMAILS);
    return Array.isArray(arr) ? arr.map(function (e) { return String(e).toLowerCase(); }) : null;
  } catch (e) { return null; }
}

function resolveInstructor(ctx) {
  var email = (ctx && ctx.email || '').toLowerCase();
  var list  = envList();
  if (list) return Promise.resolve(email !== '' && list.indexOf(email) >= 0);
  return Promise.resolve(!!(ctx && ctx.lmsTeacher));
}

module.exports = { resolveInstructor: resolveInstructor };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: the four Task-2 cases print `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiInstructorAuthority-default.js
# message: "lti: default instructor-authority (trust-platform + env list)"
```

---

### Task 3: `ltiInstructorAuthority` seam — instructormi impl + selector

**Files:**
- Create: `lib/util/ltiInstructorAuthority-instructormi.js`
- Create: `lib/util/ltiInstructorAuthority.js` (selector)
- Test: `scripts/test-lti-instructor-authz.js` (append cases)

**Interfaces:**
- Consumes: `instructorAuth.isAdminEmail(email) → bool`, `instructorAuth.isApprovedInstructor(email) → Promise<bool>` (from `lib/util/instructorAuth.js`).
- Produces:
  - `ltiInstructorAuthority-instructormi.js`: `resolveInstructor({ email }) → Promise<boolean>` = `isAdminEmail(email) || await isApprovedInstructor(email)`; **fail-closed** (any throw → `false`). Role-independent (ignores `lmsTeacher`).
  - `ltiInstructorAuthority.js`: re-exports the impl chosen by `config.lti.instructorAuthority` (`"instructormi"` → instructormi file; anything else / unset → default file).

- [ ] **Step 1: Write the failing test** — append cases that inject a fake `instructorAuth` via the require cache, then load the instructormi impl and the selector:

```js
// ── Task 3: instructormi authority + selector ─────────────────────────────────
(function () {
  // Inject a fake instructorAuth into the module cache BEFORE requiring the impl.
  var iaPath = require.resolve(ROOT + 'util/instructorAuth');
  require.cache[iaPath] = { id: iaPath, filename: iaPath, loaded: true, exports: {
    isAdminEmail: function (e) { return e === 'admin@u.edu'; },
    isApprovedInstructor: function (e) { return Promise.resolve(e === 'prof@u.edu'); }
  } };
  delete require.cache[require.resolve(ROOT + 'util/ltiInstructorAuthority-instructormi')];
  var imi = require(ROOT + 'util/ltiInstructorAuthority-instructormi');
  check('instructormi: admin → true',           function () { return imi.resolveInstructor({ email: 'admin@u.edu', lmsTeacher: false }).then(function (r) { assert.strictEqual(r, true); }); }());
  check('instructormi: listed prof → true',      function () { return imi.resolveInstructor({ email: 'prof@u.edu', lmsTeacher: true }).then(function (r) { assert.strictEqual(r, true); }); }());
  check('instructormi: unlisted → false',        function () { return imi.resolveInstructor({ email: 'rando@u.edu', lmsTeacher: true }).then(function (r) { assert.strictEqual(r, false); }); }());
  // selector honors config: stub config to instructormi
  var cfgPath = require.resolve('config');
  var realCfg = require.cache[cfgPath];
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { lti: { instructorAuthority: 'instructormi' } } };
  delete require.cache[require.resolve(ROOT + 'util/ltiInstructorAuthority')];
  var sel = require(ROOT + 'util/ltiInstructorAuthority');
  check('selector picks instructormi', function () { return sel.resolveInstructor({ email: 'prof@u.edu', lmsTeacher: false }).then(function (r) { assert.strictEqual(r, true); }); }());
  require.cache[cfgPath] = realCfg;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: FAIL — `Cannot find module '.../ltiInstructorAuthority-instructormi'`.

- [ ] **Step 3: Implement the instructormi impl** — create `lib/util/ltiInstructorAuthority-instructormi.js`:

```js
// gcr instructor-authority: consult the instructormi allowlist (Datastore) via instructorAuth.
// Loaded ONLY when config.lti.instructorAuthority === 'instructormi'; carries the @google-cloud
// /datastore dependency that must never reach oss. Role-independent (trusts trinket's own list).
'use strict';
var instructorAuth = require('./instructorAuth');

function resolveInstructor(ctx) {
  var email = (ctx && ctx.email || '').toLowerCase();
  if (email === '') return Promise.resolve(false);
  if (instructorAuth.isAdminEmail(email)) return Promise.resolve(true);
  return Promise.resolve(instructorAuth.isApprovedInstructor(email))
    .catch(function () { return false; });   // fail closed
}

module.exports = { resolveInstructor: resolveInstructor };
```

- [ ] **Step 4: Implement the selector** — create `lib/util/ltiInstructorAuthority.js`:

```js
// Instructor-authority seam selector. Like backend-factory / ltiNonceStore, the deployment picks
// the impl by config. gcr deployments set config.lti.instructorAuthority = 'instructormi'; oss
// (and the default) get the trust-the-platform impl. Role/authz logic depends only on this module.
'use strict';
var config = require('config');
var which  = (config.lti && config.lti.instructorAuthority) || 'default';
module.exports = (which === 'instructormi')
  ? require('./ltiInstructorAuthority-instructormi')
  : require('./ltiInstructorAuthority-default');
```

- [ ] **Step 5: Run test to verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: the four Task-3 cases print `ok`.

- [ ] **Step 6: Commit**

```bash
git add lib/util/ltiInstructorAuthority.js lib/util/ltiInstructorAuthority-instructormi.js
# message: "lti: instructormi instructor-authority + config-selected seam"
```

---

### Task 4: Config — add `lti.instructorAuthority`

**Files:**
- Modify: `config/default.yaml` (oss/base default = `default`)
- Modify: `config/cloudrun.yaml`, `config/production-cloudrun.yaml` (gcr = `instructormi`)

**Interfaces:**
- Produces: `config.lti.instructorAuthority` resolves to `"default"` for a base/oss config and `"instructormi"` under the gcr cloudrun configs.

- [ ] **Step 1: Add the default key** — append to `config/default.yaml` (top level, matching existing 2-space YAML; place after the `app:` block):

```yaml
lti:
  # Which instructor-authority impl resolves "is this launcher a trinket instructor?":
  #   'default'     → trust the LMS Instructor role (or LTI_INSTRUCTOR_EMAILS if set). Portable; oss.
  #   'instructormi'→ consult the instructormi approved-instructor Datastore (gcr only).
  instructorAuthority: default
```

- [ ] **Step 2: Override for gcr** — add to BOTH `config/cloudrun.yaml` and `config/production-cloudrun.yaml` (top level):

```yaml
lti:
  instructorAuthority: instructormi
```

- [ ] **Step 3: Verify config resolution** — run a one-off:

```bash
docker exec trinket-gcr node -e "var c=require('config'); console.log('lti.instructorAuthority =', (c.lti&&c.lti.instructorAuthority));"
```
Expected: prints `lti.instructorAuthority = default` (the local testbed runs NODE_ENV=development → default.yaml). gcr deploys load cloudrun.yaml → `instructormi`.

- [ ] **Step 4: Commit**

```bash
git add config/default.yaml config/cloudrun.yaml config/production-cloudrun.yaml
# message: "config: add lti.instructorAuthority (default; instructormi on cloudrun)"
```

---

### Task 5: `ltiProvision` — stamp `approved`/`isInstructor` every launch

**Files:**
- Modify: `lib/util/ltiProvision.js`
- Test: `scripts/test-lti-instructor-authz.js` (append cases)

**Interfaces:**
- Consumes: `User` model (`approved`, `isInstructor`, `.save()`).
- Produces: `provisionUser(claims, platform, opts) → Promise<user>` where `opts.isInstructor` (boolean, default `false`) is stamped onto the resolved user along with `approved: true`, and the user is saved on EVERY call (new or existing). Existing 3-step resolution (identity → email-link → create) is unchanged; the stamping happens just before returning.

- [ ] **Step 1: Write the failing test** — append cases that drive `provisionUser` against fakes (stub `User`, `LtiUserIdentity`, `./user` util via require cache), asserting `isInstructor` is stamped on both a freshly-created and a pre-existing user:

```js
// ── Task 5: provisionUser stamps approved/isInstructor every launch ────────────
(function () {
  var saved = [];
  function FakeUser(props) { Object.assign(this, props); this.id = props.id || 'u-new'; }
  FakeUser.prototype.save = function () { saved.push({ id: this.id, approved: this.approved, isInstructor: this.isInstructor }); return Promise.resolve(this); };
  FakeUser.findByLogin = function (e, cb) { cb(null, null); };           // no email match
  FakeUser.findById = function (id) { return Promise.resolve(new FakeUser({ id: id })); };
  var idStore = { rec: null };
  var FakeIdentity = function (p) { Object.assign(this, p); FakeIdentity._saved = this; };
  FakeIdentity.prototype.save = function () { return Promise.resolve(this); };
  FakeIdentity.findByIssSub = function () { return Promise.resolve(idStore.rec); };
  require.cache[require.resolve(ROOT + 'models/user')] = { id: 'u', filename: 'u', loaded: true, exports: FakeUser };
  require.cache[require.resolve(ROOT + 'models/ltiUserIdentity')] = { id: 'i', filename: 'i', loaded: true, exports: FakeIdentity };
  require.cache[require.resolve(ROOT + 'util/user')] = { id: 'uu', filename: 'uu', loaded: true, exports: { generate_username_with_suffix: function (s) { return s + '-1'; } } };
  delete require.cache[require.resolve(ROOT + 'util/ltiProvision')];
  var prov = require(ROOT + 'util/ltiProvision');
  var claims = { iss: 'https://lms', sub: 'sub-1', email: 'Prof@U.edu', name: 'Prof' };

  check('provision (new) stamps isInstructor=true', function () {
    saved.length = 0; idStore.rec = null;
    return prov.provisionUser(claims, { trustEmail: false }, { isInstructor: true }).then(function (u) {
      assert.strictEqual(u.isInstructor, true); assert.strictEqual(u.approved, true);
      assert.ok(saved.some(function (s) { return s.isInstructor === true && s.approved === true; }), 'user saved with stamp');
    });
  }());
  check('provision (existing) re-stamps isInstructor=false', function () {
    saved.length = 0;
    idStore.rec = { userId: 'u-existing', save: function () { return Promise.resolve(this); } };
    return prov.provisionUser(claims, { trustEmail: false }, { isInstructor: false }).then(function (u) {
      assert.strictEqual(u.isInstructor, false); assert.strictEqual(u.approved, true);
    });
  }());
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: FAIL — `provision (existing) re-stamps...` (current code returns the existing user without stamping/saving), and/or `isInstructor` undefined.

- [ ] **Step 3: Implement** — in `lib/util/ltiProvision.js`, change the signature and add a final stamp step. Replace the function header line:

```js
function provisionUser(claims, platform) {
```
with:
```js
function provisionUser(claims, platform, opts) {
  var isInstructor = !!(opts && opts.isInstructor);
```

Then replace the final `.then(function(ctx) { ... ensure identity link ... return ctx.user; })` tail so the resolved user is always stamped + saved before returning. Concretely, change the last `.then` block to:

```js
  }).then(function (ctx) {
    // ensure the (iss, sub) -> user link exists / is current
    var linkP;
    if (!ctx.identity) {
      var rec = new LtiUserIdentity({ iss: iss, sub: sub, userId: ctx.user.id, email: email || undefined, name: name });
      linkP = Promise.resolve(rec.save());
    } else if (ctx.identity.userId !== ctx.user.id) {
      ctx.identity.userId = ctx.user.id;
      linkP = Promise.resolve(ctx.identity.save());
    } else {
      linkP = Promise.resolve();
    }
    return linkP.then(function () {
      // Mirror Google signup: an LTI launch comes from a trusted platform (approved), and the
      // launcher's instructor status is whatever the authority resolved — re-stamped every launch.
      ctx.user.approved = true;
      ctx.user.isInstructor = isInstructor;
      return Promise.resolve(ctx.user.save()).then(function () { return ctx.user; });
    });
  });
```

(Keep the create branch as-is; the new tail re-stamps for both new and existing users.)

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: the two Task-5 cases print `ok`. (Re-run `scripts/test-lti-provision.js` too; update its `provisionUser` calls if it asserts the old 2-arg signature — pass `{}` as the third arg.)

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiProvision.js
# message: "lti: provisionUser stamps approved/isInstructor every launch"
```

---

### Task 6: Launch controller — resolve authority, set role (owner-protected)

**Files:**
- Modify: `lib/controllers/lti.js` (the launch handler block around lines 124–145)
- Test: `scripts/test-lti-instructor-authz.js` (append the role-matrix + re-evaluation + owner cases)

**Interfaces:**
- Consumes: `ltiRoles.isTeacherRole`, `ltiInstructorAuthority.resolveInstructor`, `ltiProvision.provisionUser(claims, platform, { isInstructor })`, `course.addUser(user, [role])`, `course.updateRole(user, role)`, `course.ownerSlug`, `user.username`.
- Produces: launch enrols/updates the member to `course-admin` iff `isTeacherRole && isInstructor`, else `course-student`; never downgrades the course owner; passes the resolved `isInstructor` into `provisionUser`.

- [ ] **Step 1: Write the failing test.**

The launch handler runs full §7 JWT verification (state sig, JWKS, iss/aud/exp, nonce, deployment, message_type, version) *before* the enrol block we're changing. `scripts/test-lti-launch.js` already builds that whole signed-id_token harness. **Create `scripts/test-lti-launch-authz.js` by copying `scripts/test-lti-launch.js`**, then make these exact edits so it exercises the new role logic:

(a) After the existing require-shim block, ALSO shim `ltiInstructorAuthority` and capture course role calls. Add:

```js
// controllable authority result for this run
var authzResult = false;
require.cache[require.resolve('/usr/local/node/trinket/lib/util/ltiInstructorAuthority')] = {
  id: 'authz', filename: 'authz', loaded: true,
  exports: { resolveInstructor: function () { return Promise.resolve(authzResult); } }
};
```

(b) Replace the harness's `makeCourse()` so it records role changes and supports a preset role + owner:

```js
var enrolCalls = [];   // sequence of roles applied
function makeCourse(opts) {
  opts = opts || {};
  var existing = opts.existingRole || null;
  return {
    id: 'c1', ownerSlug: opts.ownerSlug || 'prof', slug: 'phys101',
    addUser: function (u, roles) { if (!existing) { existing = roles[0]; enrolCalls.push('add:' + roles[0]); } return Promise.resolve({}); },
    updateRole: function (u, role) { existing = role; enrolCalls.push('update:' + role); return Promise.resolve({}); }
  };
}
```

(c) Make `fakeProvision.provisionUser` accept the 3rd arg and return a username we control:

```js
var launcherName = 'stu-1';
var fakeProvision = { provisionUser: function (claims, platform, opts) { return Promise.resolve({ id: 'u-1', username: launcherName, email: claims.email }); } };
```

(d) Add a helper that signs a valid launch with a chosen roles claim, runs `lti.launch`, and returns the final role applied (`enrolCalls` last entry). Then assert each case:

```js
// roles: pass [INSTR] or [LEARN]; authz: true/false; existingRole/ownerSlug via course opts
function runCase(name, opts) {
  authzResult = opts.authz; launcherName = opts.launcher || 'stu-1'; enrolCalls = [];
  currentTarget = { course: makeCourse({ existingRole: opts.existingRole, ownerSlug: opts.ownerSlug }) };
  return signAndLaunch(opts.roles).then(function () {
    check(name, function () { assert.strictEqual(opts.expectRole, enrolCalls.length ? enrolCalls[enrolCalls.length - 1].split(':')[1] : null); });
  });
}
// matrix
runCase('Instructor+approved → course-admin',    { roles: [INSTR], authz: true,  expectRole: 'course-admin' });
runCase('Instructor+unapproved → course-student', { roles: [INSTR], authz: false, expectRole: 'course-student' });
runCase('Learner+approved → course-student',      { roles: [LEARN], authz: true,  expectRole: 'course-student' });
runCase('Learner+unapproved → course-student',    { roles: [LEARN], authz: false, expectRole: 'course-student' });
// re-evaluation
runCase('upgrade student→admin',  { roles: [INSTR], authz: true,  existingRole: 'course-student', expectRole: 'course-admin' });
runCase('downgrade admin→student', { roles: [INSTR], authz: false, existingRole: 'course-admin',  expectRole: 'course-student' });
// owner-protected: launcher owns course, unapproved → no enrol/update call at all
authzResult = false; launcherName = 'prof'; enrolCalls = [];
currentTarget = { course: makeCourse({ ownerSlug: 'prof', existingRole: 'course-admin' }) };
signAndLaunch([INSTR]).then(function () { check('owner not downgraded', function () { assert.strictEqual(enrolCalls.length, 0); }); });
```

`signAndLaunch(rolesClaim)` is the existing harness's "sign a valid id_token and call `lti.launch`" routine — copy it from `test-lti-launch.js`'s happy-path case and parametrize the `roles` claim (`token[LTI+'roles'] = rolesClaim`) and include `email`/`sub` claims. Use the same `check(name, fn)`/summary scaffold as `scripts/test-lti-instructor-authz.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-launch-authz.js`
Expected: FAIL — current controller calls `ltiRoles.mapCourseRole` and `addUser` only (no authority, no updateRole, no owner guard).

- [ ] **Step 3: Implement** — in `lib/controllers/lti.js`, add the require near the other LTI requires (top of file, beside `ltiRoles`):

```js
var ltiInstructorAuthority = require('../util/ltiInstructorAuthority');
```

Then replace the provisioning/enrol block (the `return ltiProvision.provisionUser(claims, platform).then(...)` down through the `enrollP.then(...)`) with:

```js
            var email      = (claims.email || '').toLowerCase();
            var lmsTeacher = ltiRoles.isTeacherRole(claims[LTI + 'roles']);
            return ltiInstructorAuthority.resolveInstructor({ email: email, lmsTeacher: lmsTeacher })
              .catch(function () { return false; })   // fail closed
              .then(function (isInstructor) {
                var courseRole = (lmsTeacher && isInstructor) ? 'course-admin' : 'course-student';
                return ltiProvision.provisionUser(claims, platform, { isInstructor: isInstructor }).then(function (user) {
                  return ltiTarget.resolveTarget(claims, platform).then(function (target) {
                    var redirectPath = '/welcome';
                    var enrollP = Promise.resolve();
                    if (target.course) {
                      redirectPath = '/' + target.course.ownerSlug + '/courses/' + target.course.slug;
                      var isOwner = target.course.ownerSlug === user.username;
                      if (!isOwner) {
                        // ensure enrolment, then set the (re-evaluated) role: addUser is a no-op
                        // for an existing member, updateRole adjusts it up or down.
                        enrollP = Promise.resolve(target.course.addUser(user, [courseRole]))
                          .then(function () { return target.course.updateRole(user, courseRole); });
                      }
                    }
                    return enrollP.then(function () {
                      request.yar.reset();
                      request.yar._logIn(user, function () {});
                      request.yar.flash('requested', user.username);
                      return reply().redirect(redirectPath);
                    });
                  });
                });
              });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-launch-authz.js`
Expected: all matrix + re-eval + owner cases print `ok`.

- [ ] **Step 5: Regression — existing launch harness**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-launch.js`
Expected: still passes. If it stubs `provisionUser` with a 2-arg fn or asserts `addUser` exact calls, update its fake to accept the 3rd arg and to also accept an `updateRole` call (add `updateRole: function(){}` to its fake course). Make that edit if needed, then re-run.

- [ ] **Step 6: Commit**

```bash
git add lib/controllers/lti.js
# message: "lti: launch enrols via instructor-authority intersection, re-eval, owner-protected"
```

---

### Task 7: Portability isolation test

**Files:**
- Test: `scripts/test-lti-instructor-authz.js` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: a guard that the default authority path never pulls in the gcr-only module.

- [ ] **Step 1: Write the test** — append a case that loads the selector with `config.lti.instructorAuthority` unset/`default` and asserts neither `ltiInstructorAuthority-instructormi` nor `@google-cloud/datastore` is in `require.cache` afterward:

```js
// ── Task 7: oss/default path does not load the gcr-only module ─────────────────
(function () {
  var cfgPath = require.resolve('config');
  var realCfg = require.cache[cfgPath];
  require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: { lti: { instructorAuthority: 'default' } } };
  ['ltiInstructorAuthority', 'ltiInstructorAuthority-instructormi', 'ltiInstructorAuthority-default'].forEach(function (m) {
    try { delete require.cache[require.resolve(ROOT + 'util/' + m)]; } catch (e) {}
  });
  try { delete require.cache[require.resolve(ROOT + 'util/instructorAuth')]; } catch (e) {}
  require(ROOT + 'util/ltiInstructorAuthority');
  check('default path does NOT load instructormi impl', function () {
    var loaded = Object.keys(require.cache).join('|');
    assert.ok(loaded.indexOf('ltiInstructorAuthority-instructormi') < 0, 'instructormi impl loaded');
    assert.ok(loaded.indexOf('@google-cloud/datastore') < 0, 'datastore loaded');
  });
  require.cache[cfgPath] = realCfg;
})();
```

- [ ] **Step 2: Run the full suite**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-instructor-authz.js`
Expected: `ALL PASS`, exit 0.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-06-20-lti-instructor-authz.md   # plan itself
# message: "lti: instructor-authz portability isolation test + plan"
```

---

### Task 8: Manual end-to-end verification (no code)

- [ ] **Step 1:** With trinket on `lti-1.3` (cookie fix already in) and a real launch source (Canvas or Moodle), seed a platform and ensure the local config uses the **instructormi** authority (temporarily set `config.lti.instructorAuthority: instructormi` in the testbed, or run with that override) so the real list is consulted.
- [ ] **Step 2:** Launch as an **Instructor whose email is on the `instructormi` list** → confirm `course-admin` (DB check: `course.users` role for that email = `course-admin`, and `user.isInstructor === true`).
- [ ] **Step 3:** Launch as an **Instructor NOT on the list** → confirm `course-student` and `user.isInstructor === false`.
- [ ] **Step 4:** Add that email to the list (or approve in `instructormi`), relaunch → confirm **upgrade** to `course-admin`. Remove/reject, relaunch → confirm **downgrade** to `course-student`. Owner of a course relaunching while unapproved → confirm role unchanged (owner-protected).
- [ ] **Step 5:** Report results to Steve; do not commit anything in this task.

---

## Notes for the implementer

- The whole feature is behind the `ltiInstructorAuthority` seam — if you ever find yourself importing `instructorAuth` or `@google-cloud/datastore` from `ltiRoles`, `ltiProvision`, or `lib/controllers/lti.js`, stop: that breaks oss portability. Only `ltiInstructorAuthority-instructormi.js` may touch them.
- `scripts/test-lti-instructor-authz.js` is gitignored (the `test-*.js` rule) — it won't be committed, which is consistent with the other `test-lti-*.js` harnesses.
- Committing `trinket-gcr` directly is fine — run each task's Commit step (`git add` + `git commit`).
