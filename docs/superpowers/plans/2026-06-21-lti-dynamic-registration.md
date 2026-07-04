# LTI Dynamic Registration (SP2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an approved instructor self-initiate a token-gated LMS registration that their LMS admin completes via the IMS LTI Dynamic Registration handshake, landing a `pending` platform a trinket admin activates — with no trinket-operator data entry.

**Architecture:** A new pure-ish `lib/util/ltiRegistration.js` seam holds all registration logic (build tool-config, SSRF-guarded fetch/POST to the platform, field mapping, token mint, platform activation). The `lti.js` controller gains `registerInit`/`registerComplete` (the LMS-facing handshake) and a `status`-gate on launch. Two thin UI surfaces — an instructor "Connect your LMS" page (gated through the `ltiInstructorAuthority` seam) and an admin `/admin/lti-registrations` subpage (gated by the unified site-admin role) — are thin wrappers over the service functions. The approval-record lookup stays behind the instructormi seam so the oss/mongo+redis build never loads `@google-cloud/datastore`.

**Tech Stack:** Node 20 (global `fetch`), Hapi 20, the project's `model.create` layer (Firestore backend in gcr, mongoose in oss), Nunjucks views, `crypto` for tokens, `dns` for SSRF guard. Tests are in-container `scripts/test-*.js` self-test scripts (gitignored) run via `docker exec`, matching the existing LTI test idiom.

## Global Constraints

- **Branch:** all work on `lti-1.3`. Commit frequently.
- **Portability:** new code MUST NOT `require('@google-cloud/datastore')` directly or transitively, except inside `lib/util/instructorAuth.js` / `lib/util/ltiInstructorAuthority-instructormi.js` (already quarantined). The oss `default` build must load and run every SP2 file except the instructormi authority impl.
- **Gate at the seam:** registration-initiation authorization calls `ltiInstructorAuthority.resolveInstructor({ email })`, never `instructorAuth.isApprovedInstructor` directly. Pass only `{ email }` (no `lmsTeacher`) so a bare trust-platform deploy fails closed.
- **Admin gate = role:** the activation subpage uses the existing `isAdmin(user)` pre-handler (`hasRole("admin")`), never an `isAdminEmail` check (see `docs/authority-model.md`).
- **Two query params never collide:** trinket's own gate is `reg_token`; the IMS param the LMS appends is `registration_token` (forwarded as a bearer to the platform, never consumed by trinket's gate).
- **v1 advertises `LtiResourceLinkRequest` only.** Register `token_endpoint_auth_method: "private_key_jwt"` + `jwks_uri`, but request **no** AGS scopes and no DeepLinking message.
- **Token hygiene:** 32 random bytes, sha256-at-rest (hex), single-use, default 7-day expiry, consumed only on a **successful** registration POST.
- **Firestore cost:** registration is rare (tens→hundreds total); writes are negligible, but still avoid needless reads/writes in any per-launch path (the `status` gate and `addDeployment` are the only launch-path additions; `addDeployment` writes only when the id is new).
- **Test idiom:** new tests are `scripts/test-<name>.js` (gitignored via the `test-*.js` rule), run with `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-<name>.js`. They print `N passed, M failed` and `process.exit(M ? 1 : 0)`. Stub collaborators with a `Module._load` require-shim (see `scripts/test-lti-launch.js`) or plain fakes.
- **Container note:** the running app caches `require`s; test scripts spawn fresh `node` so they see edits immediately, but any change exercised through the live server (the live testbed task) needs `docker restart trinket-gcr` first.

---

## File structure

| File | Responsibility |
| --- | --- |
| `lib/models/ltiPlatform.js` (modify) | add `status`/`registeredVia`/`productFamily`/`initiatedByEmail` + `addDeployment` |
| `lib/models/ltiRegistrationToken.js` (new) | single-use registration-token record + `findByHash` + validity |
| `lib/util/ltiRegistration.js` (new) | build tool-config, SSRF-guarded fetch/POST, field mapping, `mintRegistrationToken`, `activatePlatform` |
| `lib/controllers/lti.js` (modify) | `registerInit`, `registerComplete`, `status` gate on `loginInit`/`launch`, auto-deployment |
| `lib/controllers/connectLms.js` (new) | instructor "Connect your LMS" page (GET) + token mint (POST), thin over `mintRegistrationToken` |
| `lib/views/lti/connect-lms.html` (new) | the instructor page |
| `lib/views/lti/register-confirm.html` (new) | the LMS-admin confirm page (GET /lti/register) |
| `lib/views/lti/register-close.html` (new) | the IMS close page (POST /lti/register success) |
| `lib/views/lti/register-error.html` (new) | registration error page |
| `lib/controllers/admin.js` (modify) | `lti-registrations` dispatcher case + `activateLtiRegistration` handler |
| `lib/views/admin/includes/lti-registrations.html` (new) | the pending-list partial |
| `lib/views/admin/index.html` (modify) | add the nav tab |
| `lib/util/instructorAuth.js` (modify) | add `getInstructorRecord(email)` (Datastore query, returns full entity) |
| `lib/util/ltiInstructorAuthority-instructormi.js` (modify) | expose `getInstructorRecord` → delegates to instructorAuth |
| `lib/util/ltiInstructorAuthority-default.js` (modify) | expose `getInstructorRecord` → `Promise.resolve(null)` |
| `lib/util/helpers.js` (modify) | `canInitiateLtiRegistration(user)` async gate (server method) |
| `config/routes.js` (modify) | register the new routes |
| `scripts/seed-lti-platform.js` (modify) | set `status:'active'`, `registeredVia:'manual'` |

---

## Task 1: LtiPlatform model — registration fields + addDeployment

**Files:**
- Modify: `lib/models/ltiPlatform.js`
- Test: `scripts/test-lti-platform-model.js` (new, gitignored)

**Interfaces:**
- Consumes: the existing `model.create` layer; existing `findByIssuer`, `knowsDeployment`.
- Produces: `LtiPlatform` instances now carry `status` (`'pending'|'active'`, default `'pending'`), `registeredVia` (`'dynamic'|'manual'`), `productFamily` (String), `initiatedByEmail` (String); new objectMethod `addDeployment(deploymentId, cb)` → appends to `deploymentIds` and saves only if absent, callback `(err, platform)`.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-lti-platform-model.js`:

```js
#!/usr/bin/env node
// scripts/test-lti-platform-model.js (gitignored) — LtiPlatform new fields + addDeployment.
// Run: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-platform-model.js
'use strict';
var assert = require('assert');
var LtiPlatform = require('../lib/models/ltiPlatform');

var pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    function () { pass++; console.log('  ok   ' + name); },
    function (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e && e.message)); }
  );
}

Promise.resolve()
  .then(function () { return check('status defaults to pending', function () {
    var p = new LtiPlatform({ issuer: 'https://i', clientId: 'c', authLoginUrl: 'https://a', jwksUrl: 'https://j' });
    assert.strictEqual(p.status, 'pending');
  }); })
  .then(function () { return check('new fields are settable', function () {
    var p = new LtiPlatform({ issuer: 'https://i', clientId: 'c', authLoginUrl: 'https://a', jwksUrl: 'https://j',
      registeredVia: 'dynamic', productFamily: 'canvas', initiatedByEmail: 'prof@x.edu' });
    assert.strictEqual(p.registeredVia, 'dynamic');
    assert.strictEqual(p.productFamily, 'canvas');
    assert.strictEqual(p.initiatedByEmail, 'prof@x.edu');
  }); })
  .then(function () { return check('addDeployment appends new id and is idempotent', function () {
    var saves = 0;
    var p = new LtiPlatform({ issuer: 'https://i', clientId: 'c', authLoginUrl: 'https://a', jwksUrl: 'https://j' });
    p.save = function (cb) { saves++; cb(null, p); };           // stub persistence
    return new Promise(function (res, rej) {
      p.addDeployment('dep-1', function (e) { if (e) return rej(e);
        assert.deepStrictEqual(p.deploymentIds, ['dep-1']);
        assert.strictEqual(saves, 1);
        p.addDeployment('dep-1', function (e2) { if (e2) return rej(e2);
          assert.deepStrictEqual(p.deploymentIds, ['dep-1']);    // unchanged
          assert.strictEqual(saves, 1, 'no save when id already present');
          res();
        });
      });
    });
  }); })
  .then(function () { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-platform-model.js`
Expected: FAIL — `status defaults to pending` fails (field absent), `addDeployment` fails (`p.addDeployment is not a function`).

- [ ] **Step 3: Add the fields + method**

In `lib/models/ltiPlatform.js`, extend `schema` (after `trustEmail`):

```js
  trustEmail    : { type: Boolean, default: true },   // gate email-based account linking (§8.2)
  status        : { type: String, default: 'pending' }, // 'pending' | 'active'; launches honored only when 'active'
  registeredVia : { type: String },                     // 'dynamic' (Dynamic Registration) | 'manual' (seed script)
  productFamily : { type: String },                     // e.g. 'canvas', 'moodle' (from platform config)
  initiatedByEmail : { type: String }                   // approved instructor who generated the reg token
```

Add the objectMethod (next to `knowsDeployment`):

```js
// Append a deployment_id and save, only if not already present (idempotent — avoids a needless
// write on every re-launch from an already-known deployment). cb(err, platform).
function addDeployment(deploymentId, cb) {
  if (!Array.isArray(this.deploymentIds)) this.deploymentIds = [];
  if (this.deploymentIds.indexOf(deploymentId) >= 0) return cb(null, this);
  this.deploymentIds.push(deploymentId);
  return this.save(cb);
}
```

Register it in the `objectMethods` block:

```js
  objectMethods: {
    knowsDeployment: knowsDeployment,
    addDeployment: addDeployment
  },
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-platform-model.js`
Expected: `3 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/models/ltiPlatform.js
git commit -m "lti(dynreg): LtiPlatform status/registeredVia/productFamily/initiatedByEmail + addDeployment"
```

---

## Task 2: LtiRegistrationToken model

**Files:**
- Create: `lib/models/ltiRegistrationToken.js`
- Test: `scripts/test-lti-reg-token-model.js` (new, gitignored)

**Interfaces:**
- Consumes: `model.create`; `crypto`.
- Produces: `LtiRegistrationToken` model. Schema: `tokenHash` (String, required, hex sha256), `label` (String), `initiatedByEmail` (String), `expiresAt` (Date, required), `usedAt` (Date, default null), `platformId` (String, default null). Class method `findByHash(tokenHash, cb)` → `cb(err, doc|null)`. Object method `isValid()` → boolean (`usedAt == null && expiresAt > now`). Static helper `hashToken(raw)` → hex sha256 string.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-lti-reg-token-model.js`:

```js
#!/usr/bin/env node
// scripts/test-lti-reg-token-model.js (gitignored)
// Run: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-reg-token-model.js
'use strict';
var assert = require('assert');
var crypto = require('crypto');
var Token = require('../lib/models/ltiRegistrationToken');

var pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    function () { pass++; console.log('  ok   ' + name); },
    function (e) { fail++; console.log('  FAIL ' + name + ' -> ' + (e && e.message)); });
}

Promise.resolve()
  .then(function () { return check('hashToken is deterministic hex sha256', function () {
    var raw = 'abc';
    assert.strictEqual(Token.hashToken(raw), crypto.createHash('sha256').update(raw).digest('hex'));
  }); })
  .then(function () { return check('isValid: unused + future expiry -> true', function () {
    var t = new Token({ tokenHash: 'h', expiresAt: new Date(Date.now() + 60000) });
    assert.strictEqual(t.isValid(), true);
  }); })
  .then(function () { return check('isValid: expired -> false', function () {
    var t = new Token({ tokenHash: 'h', expiresAt: new Date(Date.now() - 1000) });
    assert.strictEqual(t.isValid(), false);
  }); })
  .then(function () { return check('isValid: used -> false', function () {
    var t = new Token({ tokenHash: 'h', expiresAt: new Date(Date.now() + 60000), usedAt: new Date() });
    assert.strictEqual(t.isValid(), false);
  }); })
  .then(function () { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-reg-token-model.js`
Expected: FAIL — `Cannot find module '../lib/models/ltiRegistrationToken'`.

- [ ] **Step 3: Create the model**

Create `lib/models/ltiRegistrationToken.js`:

```js
// Single-use, expiring token that gates GET/POST /lti/register. The raw token travels in the
// registration URL the instructor hands to their LMS admin; only its sha256 is stored. Consumed
// (usedAt + platformId set) on a SUCCESSFUL registration POST. See LTI Dynamic Registration (SP2).
var crypto = require('crypto');
var model  = require('./model');

var schema = {
  tokenHash        : { type: String, required: true },  // sha256(raw token), hex
  label            : { type: String },                  // human label, e.g. "UIndy Canvas"
  initiatedByEmail : { type: String },                  // approved instructor who generated it
  expiresAt        : { type: Date,   required: true },
  usedAt           : { type: Date,   default: null },
  platformId       : { type: String, default: null }    // set when consumed
};

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function findByHash(tokenHash, cb) {
  return this.model.findOne({ tokenHash: tokenHash }, cb);
}

function isValid() {
  return this.usedAt == null && this.expiresAt instanceof Date && this.expiresAt.getTime() > Date.now();
}

var LtiRegistrationToken = model.create('LtiRegistrationToken', {
  schema: schema,
  classMethods: {
    hashToken: hashToken,
    findByHash: findByHash
  },
  objectMethods: {
    isValid: isValid
  },
  index: [
    [{ tokenHash: 1 }, { unique: true }]
  ],
  publicSpec: {
    id: true, label: true, initiatedByEmail: true, expiresAt: true, usedAt: true, platformId: true
  }
}).publicModel;

module.exports = LtiRegistrationToken;
```

> Note: `hashToken` is a class method but is pure; the test calls it as `Token.hashToken(...)`. `findByHash` uses `this.model.findOne(query, cb)` exactly like `ltiPlatform.findByIssuer`.

- [ ] **Step 4: Run the test, verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-reg-token-model.js`
Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/models/ltiRegistrationToken.js
git commit -m "lti(dynreg): LtiRegistrationToken model (single-use, hashed, expiring)"
```

---

## Task 3: ltiRegistration — buildToolConfiguration + toPlatformFields (pure)

**Files:**
- Create: `lib/util/ltiRegistration.js`
- Test: `scripts/test-lti-registration-pure.js` (new, gitignored)

**Interfaces:**
- Consumes: `config` (`config.url`, `config.app`).
- Produces: `ltiRegistration.buildToolConfiguration()` → the OpenID-Client-Registration + LTI tool-config object; `ltiRegistration.toPlatformFields(openidConfig, registrationResponse)` → `{ issuer, authLoginUrl, authTokenUrl, jwksUrl, clientId, deploymentIds, productFamily, name }`. Later tasks add `fetchPlatformConfig`, `register`, `mintRegistrationToken`, `activatePlatform` to the same module.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-lti-registration-pure.js`:

```js
#!/usr/bin/env node
// scripts/test-lti-registration-pure.js (gitignored)
// Run: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-pure.js
'use strict';
var assert = require('assert');
var config = require('config');
var reg = require('../lib/util/ltiRegistration');

var BASE = config.url;  // e.g. https://tool.example
var LTI_TC = 'https://purl.imsglobal.org/spec/lti-tool-configuration';

var pass = 0, fail = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(
  function(){ pass++; console.log('  ok   '+name); },
  function(e){ fail++; console.log('  FAIL '+name+' -> '+(e&&e.message)); }); }

Promise.resolve()
  .then(function(){ return check('buildToolConfiguration: core OIDC fields', function(){
    var c = reg.buildToolConfiguration();
    assert.strictEqual(c.application_type, 'web');
    assert.deepStrictEqual(c.response_types, ['id_token']);
    assert.deepStrictEqual(c.grant_types, ['client_credentials', 'implicit']);
    assert.strictEqual(c.initiate_login_uri, BASE + '/lti/login');
    assert.deepStrictEqual(c.redirect_uris, [BASE + '/lti/launch']);
    assert.strictEqual(c.jwks_uri, BASE + '/lti/jwks');
    assert.strictEqual(c.token_endpoint_auth_method, 'private_key_jwt');
    assert.strictEqual(c.scope, '');
  }); })
  .then(function(){ return check('buildToolConfiguration: LTI tool-config block, ResourceLink only, no AGS', function(){
    var tc = reg.buildToolConfiguration()[LTI_TC];
    assert.strictEqual(tc.target_link_uri, BASE + '/lti/launch');
    assert.deepStrictEqual(tc.messages, [{ type: 'LtiResourceLinkRequest' }]);
    assert.ok(tc.claims.indexOf('email') >= 0);
    assert.ok(JSON.stringify(reg.buildToolConfiguration()).indexOf('Score') < 0); // no AGS scopes
  }); })
  .then(function(){ return check('toPlatformFields maps openid-config + registration response', function(){
    var openid = {
      issuer: 'https://canvas.test',
      authorization_endpoint: 'https://canvas.test/api/lti/authorize_redirect',
      token_endpoint: 'https://canvas.test/login/oauth2/token',
      jwks_uri: 'https://canvas.test/api/lti/security/jwks',
      'https://purl.imsglobal.org/spec/lti-platform-configuration': { product_family_code: 'canvas' }
    };
    var resp = { client_id: '10000000000123', 'https://purl.imsglobal.org/spec/lti-tool-configuration': { deployment_id: 'dep-9' } };
    var f = reg.toPlatformFields(openid, resp);
    assert.strictEqual(f.issuer, 'https://canvas.test');
    assert.strictEqual(f.authLoginUrl, 'https://canvas.test/api/lti/authorize_redirect');
    assert.strictEqual(f.authTokenUrl, 'https://canvas.test/login/oauth2/token');
    assert.strictEqual(f.jwksUrl, 'https://canvas.test/api/lti/security/jwks');
    assert.strictEqual(f.clientId, '10000000000123');
    assert.deepStrictEqual(f.deploymentIds, ['dep-9']);
    assert.strictEqual(f.productFamily, 'canvas');
  }); })
  .then(function(){ return check('toPlatformFields: no deployment_id -> empty array', function(){
    var f = reg.toPlatformFields({ issuer: 'https://i', authorization_endpoint: 'https://a', jwks_uri: 'https://j' }, { client_id: 'c' });
    assert.deepStrictEqual(f.deploymentIds, []);
  }); })
  .then(function(){ console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0); });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-pure.js`
Expected: FAIL — `Cannot find module '../lib/util/ltiRegistration'`.

- [ ] **Step 3: Create the module with the two pure functions**

Create `lib/util/ltiRegistration.js`:

```js
// LTI Dynamic Registration (SP2) — the testable seam. Pure-ish: builds the tool-configuration
// trinket POSTs to a platform, maps the platform's response onto LtiPlatform fields, and (in later
// tasks) performs the SSRF-guarded outbound fetch/POST and mints/activates records. No Hapi/HTTP
// framework coupling. Portable: no @google-cloud/datastore. Mirrors the ltiVerify/ltiTarget seams.
'use strict';
var config = require('config');

var LTI_TOOL_CONFIG     = 'https://purl.imsglobal.org/spec/lti-tool-configuration';
var LTI_PLATFORM_CONFIG = 'https://purl.imsglobal.org/spec/lti-platform-configuration';

// The OpenID Client Registration + LTI tool-config object trinket POSTs to the platform's
// registration_endpoint. v1: LtiResourceLinkRequest only; private_key_jwt + jwks_uri but NO AGS.
function buildToolConfiguration() {
  var base = config.url;
  var logo = base + '/img/logo.png';
  var doc = {
    application_type: 'web',
    response_types: ['id_token'],
    grant_types: ['client_credentials', 'implicit'],
    initiate_login_uri: base + '/lti/login',
    redirect_uris: [base + '/lti/launch'],
    jwks_uri: base + '/lti/jwks',
    client_name: 'Trinket',
    logo_uri: logo,
    token_endpoint_auth_method: 'private_key_jwt',
    scope: ''
  };
  doc[LTI_TOOL_CONFIG] = {
    domain: require('url').parse(base).host,
    target_link_uri: base + '/lti/launch',
    claims: ['iss', 'sub', 'name', 'given_name', 'family_name', 'email'],
    messages: [{ type: 'LtiResourceLinkRequest' }]
  };
  return doc;
}

// Map a platform's openid-configuration + registration response onto LtiPlatform fields.
function toPlatformFields(openidConfig, registrationResponse) {
  openidConfig = openidConfig || {};
  registrationResponse = registrationResponse || {};
  var platCfg = openidConfig[LTI_PLATFORM_CONFIG] || {};
  var toolCfg = registrationResponse[LTI_TOOL_CONFIG] || {};
  var productFamily = platCfg.product_family_code;
  var deploymentIds = toolCfg.deployment_id ? [toolCfg.deployment_id] : [];
  return {
    issuer: openidConfig.issuer,
    authLoginUrl: openidConfig.authorization_endpoint,
    authTokenUrl: openidConfig.token_endpoint,
    jwksUrl: openidConfig.jwks_uri,
    clientId: registrationResponse.client_id,
    deploymentIds: deploymentIds,
    productFamily: productFamily,
    name: productFamily ? (productFamily + ' (' + openidConfig.issuer + ')') : openidConfig.issuer
  };
}

module.exports = {
  buildToolConfiguration: buildToolConfiguration,
  toPlatformFields: toPlatformFields
};
```

> The `logo_uri` path (`/img/logo.png`) is best-effort; if the implementer finds the real logo asset path differs, use that — it does not affect any test.

- [ ] **Step 4: Run the test, verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-pure.js`
Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiRegistration.js
git commit -m "lti(dynreg): ltiRegistration buildToolConfiguration + toPlatformFields"
```

---

## Task 4: ltiRegistration — SSRF-guarded fetchPlatformConfig + register

**Files:**
- Modify: `lib/util/ltiRegistration.js`
- Test: `scripts/test-lti-registration-fetch.js` (new, gitignored)

**Interfaces:**
- Consumes: global `fetch` (Node 20), `dns`, `config.lti.allowPrivateRegistrationHosts` (boolean, default falsey).
- Produces:
  - `assertFetchableUrl(urlString)` → resolves (Promise) if https + host not private (or dev flag set); rejects `Error` otherwise.
  - `fetchPlatformConfig(openidConfigurationUrl)` → Promise of parsed JSON openid-config; SSRF-guarded; ~5s timeout; rejects on non-2xx/oversize/timeout.
  - `register(openidConfig, registrationToken)` → POSTs `buildToolConfiguration()` to `openidConfig.registration_endpoint` (SSRF-guarded) with `Authorization: Bearer <registrationToken>` when present and `Content-Type: application/json`; returns the parsed registration response; rejects on non-2xx.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-lti-registration-fetch.js`:

```js
#!/usr/bin/env node
// scripts/test-lti-registration-fetch.js (gitignored) — SSRF guard + fetch/register over a
// loopback HTTP server (allowed via the dev flag). Run:
//   docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-fetch.js
'use strict';
var assert = require('assert');
var http   = require('http');
process.env.NODE_CONFIG = JSON.stringify({ lti: { allowPrivateRegistrationHosts: true } });
var reg = require('../lib/util/ltiRegistration');

var pass = 0, fail = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(
  function(){ pass++; console.log('  ok   '+name); },
  function(e){ fail++; console.log('  FAIL '+name+' -> '+(e&&e.message)); }); }

function expectReject(p, msgMatch) {
  return p.then(function(){ throw new Error('expected rejection'); },
               function(e){ if (msgMatch && !(msgMatch.test(e.message))) throw new Error('wrong error: '+e.message); });
}

var server, BASE;
http.createServer(function (req, res) {
  if (req.url === '/.well-known/openid-configuration') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ issuer: 'https://platform.test', registration_endpoint: BASE + '/register' }));
  }
  if (req.url === '/register' && req.method === 'POST') {
    var chunks = '';
    req.on('data', function (d) { chunks += d; });
    return req.on('end', function () {
      var sent = JSON.parse(chunks);
      assert.ok(sent.jwks_uri, 'tool-config forwarded');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ client_id: 'CID-123', auth: req.headers.authorization || null }));
    });
  }
  res.statusCode = 404; res.end('nope');
}).listen(0, '127.0.0.1', function () {
  server = this; BASE = 'http://127.0.0.1:' + server.address().port;
  Promise.resolve()
    .then(function(){ return check('assertFetchableUrl allows loopback when dev flag on', function(){
      // (The flag-OFF private-IP/non-https rejection is covered by the isPrivateIp unit in Step 5 +
      // code review; re-requiring with the flag off in a child shim is heavy and omitted here.)
      return reg.assertFetchableUrl(BASE + '/x'); // flag ON -> loopback allowed -> resolves
    }); })
    .then(function(){ return check('fetchPlatformConfig returns parsed config', function(){
      return reg.fetchPlatformConfig(BASE + '/.well-known/openid-configuration').then(function (cfg) {
        assert.strictEqual(cfg.issuer, 'https://platform.test');
        assert.strictEqual(cfg.registration_endpoint, BASE + '/register');
      });
    }); })
    .then(function(){ return check('register POSTs tool-config with bearer and returns client_id', function(){
      return reg.register({ registration_endpoint: BASE + '/register' }, 'PLAT-TOKEN').then(function (r) {
        assert.strictEqual(r.client_id, 'CID-123');
        assert.strictEqual(r.auth, 'Bearer PLAT-TOKEN');
      });
    }); })
    .then(function(){ return check('register without token omits Authorization', function(){
      return reg.register({ registration_endpoint: BASE + '/register' }, null).then(function (r) {
        assert.strictEqual(r.auth, null);
      });
    }); })
    .then(function(){ console.log('\n'+pass+' passed, '+fail+' failed'); server.close(); process.exit(fail?1:0); })
    .catch(function(e){ console.error(e); server.close(); process.exit(1); });
});
```

> A separate, lighter unit asserts the private-IP block is active when the flag is OFF — added in Step 3's code comments and exercised by a second tiny script the implementer MAY add; the gate logic itself is covered by code review. The loopback test above runs with the flag ON (the real testbed configuration).

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-fetch.js`
Expected: FAIL — `reg.assertFetchableUrl is not a function` / `reg.fetchPlatformConfig is not a function`.

- [ ] **Step 3: Add the guarded fetch + register**

In `lib/util/ltiRegistration.js`, add near the top (after the `require('config')`):

```js
var dns = require('dns');
var urlmod = require('url');

var FETCH_TIMEOUT_MS = 5000;
var MAX_BYTES = 256 * 1024;

// RFC1918 / loopback / link-local / unique-local checks (v4 + v6).
function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.indexOf(':') >= 0) {  // IPv6
    var l = ip.toLowerCase();
    return l === '::1' || l.indexOf('fc') === 0 || l.indexOf('fd') === 0 || l.indexOf('fe80') === 0 || l === '::';
  }
  var o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(function (n) { return isNaN(n); })) return true;
  if (o[0] === 10) return true;
  if (o[0] === 127) return true;
  if (o[0] === 169 && o[1] === 254) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 0) return true;
  return false;
}

function allowPrivate() {
  return !!(config.lti && config.lti.allowPrivateRegistrationHosts);
}

// Resolve (Promise) iff the URL is https (or the dev flag is set) and its host does not resolve to a
// private/loopback/link-local address. Reject otherwise. Defense-in-depth against SSRF.
function assertFetchableUrl(urlString) {
  return new Promise(function (resolve, reject) {
    var u;
    try { u = new urlmod.URL(urlString); } catch (e) { return reject(new Error('Malformed registration URL')); }
    if (u.protocol !== 'https:' && !allowPrivate()) return reject(new Error('Registration endpoints must use https'));
    if (allowPrivate()) return resolve();   // dev/test: skip the DNS/private-range check
    dns.lookup(u.hostname, { all: true }, function (err, addrs) {
      if (err) return reject(new Error('Cannot resolve registration host'));
      var bad = (addrs || []).some(function (a) { return isPrivateIp(a.address); });
      if (bad) return reject(new Error('Registration host resolves to a disallowed address'));
      resolve();
    });
  });
}

function fetchWithLimits(urlString, options) {
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, FETCH_TIMEOUT_MS);
  options = Object.assign({ signal: ac.signal, redirect: 'error' }, options || {});
  return assertFetchableUrl(urlString)
    .then(function () { return fetch(urlString, options); })
    .then(function (res) {
      if (!res.ok) throw new Error('Registration endpoint returned HTTP ' + res.status);
      return res.text();
    })
    .then(function (text) {
      if (text.length > MAX_BYTES) throw new Error('Registration response too large');
      try { return JSON.parse(text); } catch (e) { throw new Error('Registration endpoint returned non-JSON'); }
    })
    .finally(function () { clearTimeout(timer); });
}

function fetchPlatformConfig(openidConfigurationUrl) {
  return fetchWithLimits(openidConfigurationUrl, { method: 'GET', headers: { accept: 'application/json' } });
}

function register(openidConfig, registrationToken) {
  var endpoint = openidConfig && openidConfig.registration_endpoint;
  if (!endpoint) return Promise.reject(new Error('Platform openid-config has no registration_endpoint'));
  var headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (registrationToken) headers.authorization = 'Bearer ' + registrationToken;
  return fetchWithLimits(endpoint, { method: 'POST', headers: headers, body: JSON.stringify(buildToolConfiguration()) });
}
```

Add the new names to `module.exports`:

```js
module.exports = {
  buildToolConfiguration: buildToolConfiguration,
  toPlatformFields: toPlatformFields,
  assertFetchableUrl: assertFetchableUrl,
  isPrivateIp: isPrivateIp,
  fetchPlatformConfig: fetchPlatformConfig,
  register: register
};
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-fetch.js`
Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Add a private-IP unit assertion and run it**

Append to the same script (before the server-dependent block is fine, since `isPrivateIp` is pure) OR run inline:

```bash
docker exec trinket-gcr node -e "
  var r = require('/usr/local/node/trinket/lib/util/ltiRegistration');
  var assert = require('assert');
  ['10.0.0.5','127.0.0.1','169.254.1.1','172.16.0.1','192.168.1.1','::1','fd00::1'].forEach(function(ip){ assert.strictEqual(r.isPrivateIp(ip), true, ip); });
  ['8.8.8.8','1.1.1.1','2606:4700::1111'].forEach(function(ip){ assert.strictEqual(r.isPrivateIp(ip), false, ip); });
  console.log('isPrivateIp ranges OK');
"
```
Expected: `isPrivateIp ranges OK`.

- [ ] **Step 6: Commit**

```bash
git add lib/util/ltiRegistration.js
git commit -m "lti(dynreg): SSRF-guarded fetchPlatformConfig + register (https, private-IP block, timeout, size cap, dev flag)"
```

---

## Task 5: ltiRegistration — mintRegistrationToken + activatePlatform

**Files:**
- Modify: `lib/util/ltiRegistration.js`
- Test: `scripts/test-lti-registration-service.js` (new, gitignored)

**Interfaces:**
- Consumes: `crypto`, `LtiRegistrationToken` (Task 2), `LtiPlatform` (Task 1), `config.url`.
- Produces:
  - `mintRegistrationToken({ label, ttlDays = 7, initiatedByEmail })` → Promise `{ rawToken, url }` where `url = config.url + '/lti/register?reg_token=' + rawToken`; persists one `LtiRegistrationToken` (`tokenHash = sha256(raw)`, `label`, `initiatedByEmail`, `expiresAt = now + ttlDays days`).
  - `activatePlatform(issuer, clientId)` → Promise of the updated platform; loads via `LtiPlatform.findByIssuer`, sets `status:'active'`, saves; rejects if not found, resolves the (already-active) platform if already active (idempotent).

- [ ] **Step 1: Write the failing test**

Create `scripts/test-lti-registration-service.js`:

```js
#!/usr/bin/env node
// scripts/test-lti-registration-service.js (gitignored) — mintRegistrationToken + activatePlatform
// with LtiRegistrationToken and LtiPlatform stubbed via a require-shim.
// Run: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-service.js
'use strict';
var assert = require('assert');
var crypto = require('crypto');

var saved = [];
function FakeToken(props) { Object.assign(this, props); }
FakeToken.prototype.save = function (cb) { saved.push(this); if (cb) cb(null, this); return Promise.resolve(this); };
FakeToken.hashToken = function (raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); };

var platforms = {};   // issuer -> platform
function FakePlatform(p) { Object.assign(this, p); }
FakePlatform.findByIssuer = function (issuer, clientId, cb) {
  if (typeof clientId === 'function') { cb = clientId; }
  cb(null, platforms[issuer] || null);
};

var Module = require('module'), orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (/models\/ltiRegistrationToken$/.test(request)) return FakeToken;
  if (/models\/ltiPlatform$/.test(request)) return FakePlatform;
  return orig.apply(this, arguments);
};
var config = require('config');
var reg = require('../lib/util/ltiRegistration');

var pass = 0, fail = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(
  function(){ pass++; console.log('  ok   '+name); },
  function(e){ fail++; console.log('  FAIL '+name+' -> '+(e&&e.message)); }); }

Promise.resolve()
  .then(function(){ return check('mintRegistrationToken persists hashed token and returns url', function(){
    return reg.mintRegistrationToken({ label: 'UIndy Canvas', initiatedByEmail: 'prof@uindy.edu' }).then(function (out) {
      assert.ok(/^[0-9a-f-]{20,}$/i.test(out.rawToken) || out.rawToken.length >= 32);
      assert.strictEqual(out.url, config.url + '/lti/register?reg_token=' + out.rawToken);
      assert.strictEqual(saved.length, 1);
      var t = saved[0];
      assert.strictEqual(t.tokenHash, FakeToken.hashToken(out.rawToken)); // raw never stored
      assert.strictEqual(t.initiatedByEmail, 'prof@uindy.edu');
      assert.ok(t.expiresAt.getTime() > Date.now() + 6 * 86400000); // ~7 days out
    });
  }); })
  .then(function(){ return check('activatePlatform flips pending -> active and saves', function(){
    var saves = 0;
    platforms['https://canvas.test'] = new FakePlatform({ issuer: 'https://canvas.test', clientId: 'c', status: 'pending',
      save: function (cb) { saves++; this.status = this.status; cb(null, this); } });
    return reg.activatePlatform('https://canvas.test', 'c').then(function (p) {
      assert.strictEqual(p.status, 'active');
      assert.strictEqual(saves, 1);
    });
  }); })
  .then(function(){ return check('activatePlatform rejects unknown platform', function(){
    return reg.activatePlatform('https://nope.test', 'c').then(
      function(){ throw new Error('expected rejection'); }, function(){ /* ok */ });
  }); })
  .then(function(){ console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0); });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-service.js`
Expected: FAIL — `reg.mintRegistrationToken is not a function`.

- [ ] **Step 3: Add the two service functions**

In `lib/util/ltiRegistration.js`, add `require`s at the top:

```js
var crypto = require('crypto');
```

Add the functions (before `module.exports`):

```js
// Mint a single-use registration token, persist its hash, and return the raw token + the URL the
// instructor hands to their LMS admin. DRY anchor: the Connect-your-LMS controller and any future
// CLI both call this — they do not re-implement token logic.
function mintRegistrationToken(opts) {
  opts = opts || {};
  var LtiRegistrationToken = require('../models/ltiRegistrationToken');
  var ttlDays = (typeof opts.ttlDays === 'number' && opts.ttlDays > 0) ? opts.ttlDays : 7;
  var rawToken = crypto.randomBytes(32).toString('base64url');
  var token = new LtiRegistrationToken({
    tokenHash: LtiRegistrationToken.hashToken(rawToken),
    label: opts.label,
    initiatedByEmail: opts.initiatedByEmail,
    expiresAt: new Date(Date.now() + ttlDays * 86400000)
  });
  return Promise.resolve(token.save()).then(function () {
    return { rawToken: rawToken, url: config.url + '/lti/register?reg_token=' + rawToken };
  });
}

// Activate a pending platform so its launches are honored. DRY anchor: the admin Approve handler and
// any future CLI both call this. Idempotent: already-active resolves; unknown rejects.
function activatePlatform(issuer, clientId) {
  var LtiPlatform = require('../models/ltiPlatform');
  return new Promise(function (resolve, reject) {
    LtiPlatform.findByIssuer(issuer, clientId, function (err, platform) {
      if (err) return reject(err);
      if (!platform) return reject(new Error('No registered platform for issuer ' + issuer));
      if (platform.status === 'active') return resolve(platform);
      platform.status = 'active';
      platform.save(function (saveErr) {
        if (saveErr) return reject(saveErr);
        resolve(platform);
      });
    });
  });
}
```

Add both names to `module.exports`.

> `token.save()` is wrapped in `Promise.resolve(...)` because the backend's `save()` returns a thenable; the fake returns a Promise too.

- [ ] **Step 4: Run the test, verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-service.js`
Expected: `3 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiRegistration.js
git commit -m "lti(dynreg): mintRegistrationToken + activatePlatform service functions (DRY anchors)"
```

---

## Task 6: lti.js — registerInit + registerComplete + routes + views

**Files:**
- Modify: `lib/controllers/lti.js`, `config/routes.js`
- Create: `lib/views/lti/register-confirm.html`, `lib/views/lti/register-close.html`, `lib/views/lti/register-error.html`
- Test: `scripts/test-lti-register.js` (new, gitignored) — mock-platform harness

**Interfaces:**
- Consumes: `ltiRegistration` (Tasks 3–5), `LtiRegistrationToken`, `LtiPlatform`, `config`.
- Produces: `lti.registerInit(request, reply)` (GET /lti/register) and `lti.registerComplete(request, reply)` (POST /lti/register).

- [ ] **Step 1: Write the failing test (mock-platform harness)**

Create `scripts/test-lti-register.js`:

```js
#!/usr/bin/env node
// scripts/test-lti-register.js (gitignored) — drive lti.registerInit/registerComplete against a
// mock platform (loopback openid-config + registration_endpoint), with LtiRegistrationToken and
// LtiPlatform stubbed. Asserts: confirm page on GET; pending platform created + token consumed +
// close page on POST; bad/expired/used token rejected; failed register does NOT consume the token.
// Run: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-register.js
'use strict';
var assert = require('assert');
var http   = require('http');
var crypto = require('crypto');

// allow loopback registration hosts
process.env.NODE_CONFIG = JSON.stringify({ url: 'https://tool.example', lti: { allowPrivateRegistrationHosts: true } });

// ---- stub models ----
var tokens = {};   // hash -> token
function FakeToken(props) { Object.assign(this, props); this.usedAt = this.usedAt || null; this.platformId = this.platformId || null; }
FakeToken.hashToken = function (raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); };
FakeToken.findByHash = function (h, cb) { cb(null, tokens[h] || null); };
FakeToken.prototype.save = function (cb) { tokens[this.tokenHash] = this; if (cb) cb(null, this); return Promise.resolve(this); };
FakeToken.prototype.isValid = function () { return this.usedAt == null && this.expiresAt.getTime() > Date.now(); };

var createdPlatforms = [];
function FakePlatform(p) { Object.assign(this, p); if (this.status === undefined) this.status = 'pending'; }
FakePlatform.prototype.save = function (cb) { this.id = this.id || ('p-' + (createdPlatforms.length + 1)); createdPlatforms.push(this); if (cb) cb(null, this); return Promise.resolve(this); };

var Module = require('module'), orig = Module._load;
Module._load = function (request) {
  if (/models\/ltiRegistrationToken$/.test(request)) return FakeToken;
  if (/models\/ltiPlatform$/.test(request)) return FakePlatform;
  return orig.apply(this, arguments);
};

var lti = require('../lib/controllers/lti');

// ---- tiny reply double (captures view/redirect/boom) ----
function makeReply() {
  var captured = { view: null, data: null, code: 200, boom: null };
  function reply(arg) {
    if (arg && arg.isBoom) { captured.boom = arg; return chain(); }
    return chain();
  }
  function chain() {
    return {
      view: function (name, data) { captured.view = name; captured.data = data; return this; },
      code: function (c) { captured.code = c; return this; },
      type: function () { return this; },
      header: function () { return this; },
      redirect: function (u) { captured.redirect = u; return this; }
    };
  }
  reply.captured = captured;
  // request.success-style helper used by some controllers:
  return reply;
}
```

> **Implementer note:** trinket controllers render via `request.success(data)` with the route's `html`, OR via `reply().view(...)`. Inspect how a nearby simple GET controller returns a view (e.g. `admin.uploadForm` returns `request.success({})`). Match that mechanism in `registerInit`/`registerComplete`, and adapt this reply/`request` double accordingly so the test drives the real handler. The assertions below describe the REQUIRED behavior; wire the double to whatever render call the handlers actually use.

Continue the script:

```js
var pass = 0, fail = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(
  function(){ pass++; console.log('  ok   '+name); },
  function(e){ fail++; console.log('  FAIL '+name+' -> '+(e&&e.message&&e.message)); }); }

// mock platform server
var server, BASE;
function startServer(next) {
  server = http.createServer(function (req, res) {
    if (req.url === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        issuer: 'https://platform.test',
        authorization_endpoint: BASE + '/auth',
        token_endpoint: BASE + '/token',
        jwks_uri: BASE + '/jwks',
        registration_endpoint: BASE + '/register',
        'https://purl.imsglobal.org/spec/lti-platform-configuration': { product_family_code: 'moodle' }
      }));
    }
    if (req.url === '/register' && req.method === 'POST') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ client_id: 'CID-999',
        'https://purl.imsglobal.org/spec/lti-tool-configuration': { deployment_id: 'dep-77' } }));
    }
    res.statusCode = 404; res.end('x');
  }).listen(0, '127.0.0.1', function () { BASE = 'http://127.0.0.1:' + server.address().port; next(); });
}

function seedToken(raw, opts) {
  var t = new FakeToken(Object.assign({ tokenHash: FakeToken.hashToken(raw), expiresAt: new Date(Date.now() + 3600000) }, opts || {}));
  tokens[t.tokenHash] = t; return t;
}
```

The implementer completes the script with these cases (driving the real handlers via the reply/request double):
1. **GET with valid reg_token** → confirm view rendered (carries `openid_configuration`/`registration_token`/`reg_token`); no platform created.
2. **GET with bad reg_token** → error view; no outbound fetch; no platform.
3. **POST with valid reg_token** → 1 platform created with `status:'pending'`, `registeredVia:'dynamic'`, `clientId:'CID-999'`, `deploymentIds:['dep-77']`, `productFamily:'moodle'`, `initiatedByEmail` from the token; token consumed (`usedAt` set, `platformId` set); close view rendered.
4. **POST reusing the consumed token** → error view; no second platform.
5. **POST when the platform `/register` returns HTTP 500** (point the openid-config's `registration_endpoint` at a 500 route) → error view; token **not** consumed (still valid).

End with the `N passed, M failed` line and `server.close()`.

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-register.js`
Expected: FAIL — `lti.registerInit is not a function`.

- [ ] **Step 3: Implement registerInit + registerComplete**

In `lib/controllers/lti.js`, add requires near the top:

```js
var ltiRegistration = require('../util/ltiRegistration');
var LtiRegistrationToken = require('../models/ltiRegistrationToken');
```

Add the handlers to the exported object (after `jwks`, before `loginInit`):

```js
  // GET /lti/register — the LMS opens this with ?reg_token (trinket's gate) plus the IMS params
  // ?openid_configuration (the platform's config URL) and ?registration_token (the platform's bearer).
  // Validate reg_token, fetch the platform config, render a confirm page. No record is created here.
  registerInit: function(request, reply) {
    var q = request.query || {};
    var rawToken = q.reg_token;
    var openidCfgUrl = q.openid_configuration;
    var platformToken = q.registration_token || '';
    if (!rawToken || !openidCfgUrl) {
      return reply.view('lti/register-error', { message: 'Missing registration parameters.' }).code(400);
    }
    return LtiRegistrationToken.findByHash(LtiRegistrationToken.hashToken(rawToken), function(err, token) {
      if (err) return reply.view('lti/register-error', { message: 'Registration lookup failed.' }).code(500);
      if (!token || !token.isValid()) {
        return reply.view('lti/register-error', { message: 'This registration link is invalid, expired, or already used.' }).code(400);
      }
      return ltiRegistration.fetchPlatformConfig(openidCfgUrl).then(function(openidConfig) {
        return reply.view('lti/register-confirm', {
          regToken: rawToken,
          openidConfiguration: openidCfgUrl,
          registrationToken: platformToken,
          issuer: openidConfig.issuer,
          label: token.label || openidConfig.issuer
        });
      }).catch(function(e) {
        return reply.view('lti/register-error', { message: 'Could not read the LMS configuration: ' + e.message }).code(502);
      });
    });
  },

  // POST /lti/register — the LMS-admin confirm form. Re-validate reg_token, POST the tool-config to
  // the platform, persist a PENDING platform, consume the token, return the IMS close page.
  registerComplete: function(request, reply) {
    var b = request.payload || {};
    var rawToken = b.reg_token;
    var openidCfgUrl = b.openid_configuration;
    var platformToken = b.registration_token || '';
    if (!rawToken || !openidCfgUrl) {
      return reply.view('lti/register-error', { message: 'Missing registration parameters.' }).code(400);
    }
    var hash = LtiRegistrationToken.hashToken(rawToken);
    return LtiRegistrationToken.findByHash(hash, function(err, token) {
      if (err) return reply.view('lti/register-error', { message: 'Registration lookup failed.' }).code(500);
      if (!token || !token.isValid()) {
        return reply.view('lti/register-error', { message: 'This registration link is invalid, expired, or already used.' }).code(400);
      }
      return ltiRegistration.fetchPlatformConfig(openidCfgUrl)
        .then(function(openidConfig) {
          return ltiRegistration.register(openidConfig, platformToken).then(function(registrationResponse) {
            var fields = ltiRegistration.toPlatformFields(openidConfig, registrationResponse);
            var platform = new LtiPlatform({
              issuer: fields.issuer, clientId: fields.clientId,
              authLoginUrl: fields.authLoginUrl, authTokenUrl: fields.authTokenUrl, jwksUrl: fields.jwksUrl,
              deploymentIds: fields.deploymentIds, name: fields.name, productFamily: fields.productFamily,
              status: 'pending', registeredVia: 'dynamic', initiatedByEmail: token.initiatedByEmail
            });
            return new Promise(function(resolve, reject) {
              platform.save(function(saveErr, savedPlatform) {
                if (saveErr) return reject(saveErr);
                // consume the token only AFTER a successful registration + save
                token.usedAt = new Date();
                token.platformId = savedPlatform.id;
                Promise.resolve(token.save()).then(function() { resolve(savedPlatform); }, reject);
              });
            });
          });
        })
        .then(function() {
          return reply.view('lti/register-close', {});
        })
        .catch(function(e) {
          // token NOT consumed — admin can retry with the same link
          return reply.view('lti/register-error', { message: 'Registration failed: ' + e.message }).code(502);
        });
    });
  },
```

> If the codebase's render call is `request.success(data)` rather than `reply.view(name, data)`, the implementer adapts these to use `request.success` plus the route's `html` (the confirm/close/error pages would then be the route `html`). Pick the mechanism that matches sibling controllers; keep the data keys identical. The test double must drive whichever is used.

- [ ] **Step 4: Create the views**

`lib/views/lti/register-confirm.html` — the LMS admin confirms; POSTs back the hidden fields:

```html
{% extends "base.html" %}
{% block content %}
<div class="row"><div class="small-12 medium-8 columns small-centered">
  <h3>Connect {{ label }} to Trinket</h3>
  <p>Issuer: <code>{{ issuer }}</code></p>
  <p>Clicking <strong>Register</strong> will register Trinket as an LTI 1.3 tool in your LMS. After
     registration, a Trinket administrator reviews and activates the connection before launches work.</p>
  <form method="POST" action="/lti/register">
    <input type="hidden" name="reg_token" value="{{ regToken }}">
    <input type="hidden" name="openid_configuration" value="{{ openidConfiguration }}">
    <input type="hidden" name="registration_token" value="{{ registrationToken }}">
    <button type="submit" class="button">Register</button>
  </form>
</div></div>
{% endblock %}
```

`lib/views/lti/register-close.html` — IMS close page:

```html
{% extends "base.html" %}
{% block content %}
<div class="row"><div class="small-12 medium-8 columns small-centered">
  <h3>Registration complete</h3>
  <p>Trinket has been registered. A Trinket administrator will activate the connection shortly, after
     which launches will work. You can close this window.</p>
</div></div>
<script>
  (window.opener || window.parent).postMessage({ subject: 'org.imsglobal.lti.close' }, '*');
</script>
{% endblock %}
```

`lib/views/lti/register-error.html`:

```html
{% extends "base.html" %}
{% block content %}
<div class="row"><div class="small-12 medium-8 columns small-centered">
  <h3>Registration problem</h3>
  <p>{{ message }}</p>
</div></div>
{% endblock %}
```

> Confirm `base.html` exposes a `content` block (it does — `admin/index.html` uses `{% block content %}`).

- [ ] **Step 5: Register the routes**

In `config/routes.js`, inside the LTI block (after the `POST /lti/launch` entry, before the closing `]`):

```js
  {
    route : 'GET /lti/register lti.registerInit',
    config : { auth : false }
  },
  {
    route : 'POST /lti/register lti.registerComplete',
    config : { auth : false }
  },
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-register.js`
Expected: all cases pass (`N passed, 0 failed`).

- [ ] **Step 7: Commit**

```bash
git add lib/controllers/lti.js config/routes.js lib/views/lti/register-confirm.html lib/views/lti/register-close.html lib/views/lti/register-error.html
git commit -m "lti(dynreg): GET/POST /lti/register handshake + confirm/close/error views"
```

---

## Task 7: lti.js — status gate on loginInit/launch + auto-deployment

**Files:**
- Modify: `lib/controllers/lti.js`
- Test: `scripts/test-lti-launch-status.js` (new, gitignored); plus re-run `scripts/test-lti-launch.js`

**Interfaces:**
- Consumes: `platform.status` (Task 1), `platform.addDeployment` (Task 1), `platform.knowsDeployment`.
- Produces: `loginInit` and `launch` reject when `platform.status !== 'active'`; `launch` records an unknown `deployment_id` (after JWT verification) instead of hard-rejecting.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-lti-launch-status.js` modeled on `scripts/test-lti-launch.js` (copy its require-shim header). Add a mutable `platform.status` and `addDeployment` to the fake platform:

```js
function makePlatform(status, deployments) {
  return {
    issuer: 'https://platform.test', clientId: 'cid', status: status,
    authLoginUrl: 'https://platform.test/auth', jwksUrl: 'https://platform.test/jwks',
    deploymentIds: deployments.slice(),
    knowsDeployment: function (d) { return this.deploymentIds.indexOf(d) >= 0; },
    addDeployment: function (d, cb) { if (this.deploymentIds.indexOf(d) < 0) this.deploymentIds.push(d); cb(null, this); }
  };
}
```

Required cases (reuse the launch harness's id_token signing):
1. **loginInit when platform.status==='pending'** → Boom 4xx ("pending approval"), no redirect.
2. **launch when platform.status==='pending'** → Boom 4xx, no session.
3. **launch when status==='active' and deployment_id is UNKNOWN** → succeeds; `platform.deploymentIds` now contains the id (auto-recorded).
4. **launch when status==='active' and deployment_id known** → succeeds (regression).
5. **launch with missing/empty deployment_id** → still rejected.

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-launch-status.js`
Expected: FAIL — pending launches currently succeed (no status gate); unknown deployment currently hard-rejects (case 3 fails).

- [ ] **Step 3: Add the status gate + auto-deployment**

In `lib/controllers/lti.js` `loginInit`, right after the `if (!platform) return reply(Boom.badRequest(...))` inside `findByIssuer`:

```js
      if (platform.status && platform.status !== 'active') {
        return reply(Boom.badRequest('This LMS registration is pending Trinket admin approval.'));
      }
```

In `launch`, after `if (!platform) return reply(Boom.badRequest('Unknown LTI issuer: ' + state.iss));`:

```js
      if (platform.status && platform.status !== 'active') {
        return reply(Boom.badRequest('This LMS registration is pending Trinket admin approval.'));
      }
```

Replace the deployment step (current step 4) inside the `.then(function(claims){ ... })`:

```js
          // 4. deployment: must be present; auto-record an unknown one (Dynamic Registration often
          //    omits deployment_id until the admin deploys). Safe — the id_token is already verified
          //    against this platform's JWKS, and the platform is admin-activated (status gate above).
          var deploymentId = claims[LTI + 'deployment_id'];
          if (!deploymentId) {
            throw Boom.badRequest('Missing deployment_id.');
          }
          var ensureDeployment = platform.knowsDeployment(deploymentId)
            ? Promise.resolve()
            : new Promise(function (res, rej) { platform.addDeployment(deploymentId, function (e) { return e ? rej(e) : res(); }); });
          return ensureDeployment.then(function () {
```

Close the added `.then(function () {` before the existing `// 5. message type + version.` block — i.e. wrap steps 5/6/7 inside it, and add the matching `})` before the outer `.then`'s closing. (The implementer adjusts brace nesting so steps 5–7 run inside `ensureDeployment.then`.)

> Keep step 5 (message_type) and step 6 (version) checks and the replay/provision chain exactly as they are — only the deployment check changes from "reject unknown" to "record unknown".

- [ ] **Step 4: Run the tests, verify they pass**

Run:
```bash
docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-launch-status.js
docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-launch.js
```
Expected: status test all pass; the original launch matrix (15/15) still passes (the seeded testbed platforms have no `status`, so `platform.status && ...` is falsey → not gated; confirm the fake platforms in `test-lti-launch.js` either get `status:'active'` or omit it).

> If `test-lti-launch.js`'s fake platform now trips the status gate, set `status: 'active'` on it. The `platform.status &&` guard means a missing status never gates (back-compat for seeded-active testbeds that predate the field), but verify.

- [ ] **Step 5: Commit**

```bash
git add lib/controllers/lti.js
git commit -m "lti(dynreg): gate login/launch on platform.status==='active'; auto-record unknown deployment_id"
```

---

## Task 8: instructorAuth.getInstructorRecord + seam exposure

**Files:**
- Modify: `lib/util/instructorAuth.js`, `lib/util/ltiInstructorAuthority-instructormi.js`, `lib/util/ltiInstructorAuthority-default.js`
- Test: `scripts/test-get-instructor-record.js` (new, gitignored)

**Interfaces:**
- Consumes: the existing `instructorDs` Datastore client + `_setDatastore` test seam in `instructorAuth.js`.
- Produces:
  - `instructorAuth.getInstructorRecord(email)` → Promise of the full `Instructor` entity (first match by `emailOfficial` then `emailSignin`) or `null`; cached like `isApprovedInstructor`.
  - `ltiInstructorAuthority.getInstructorRecord(email)` → on `instructormi` delegates to `instructorAuth.getInstructorRecord`; on `default` returns `Promise.resolve(null)`. The admin controller calls the seam (keeps Datastore out of the portable path).

- [ ] **Step 1: Write the failing test**

Create `scripts/test-get-instructor-record.js` (reuse the fake-Datastore shape from `scripts/test-instructor-auth.js`):

```js
#!/usr/bin/env node
// scripts/test-get-instructor-record.js (gitignored)
// Run: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-get-instructor-record.js
'use strict';
var assert = require('assert');
var instructorAuth = require('../lib/util/instructorAuth');

// Minimal fake Datastore returning a full entity for emailOfficial / emailSignin equality queries.
function fakeDatastore(entities) {
  return {
    createQuery: function (kind) {
      var filters = [];
      var q = { filter: function (f, op, v) { filters.push([f, v]); return q; }, limit: function () { return q; }, _filters: filters };
      return q;
    },
    runQuery: function (q) {
      var match = entities.filter(function (e) {
        return q._filters.every(function (f) { return String(e[f[0]]) === String(f[1]); });
      });
      return Promise.resolve([match]);
    }
  };
}

var pass = 0, fail = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(
  function(){ pass++; console.log('  ok   '+name); },
  function(e){ fail++; console.log('  FAIL '+name+' -> '+(e&&e.message)); }); }

Promise.resolve()
  .then(function(){ instructorAuth._setDatastore(fakeDatastore([
      { name: 'Prof X', emailOfficial: 'x@uindy.edu', emailSignin: 'profx@gmail.com', authorized: true, date: '2026-01-01', processedby: 'admin@trinket.io' }
    ])); })
  .then(function(){ return check('getInstructorRecord by emailOfficial returns full entity', function(){
    return instructorAuth.getInstructorRecord('x@uindy.edu').then(function (rec) {
      assert.ok(rec); assert.strictEqual(rec.name, 'Prof X'); assert.strictEqual(rec.processedby, 'admin@trinket.io');
    });
  }); })
  .then(function(){ return check('getInstructorRecord by emailSignin returns full entity', function(){
    return instructorAuth.getInstructorRecord('profx@gmail.com').then(function (rec) {
      assert.ok(rec); assert.strictEqual(rec.emailOfficial, 'x@uindy.edu');
    });
  }); })
  .then(function(){ return check('getInstructorRecord unknown -> null', function(){
    return instructorAuth.getInstructorRecord('nobody@nowhere.edu').then(function (rec) { assert.strictEqual(rec, null); });
  }); })
  .then(function(){ console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0); });
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-get-instructor-record.js`
Expected: FAIL — `instructorAuth.getInstructorRecord is not a function`.

- [ ] **Step 3: Implement getInstructorRecord**

In `lib/util/instructorAuth.js`, add a separate record cache and the function (after `isApprovedInstructor`):

```js
var recordCache = {};

// Return the full Instructor entity (not a boolean) for the activation view. First match by
// emailOfficial then emailSignin (same fields as isApprovedInstructor, no ancestor in the query).
// Cached 5 min. Returns null when not enabled or not found.
async function getInstructorRecord(email) {
  if (!instructorAuthEnabled) return null;
  var key = (email || '').toLowerCase();
  if (!key) return null;
  if (recordCache[key] && (Date.now() - recordCache[key].ts) < CACHE_MS) {
    return recordCache[key].value;
  }
  var record = null;
  try {
    var byOfficial = await instructorDs.runQuery(
      instructorDs.createQuery('Instructor').filter('emailOfficial', '=', key).limit(1));
    if (byOfficial[0] && byOfficial[0].length) {
      record = byOfficial[0][0];
    } else {
      var bySignin = await instructorDs.runQuery(
        instructorDs.createQuery('Instructor').filter('emailSignin', '=', key).limit(1));
      if (bySignin[0] && bySignin[0].length) record = bySignin[0][0];
    }
  } catch (err) {
    console.error('instructorAuth.getInstructorRecord query failed for', key, err.message);
    return null;
  }
  recordCache[key] = { value: record, ts: Date.now() };
  return record;
}
```

Also clear `recordCache` inside `_setDatastore` (alongside the existing `cache = {}`):

```js
function _setDatastore(ds) {
  instructorDs = ds;
  instructorAuthEnabled = !!ds;
  cache = {};
  recordCache = {};
}
```

Add `getInstructorRecord` to `module.exports`.

- [ ] **Step 4: Expose it through the seam**

In `lib/util/ltiInstructorAuthority-instructormi.js`:

```js
function getInstructorRecord(email) {
  return Promise.resolve(instructorAuth.getInstructorRecord(email)).catch(function () { return null; });
}

module.exports = { resolveInstructor: resolveInstructor, getInstructorRecord: getInstructorRecord };
```

In `lib/util/ltiInstructorAuthority-default.js`:

```js
function getInstructorRecord(email) {
  return Promise.resolve(null);   // oss/default has no instructor records to show
}

module.exports = { resolveInstructor: resolveInstructor, getInstructorRecord: getInstructorRecord };
```

- [ ] **Step 5: Run the test + regression, verify they pass**

Run:
```bash
docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-get-instructor-record.js
docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-instructor-auth.js
```
Expected: new test `3 passed, 0 failed`; instructor-auth still `ALL PASS`.

- [ ] **Step 6: Commit**

```bash
git add lib/util/instructorAuth.js lib/util/ltiInstructorAuthority-instructormi.js lib/util/ltiInstructorAuthority-default.js
git commit -m "lti(dynreg): instructorAuth.getInstructorRecord + seam exposure (default returns null)"
```

---

## Task 9: Connect-your-LMS page (instructor) + seam gate

**Files:**
- Create: `lib/controllers/connectLms.js`, `lib/views/lti/connect-lms.html`
- Modify: `lib/util/helpers.js` (add `canInitiateLtiRegistration`), `config/routes.js`
- Test: `scripts/test-connect-lms-gate.js` (new, gitignored)

**Interfaces:**
- Consumes: `ltiInstructorAuthority.resolveInstructor` (seam), `ltiRegistration.mintRegistrationToken` (Task 5).
- Produces:
  - `helpers.canInitiateLtiRegistration(user)` → server-method pre-handler; resolves truthy iff `resolveInstructor({ email: user.email })` is truthy; throws `Boom.forbidden` otherwise; throws `Boom.unauthorized` when no user. (Passing only `{ email }` makes a bare trust-platform deploy fail closed.)
  - `connectLms.page(request, reply)` (GET) → renders the page.
  - `connectLms.createToken(request, reply)` (POST) → `mintRegistrationToken({ label, initiatedByEmail: request.user.email })`, returns `{ url }` (the view shows it).

- [ ] **Step 1: Write the failing test (the gate)**

Create `scripts/test-connect-lms-gate.js`:

```js
#!/usr/bin/env node
// scripts/test-connect-lms-gate.js (gitignored) — canInitiateLtiRegistration honors the seam and
// fails closed. Stubs ltiInstructorAuthority via require-shim.
// Run: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-connect-lms-gate.js
'use strict';
var assert = require('assert');
var resolveResult = false;
var Module = require('module'), orig = Module._load;
Module._load = function (request) {
  if (/util\/ltiInstructorAuthority$/.test(request)) {
    return { resolveInstructor: function (ctx) { assert.ok(!('lmsTeacher' in ctx), 'gate passes only {email}'); return Promise.resolve(resolveResult); } };
  }
  return orig.apply(this, arguments);
};
var helpers = require('../lib/util/helpers');
var gate = helpers.canInitiateLtiRegistration || (helpers.internals && helpers.internals.canInitiateLtiRegistration);

var pass = 0, fail = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(
  function(){ pass++; console.log('  ok   '+name); },
  function(e){ fail++; console.log('  FAIL '+name+' -> '+(e&&e.message)); }); }

Promise.resolve()
  .then(function(){ return check('no user -> unauthorized', function(){
    return Promise.resolve().then(function(){ return gate(null); }).then(
      function(){ throw new Error('expected throw'); },
      function(e){ assert.ok(e.isBoom && e.output.statusCode === 401); });
  }); })
  .then(function(){ return check('approved instructor -> allowed', function(){
    resolveResult = true;
    return Promise.resolve(gate({ email: 'prof@uindy.edu' })).then(function (v) { assert.ok(v); });
  }); })
  .then(function(){ return check('not approved -> forbidden', function(){
    resolveResult = false;
    return Promise.resolve().then(function(){ return gate({ email: 'rando@x.com' }); }).then(
      function(){ throw new Error('expected throw'); },
      function(e){ assert.ok(e.isBoom && e.output.statusCode === 403); });
  }); })
  .then(function(){ console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0); });
```

> **Implementer note:** how `helpers` exposes its functions (plain export vs `internals` vs server-method registration) determines how the test reaches the gate. Inspect `module.exports` at the bottom of `lib/util/helpers.js` and expose `canInitiateLtiRegistration` the same way the other `internals.*` gates (e.g. `canCreateCourse`) are exposed/registered, then point the test at it.

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-connect-lms-gate.js`
Expected: FAIL — gate undefined / not a function.

- [ ] **Step 3: Add the gate helper**

In `lib/util/helpers.js`, add (near `canCreateCourse`):

```js
// Gate the "Connect your LMS" page through the instructorAuthority SEAM (not instructorAuth
// directly), so each deploy profile's gate applies. Pass ONLY { email } (no lmsTeacher) so a bare
// trust-platform deploy resolves false and fails closed. Async — returns a Promise.
internals.canInitiateLtiRegistration = function(user) {
  if (!user) throw Boom.unauthorized();
  var ltiInstructorAuthority = require('./ltiInstructorAuthority');
  return Promise.resolve(ltiInstructorAuthority.resolveInstructor({ email: (user.email || '').toLowerCase() }))
    .then(function(ok) {
      if (ok) return defaultNextResult;
      throw Boom.forbidden('Only approved instructors can connect an LMS.');
    });
};
```

Ensure it's registered/exported the same way `canCreateCourse` is (so `pre: ['canInitiateLtiRegistration(user)']` resolves as a server method).

- [ ] **Step 4: Create the controller + view**

`lib/controllers/connectLms.js`:

```js
// "Connect your LMS" — an approved instructor mints a Dynamic Registration link to hand to their
// LMS admin. Thin wrapper over ltiRegistration.mintRegistrationToken (the DRY anchor).
var Boom = require('@hapi/boom');
var ltiRegistration = require('../util/ltiRegistration');

module.exports = {
  page: function(request, reply) {
    return request.success({});
  },
  createToken: function(request, reply) {
    var label = (request.payload && request.payload.label) || '';
    return ltiRegistration.mintRegistrationToken({ label: label, initiatedByEmail: request.user.email })
      .then(function(out) { return request.success({ url: out.url }); })
      .catch(function(e) { return reply(Boom.badImplementation('Could not create a registration link: ' + e.message)); });
  }
};
```

> Match the actual render/JSON convention: if sibling AJAX endpoints return JSON via `request.success({...})`, keep that; the view posts to `createToken` and shows `result.url`.

`lib/views/lti/connect-lms.html`:

```html
{% extends "base.html" %}
{% block content %}
<div class="row"><div class="small-12 medium-8 columns small-centered">
  <h3>Connect your LMS to Trinket</h3>
  <p>Generate a one-time registration link, then send it to your LMS administrator. They paste it into
     your LMS's <em>Dynamic Registration</em> field (Canvas: Developer Keys → + LTI Registration;
     Moodle: External tools → Tool registration URL). Trinket activates the connection after review.</p>
  <form id="gen-form">
    <label>Label (optional) <input type="text" name="label" placeholder="e.g. UIndy Canvas"></label>
    <button type="submit" class="button">Generate registration link</button>
  </form>
  <div id="gen-result" class="hide">
    <p>Send this link to your LMS admin (valid 7 days, single use):</p>
    <input id="reg-url" type="text" readonly style="width:100%">
  </div>
</div></div>
{% block extra_js %}
<script>
  document.getElementById('gen-form').addEventListener('submit', function(e){
    e.preventDefault();
    var label = this.label.value;
    fetch('/lti/connect/token', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ label: label }) })
      .then(function(r){ return r.json(); })
      .then(function(res){ document.getElementById('reg-url').value = res.url; document.getElementById('gen-result').classList.remove('hide'); });
  });
</script>
{% endblock %}
{% endblock %}
```

- [ ] **Step 5: Register the routes**

In `config/routes.js` (auth-gated pages — place near other authed routes, not in the `auth:false` LTI block):

```js
  {
    route : 'GET /lti/connect connectLms.page',
    html  : 'lti/connect-lms.html',
    config : { auth : 'session', pre : [ 'canInitiateLtiRegistration(user)' ] }
  },
  {
    route : 'POST /lti/connect/token connectLms.createToken',
    config : { auth : 'session', pre : [ 'canInitiateLtiRegistration(user)' ] }
  },
```

- [ ] **Step 6: Run the gate test + a smoke load**

Run:
```bash
docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-connect-lms-gate.js
docker exec trinket-gcr node -e "require('/usr/local/node/trinket/lib/controllers/connectLms'); console.log('connectLms loads');"
```
Expected: gate test `3 passed, 0 failed`; `connectLms loads`.

- [ ] **Step 7: Commit**

```bash
git add lib/controllers/connectLms.js lib/views/lti/connect-lms.html lib/util/helpers.js config/routes.js
git commit -m "lti(dynreg): Connect-your-LMS page + seam-gated token mint (fails closed on trust-platform)"
```

---

## Task 10: Admin activation subpage

**Files:**
- Modify: `lib/controllers/admin.js`, `lib/views/admin/index.html`, `config/routes.js`
- Create: `lib/views/admin/includes/lti-registrations.html`
- Test: `scripts/test-admin-lti-registrations.js` (new, gitignored)

**Interfaces:**
- Consumes: `LtiPlatform.find({ status: 'pending' })`, `ltiInstructorAuthority.getInstructorRecord` (Task 8), `ltiRegistration.activatePlatform` (Task 5).
- Produces: `admin.index` `lti-registrations` case (loads pending platforms + each initiator's record into `pageData`); `admin.activateLtiRegistration(request, reply)` (POST handler) → activates (or rejects/deletes) and returns JSON.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-admin-lti-registrations.js` — stub `LtiPlatform`, `ltiInstructorAuthority`, `ltiRegistration` via require-shim; drive `admin.activateLtiRegistration` with a reply double:

```js
#!/usr/bin/env node
// scripts/test-admin-lti-registrations.js (gitignored)
// Run: docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-admin-lti-registrations.js
'use strict';
var assert = require('assert');
var activated = [];
var Module = require('module'), orig = Module._load;
Module._load = function (request) {
  if (/util\/ltiRegistration$/.test(request)) return {
    activatePlatform: function (issuer, clientId) { activated.push([issuer, clientId]); return Promise.resolve({ issuer: issuer, status: 'active' }); }
  };
  if (/util\/ltiInstructorAuthority$/.test(request)) return { getInstructorRecord: function () { return Promise.resolve(null); } };
  if (/models\/ltiPlatform$/.test(request)) return { find: function (q, cb) { cb(null, []); }, findByIssuer: function (i, c, cb) { (typeof c === 'function' ? c : cb)(null, null); } };
  return orig.apply(this, arguments);
};
var admin = require('../lib/controllers/admin');

function reqStub(payload) {
  return { payload: payload, params: {}, query: {},
           success: function (data) { this._ok = data || {}; return this._ok; },
           fail: function (e) { this._fail = e; throw e; } };
}

var pass = 0, fail = 0;
function check(name, fn) { return Promise.resolve().then(fn).then(
  function(){ pass++; console.log('  ok   '+name); },
  function(e){ fail++; console.log('  FAIL '+name+' -> '+(e&&e.message)); }); }

Promise.resolve()
  .then(function(){ return check('activateLtiRegistration calls activatePlatform and returns success', function(){
    var req = reqStub({ issuer: 'https://canvas.test', clientId: 'c', action: 'approve' });
    return Promise.resolve(admin.activateLtiRegistration(req, function(x){ return x; })).then(function(){
      assert.deepStrictEqual(activated[activated.length - 1], ['https://canvas.test', 'c']);
    });
  }); })
  .then(function(){ console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0); });
```

> **Implementer note:** adapt the reply/`request` double to `admin.js`'s actual success/fail convention (it uses `request.success(...)`). Also add a `reject` case if you implement delete in the same handler.

- [ ] **Step 2: Run the test, verify it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-admin-lti-registrations.js`
Expected: FAIL — `admin.activateLtiRegistration is not a function`.

- [ ] **Step 3: Add the dispatcher case + handler**

In `lib/controllers/admin.js` `index`, add a branch alongside the `featured-courses` branch:

```js
    else if (request.params.adminPage === 'lti-registrations') {
      var LtiPlatform = require('../models/ltiPlatform');
      var authority   = require('../util/ltiInstructorAuthority');
      promise = new Promise(function(resolve, reject) {
        LtiPlatform.find({ status: 'pending' }, function(err, platforms) {
          if (err) return reject(err);
          resolve(platforms || []);
        });
      }).then(function(platforms) {
        return Promise.all(platforms.map(function(p) {
          return Promise.resolve(authority.getInstructorRecord(p.initiatedByEmail))
            .catch(function() { return null; })
            .then(function(record) {
              return {
                id: p.id, issuer: p.issuer, clientId: p.clientId, name: p.name,
                productFamily: p.productFamily, deploymentIds: p.deploymentIds || [],
                initiatedByEmail: p.initiatedByEmail, created: p.created,
                record: record  // full Instructor entity or null
              };
            });
        }));
      }).then(function(rows) {
        pageData.registrations = rows;
        return pageData;
      });
    }
```

Add the handler to the exported object:

```js
  // POST /admin/lti-registrations/activate — approve (activate) or reject (delete) a pending
  // platform. Thin wrapper over ltiRegistration.activatePlatform (the DRY anchor).
  activateLtiRegistration: function(request, reply) {
    var b = request.payload || {};
    var ltiRegistration = require('../util/ltiRegistration');
    if (b.action === 'reject') {
      var LtiPlatform = require('../models/ltiPlatform');
      return new Promise(function(resolve, reject) {
        LtiPlatform.findByIssuer(b.issuer, b.clientId, function(err, platform) {
          if (err) return reject(err);
          if (!platform) return resolve(request.success({ ok: true }));
          platform.remove(function(rmErr) { if (rmErr) return reject(rmErr); resolve(request.success({ ok: true })); });
        });
      });
    }
    return ltiRegistration.activatePlatform(b.issuer, b.clientId)
      .then(function() { return request.success({ ok: true, status: 'active' }); })
      .catch(function(e) { return request.fail(e); });
  },
```

> Verify the model's delete method name (`remove` vs `delete`) in the backend layer; if it differs, use the correct one. If delete is awkward in the Firestore backend, ship Approve-only for v1 and surface Reject in a follow-up (note it in the ledger) — Approve is the required path.

- [ ] **Step 4: Add the nav tab + the partial view**

In `lib/views/admin/index.html`, extend the tab list:

```html
    {% for link in ['Users', 'Featured-Courses', 'Lti-Registrations'] %}
```

Create `lib/views/admin/includes/lti-registrations.html`:

```html
<div id="lti-registrations">
  {% if not data.registrations or data.registrations.length == 0 %}
    <p>No pending LMS registrations.</p>
  {% else %}
  <table class="full-width">
    <thead><tr><th>LMS</th><th>Issuer</th><th>Initiated by</th><th>Approval record</th><th></th></tr></thead>
    <tbody>
    {% for r in data.registrations %}
      <tr data-issuer="{{ r.issuer }}" data-client-id="{{ r.clientId }}">
        <td>{{ r.productFamily or r.name or '—' }}<br><small>{{ r.deploymentIds | join(', ') }}</small></td>
        <td><code>{{ r.issuer }}</code></td>
        <td>{{ r.initiatedByEmail }}</td>
        <td>
          {% if r.record %}
            <strong>{{ r.record.name }}</strong><br>
            <small>official: {{ r.record.emailOfficial }} · signin: {{ r.record.emailSignin }}</small><br>
            <small>authorized: {{ r.record.authorized }} · rejected: {{ r.record.rejected }}</small><br>
            <small>approved {{ r.record.date }} by {{ r.record.processedby }}</small>
            {% if r.record.verification %}<br><small>verification: {{ r.record.verification }}</small>{% endif %}
            {% if r.record.comments %}<br><small>notes: {{ r.record.comments }}</small>{% endif %}
          {% else %}
            <small>{{ r.initiatedByEmail }} (no approval record available)</small>
          {% endif %}
        </td>
        <td>
          <button class="button tiny lti-approve">Approve</button>
          <button class="button tiny alert lti-reject">Reject</button>
        </td>
      </tr>
    {% endfor %}
    </tbody>
  </table>
  {% endif %}
</div>
<script>
(function(){
  function act(row, action){
    fetch('/admin/lti-registrations/activate', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ issuer: row.dataset.issuer, clientId: row.dataset.clientId, action: action }) })
      .then(function(r){ return r.json(); }).then(function(){ row.parentNode.removeChild(row); });
  }
  document.querySelectorAll('.lti-approve').forEach(function(b){ b.addEventListener('click', function(){ act(this.closest('tr'), 'approve'); }); });
  document.querySelectorAll('.lti-reject').forEach(function(b){ b.addEventListener('click', function(){ if (confirm('Reject and delete this pending registration?')) act(this.closest('tr'), 'reject'); }); });
})();
</script>
```

> `data` is whatever `request.success` passes to the template; confirm the key path (the dispatcher sets `pageData.registrations`, and `request.success({ ..., data: pageData })`, so the template reads `data.registrations`). Align with how `featured-courses.html` reads its data.

- [ ] **Step 5: Register the POST route**

In `config/routes.js`, near the other `/admin` routes:

```js
  {
    route : 'POST /admin/lti-registrations/activate admin.activateLtiRegistration',
    config : { auth : 'session', pre : [ 'isAdmin(user)' ] }
  },
```

- [ ] **Step 6: Run the test + load smoke**

Run:
```bash
docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-admin-lti-registrations.js
docker exec trinket-gcr node -e "require('/usr/local/node/trinket/lib/controllers/admin'); console.log('admin loads');"
```
Expected: test `1 passed, 0 failed`; `admin loads`.

- [ ] **Step 7: Commit**

```bash
git add lib/controllers/admin.js lib/views/admin/index.html lib/views/admin/includes/lti-registrations.html config/routes.js
git commit -m "lti(dynreg): /admin/lti-registrations subpage — list pending + approval record, approve/reject"
```

---

## Task 11: seed-lti-platform.js — set status + provenance

**Files:**
- Modify: `scripts/seed-lti-platform.js`
- Test: manual (the script is an ops tool; verify via a dry inspection)

**Interfaces:**
- Consumes: `LtiPlatform` with the new fields (Task 1).
- Produces: seeded platforms are `status:'active'`, `registeredVia:'manual'`.

- [ ] **Step 1: Set the fields on create/update**

In `scripts/seed-lti-platform.js`, where the platform is created/updated (the `var platform = existing || new LtiPlatform({...})` block), add after the field-copy loop:

```js
  platform.status = 'active';            // seeded platforms are trusted (the operator ran this)
  platform.registeredVia = 'manual';
```

- [ ] **Step 2: Verify by inspection (no live write needed)**

Run:
```bash
docker exec trinket-gcr node -e "
  var src = require('fs').readFileSync('/usr/local/node/trinket/scripts/seed-lti-platform.js','utf8');
  if (src.indexOf(\"status = 'active'\") < 0 || src.indexOf(\"registeredVia = 'manual'\") < 0) { console.error('FAIL: fields not set'); process.exit(1); }
  console.log('seed script sets status=active, registeredVia=manual');
"
```
Expected: `seed script sets status=active, registeredVia=manual`.

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-lti-platform.js
git commit -m "lti(dynreg): seed-lti-platform.js marks platforms status=active, registeredVia=manual"
```

---

## Task 12: Live testbed validation (manual)

**Files:** none (verification task). Produces the SP2 acceptance evidence.

**Prerequisite:** `docker restart trinket-gcr` (load all new code), confirm startup is clean.

- [ ] **Step 1: Confirm config for live testing**

Ensure `config/local.yaml` has `lti.allowPrivateRegistrationHosts: true` (so the loopback/`host.docker.internal` Canvas + Moodle testbeds are reachable) and `lti.instructorAuthority: instructormi`. Restart if changed.

- [ ] **Step 2: Instructor mint**

As an approved instructor, visit `/lti/connect`, generate a registration link. Confirm a non-approved user gets `forbidden`.

- [ ] **Step 3: Dynamic Registration against the local Canvas testbed**

Paste the link into the Canvas testbed's LTI Registration field. Walk the confirm page → Register. Confirm: an `LtiPlatform` lands `status:'pending'`, `registeredVia:'dynamic'`, with the client_id Canvas minted; the token is consumed; the close page posts the IMS close message.

- [ ] **Step 4: Admin activation**

As a site admin, open `/admin/lti-registrations`. Confirm the pending row shows the issuer + the initiating instructor's approval record. Click Approve → status flips to `active`.

- [ ] **Step 5: End-to-end launch**

Launch the tool from Canvas. Confirm: a launch before activation showed "pending approval"; after activation the launch succeeds, an unknown `deployment_id` is auto-recorded, and the instructor lands in the course as `course-admin` (authority-intersected).

- [ ] **Step 6: Repeat against the Moodle testbed** (product_family `moodle`), confirming the same flow.

- [ ] **Step 7: Regression sweep**

```bash
for t in test-lti-launch test-lti-launch-status test-lti-login test-lti-provision test-lti-instructor-authz test-lti-launch-authz test-instructor-auth test-site-admin test-lti-registration-pure test-lti-registration-fetch test-lti-registration-service test-lti-register test-get-instructor-record test-connect-lms-gate test-admin-lti-registrations test-lti-platform-model test-lti-reg-token-model; do
  echo "== $t"; docker exec trinket-gcr node /usr/local/node/trinket/scripts/$t.js 2>&1 | tail -2
done
```
Expected: every suite green.

- [ ] **Step 8: Commit any fixes found during live testing**, then this sub-project is complete — proceed to `superpowers:finishing-a-development-branch`.

---

## Notes for the executor

- **Render convention is the one open integration unknown.** Tasks 6, 9, 10 assume a `request.success(data)` / `reply.view(name, data)` convention; the very first implementer to touch a view-rendering handler should confirm the exact mechanism from a sibling controller (`admin.uploadForm`, `courses.coursePage`) and thread it consistently through the remaining UI tasks. The test doubles are written to be adapted to it.
- **Brace nesting in Task 7** is the one fiddly edit — the `ensureDeployment.then(...)` wraps the existing steps 5–7. Keep every existing check intact; only the deployment branch changes.
- **Reject/delete in Task 10** depends on the model's delete method; if it's awkward in the Firestore backend, ship Approve-only and record Reject as a follow-up (do not block the task).
