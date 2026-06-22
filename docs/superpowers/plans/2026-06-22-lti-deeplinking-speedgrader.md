# LTI Deep Linking + LMS-grader Submission Review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an instructor place a trinket assignment (and course/topic links) from inside their LMS via LTI Deep Linking, and review a student's submitted trinket inside the LMS grader (Canvas SpeedGrader) with the grade recorded in the LMS.

**Architecture:** Three new pure util seams (`ltiDeepLinking`, `ltiServiceToken`, `ltiAgs`) behind the same pattern as the existing `ltiVerify`/`ltiTarget`/`ltiRegistration` seams; a message-type fork in the existing `lti.js` launch handler for `LtiDeepLinkingRequest` and for the SpeedGrader review re-launch; one new field on `LtiResourceLink`; and reuse of the existing `assignment-embed-feedback` view + `course.sendFeedback` endpoint for the review surface. Spec: `docs/superpowers/specs/2026-06-22-lti-deeplinking-speedgrader-design.md`.

**Tech Stack:** Node + Hapi (callback/promise controllers), the repo's `model.create` layer (Firestore backend), `jsonwebtoken@^5` via `ltiKeys.signJwt` for Tool-signed JWTs, `jose` for verifying platform JWTs (already wired), global `fetch` for outbound HTTP. Tests are plain in-container Node scripts (no framework).

## Global Constraints

- **Firestore cost (CLAUDE.md):** no new per-launch writes. The `agsLineItemUrl` capture folds into the existing first-launch `LtiResourceLink` write; only write if the value is absent. No fetching documents just to check a field.
- **The AGS Score POST is best-effort and MUST NEVER fail or block a student's submission.** On failure: log, retry once after a token refresh on HTTP 401, then give up.
- **AGS Score body carries NO `scoreGiven` / `scoreMaximum`** — `activityProgress: "Submitted"`, `gradingProgress: "PendingManual"` only, plus the Canvas submission extension. trinket never stores a numeric grade.
- **Portability:** new seams are pure HTTP + crypto via `ltiKeys` — no `@google-cloud/datastore`, no Hapi coupling. New model fields ride the existing `model.create` layer.
- **Target encoding = LTI custom parameters** reusing `ltiTarget` (`trinket_assignment` / `trinket_course` / `trinket_topic`). No bespoke per-target routes.
- **Review id travels in the `target_link_uri` claim** (`https://purl.imsglobal.org/spec/lti/claim/target_link_uri`), parsed from the claim — NOT from a request query string.
- **Tests run in-container:** `docker exec trinket-gcr node /usr/local/node/trinket/scripts/<name>.js`. Model new tests on `scripts/test-lti-launch.js` (a `Module._load` require-shim stubbing `config`/models/seams + a local `ok()` assert harness) and `scripts/test-lti-registration-pure.js` (pure-function asserts).
- **Claim URI prefixes** (use these constants verbatim):
  - `LTI = 'https://purl.imsglobal.org/spec/lti/claim/'`
  - `DL  = 'https://purl.imsglobal.org/spec/lti-dl/claim/'`
  - `AGS = 'https://purl.imsglobal.org/spec/lti-ags/claim/'`
  - AGS score scope: `https://purl.imsglobal.org/spec/lti-ags/scope/score`
  - Canvas submission extension key: `https://canvas.instructure.com/lti/submission`

---

## File Structure

**New files:**
- `lib/util/ltiDeepLinking.js` — build content items + sign the Deep Linking Response JWT.
- `lib/util/ltiServiceToken.js` — mint a client-assertion, exchange for a cached AGS bearer token.
- `lib/util/ltiAgs.js` — build + POST the "submitted, pending-manual" AGS Score; resolve the line item.
- `lib/views/lti/deep-link-picker.html` — the instructor picker (server-rendered).
- `lib/views/lti/deep-link-response.html` — the auto-submitting form that POSTs the response JWT.
- `scripts/test-lti-deeplinking.js`, `scripts/test-lti-service-token.js`, `scripts/test-lti-ags.js`, `scripts/test-lti-review-launch.js` — in-container tests.

**Modified files:**
- `lib/controllers/lti.js` — message fork; `deepLinkPicker`, `deepLinkSelect`, review-launch handling.
- `lib/util/ltiRegistration.js:91-112` — DL message, placements, score scope in `buildToolConfiguration`.
- `lib/util/ltiTarget.js` — resolve `trinket_assignment`; capture `agsLineItemUrl`.
- `lib/models/ltiResourceLink.js:6-22` — `agsLineItemUrl` field + `findAssignmentLink`.
- `lib/models/ltiUserIdentity.js:14-21` — `findByUserAndIss`.
- `lib/controllers/course.js:975-1038` (`submitAssignment`) and `:1039+` (`updateMySubmission`) — fire the AGS post.
- `config/routes.js` (near `:438-456`) — picker + select routes.
- `scripts/test-lti-registration-pure.js:29-34` — update the "no AGS / ResourceLink only" assertions.

---

## Task 1: `ltiDeepLinking` seam — content items + signed response JWT

**Files:**
- Create: `lib/util/ltiDeepLinking.js`
- Test: `scripts/test-lti-deeplinking.js`

**Interfaces:**
- Consumes: `ltiKeys.signJwt(payload, options)` (RS256, sets `kid`); `config.url`.
- Produces:
  - `assignmentContentItem({ materialId, title, scoreMaximum })` → content-item object.
  - `linkContentItem({ targetType, targetId, title })` → content-item object (`targetType` = `'course'|'topic'`).
  - `buildDeepLinkingResponse({ platform, deploymentId, settings, contentItems })` → signed JWT string. `settings` is the `deep_linking_settings` claim (carries `deep_link_return_url` + opaque `data`).

- [ ] **Step 1: Write the failing test** (`scripts/test-lti-deeplinking.js`)

```javascript
#!/usr/bin/env node
'use strict';
var crypto = require('crypto');
process.env.LTI_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding:  { type: 'spki',  format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
}).privateKey;

var Module = require('module'), orig = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'config') return { url: 'https://tool.example', app: {} };
  return orig(request, parent, isMain);
};
var jwt = require('jsonwebtoken');
var dl  = require('../lib/util/ltiDeepLinking');

var DL = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
var LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
var pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } }

// assignment content item carries the custom param + a lineItem
var ci = dl.assignmentContentItem({ materialId: 'm1', title: 'Lab 1', scoreMaximum: 1 });
ok(ci.type === 'ltiResourceLink', 'assignment item is an ltiResourceLink');
ok(ci.custom && ci.custom.trinket_assignment === 'm1', 'assignment item carries trinket_assignment custom param');
ok(ci.lineItem && ci.lineItem.scoreMaximum === 1, 'assignment item carries a lineItem');
ok(ci.url.indexOf('https://tool.example/lti/launch') === 0, 'assignment item url is the launch url');

// link content item: no lineItem
var li = dl.linkContentItem({ targetType: 'course', targetId: 'c1', title: 'My Course' });
ok(li.type === 'ltiResourceLink' && !li.lineItem, 'course link item has no lineItem');
ok(li.custom.trinket_course === 'c1', 'course link item carries trinket_course');

// response JWT: signed, correct claims, echoes data
var token = dl.buildDeepLinkingResponse({
  platform: { clientId: 'client-abc', issuer: 'https://lms.example' },
  deploymentId: 'dep-1',
  settings: { deep_link_return_url: 'https://lms.example/return', data: 'opaque-123' },
  contentItems: [ci]
});
var decoded = jwt.decode(token, { complete: true });
ok(decoded.header.alg === 'RS256' && decoded.header.kid, 'response JWT is RS256 with a kid');
var c = decoded.payload;
ok(c.iss === 'client-abc', 'response iss = tool client_id');
ok(c.aud === 'https://lms.example', 'response aud = platform issuer');
ok(c[LTI + 'message_type'] === 'LtiDeepLinkingResponse', 'message_type = LtiDeepLinkingResponse');
ok(c[LTI + 'version'] === '1.3.0', 'version 1.3.0');
ok(c[LTI + 'deployment_id'] === 'dep-1', 'deployment_id echoed');
ok(Array.isArray(c[DL + 'content_items']) && c[DL + 'content_items'].length === 1, 'content_items present');
ok(c[DL + 'data'] === 'opaque-123', 'opaque data echoed back');

console.log(fail ? ('FAIL ' + fail) : ('PASS ' + pass));
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-deeplinking.js`
Expected: FAIL — `Cannot find module '../lib/util/ltiDeepLinking'`.

- [ ] **Step 3: Implement `lib/util/ltiDeepLinking.js`**

```javascript
// LTI Deep Linking (lti-dl) — pure seam. Builds the content items trinket returns to a platform
// and signs the Deep Linking Response JWT with the Tool key. No Hapi/HTTP coupling; no Datastore.
'use strict';
var config  = require('config');
var ltiKeys = require('./ltiKeys');

var LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
var DL  = 'https://purl.imsglobal.org/spec/lti-dl/claim/';

function launchUrl() { return config.url + '/lti/launch'; }

// Assignment placement: a gradeable resource link. The lineItem makes the LMS create the gradebook
// column; the custom param drives trinket's existing ltiTarget resolution.
function assignmentContentItem(opts) {
  return {
    type:    'ltiResourceLink',
    title:   opts.title,
    url:     launchUrl(),
    custom:  { trinket_assignment: String(opts.materialId) },
    lineItem: { scoreMaximum: (typeof opts.scoreMaximum === 'number' ? opts.scoreMaximum : 1),
                label: opts.title }
  };
}

// Course/topic placement: a plain resource link, no lineItem.
function linkContentItem(opts) {
  var custom = {};
  if (opts.targetType === 'topic') custom.trinket_topic = String(opts.targetId);
  else custom.trinket_course = String(opts.targetId);
  return { type: 'ltiResourceLink', title: opts.title, url: launchUrl(), custom: custom };
}

// Sign the Deep Linking Response (LTI-DL §3.2). iss = our client_id for this platform,
// aud = the platform issuer. Echoes deployment_id and the opaque settings.data.
function buildDeepLinkingResponse(args) {
  var platform = args.platform || {};
  var settings = args.settings || {};
  var payload = {};
  payload.iss = platform.clientId;
  payload.aud = platform.issuer;
  payload[LTI + 'message_type'] = 'LtiDeepLinkingResponse';
  payload[LTI + 'version']      = '1.3.0';
  payload[LTI + 'deployment_id'] = args.deploymentId;
  payload[DL + 'content_items'] = args.contentItems || [];
  if (settings.data !== undefined) payload[DL + 'data'] = settings.data;
  return ltiKeys.signJwt(payload, { expiresIn: '5m' });
}

module.exports = {
  assignmentContentItem: assignmentContentItem,
  linkContentItem: linkContentItem,
  buildDeepLinkingResponse: buildDeepLinkingResponse
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-deeplinking.js`
Expected: `PASS 13`.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiDeepLinking.js scripts/test-lti-deeplinking.js
git commit -m "feat(lti): ltiDeepLinking seam — content items + signed DL response"
```

---

## Task 2: Advertise Deep Linking in registration

**Files:**
- Modify: `lib/util/ltiRegistration.js:106-111` (`buildToolConfiguration`)
- Modify (update existing test): `scripts/test-lti-registration-pure.js:29-34`

**Interfaces:**
- Produces: `buildToolConfiguration()` now advertises the `LtiDeepLinkingRequest` message with the `assignment_selection` placement (course/topic `link_selection` added in Task 12) and **no** AGS scope yet (added in Task 10).

- [ ] **Step 1: Update the existing pure-registration test** so it asserts Deep Linking is advertised. In `scripts/test-lti-registration-pure.js`, replace the `ResourceLink only, no AGS` assertion (around line 29-34) with:

```javascript
.then(function(){ return check('buildToolConfiguration advertises DeepLinking + assignment placement', function(){
  var reg = ltiRegistration.buildToolConfiguration();
  var cfg = reg['https://purl.imsglobal.org/spec/lti-tool-configuration'];
  var types = cfg.messages.map(function(m){ return m.type; });
  assert.ok(types.indexOf('LtiResourceLinkRequest') >= 0, 'still advertises ResourceLink');
  assert.ok(types.indexOf('LtiDeepLinkingRequest') >= 0, 'advertises DeepLinking');
  var dlMsg = cfg.messages.filter(function(m){ return m.type === 'LtiDeepLinkingRequest'; })[0];
  assert.ok(dlMsg.placements.indexOf('assignment_selection') >= 0, 'DL offers assignment_selection');
  assert.ok(JSON.stringify(reg).indexOf('lti-ags/scope/score') < 0, 'no AGS score scope yet (Task 10)');
}); })
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-pure.js`
Expected: FAIL — `advertises DeepLinking`.

- [ ] **Step 3: Edit `buildToolConfiguration`** in `lib/util/ltiRegistration.js`. Replace the `messages` line (currently `messages: [{ type: 'LtiResourceLinkRequest' }]` at line 110) with:

```javascript
    messages: [
      { type: 'LtiResourceLinkRequest' },
      { type: 'LtiDeepLinkingRequest', placements: ['assignment_selection'] }
    ]
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-pure.js`
Expected: PASS (all checks).

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiRegistration.js scripts/test-lti-registration-pure.js
git commit -m "feat(lti): advertise LtiDeepLinkingRequest + assignment_selection in registration"
```

---

## Task 3: Deep-linking launch fork → picker redirect

**Files:**
- Modify: `lib/controllers/lti.js` (the `launch` handler, message-type area at `:211-217`; add a `deepLinkPicker` export)
- Modify: `config/routes.js` (add the picker route near `:438-456`)
- Test: `scripts/test-lti-deeplinking-launch.js`

**Interfaces:**
- Consumes: `ltiVerify.verifyLaunchToken`, `ltiProvision.provisionUser`, `ltiInstructorAuthority.resolveInstructor`, `ltiRoles.isTeacherRole`, the session (`request.yar`).
- Produces: when `message_type === 'LtiDeepLinkingRequest'`, the launch provisions the instructor, stores `{ deep_link_return_url, data, deploymentId, platformIss, platformCid }` in `request.yar` under key `ltiDeepLink`, and redirects to `/lti/deep-link`.

**Implementation note:** in `launch`, the message-type check at line 212 currently throws on anything but `LtiResourceLinkRequest`. Split it: branch on the value.

- [ ] **Step 1: Write the failing test.** Model on `scripts/test-lti-launch.js` (copy its require-shim + `makeReply`/`runLaunch` harness). Drive `lti.launch` with an id_token whose `message_type` is `LtiDeepLinkingRequest` and a `deep_linking_settings` claim; assert the reply is a redirect to `/lti/deep-link` and that `yar.set` captured the return url + data. Key assertions:

```javascript
var DL = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
// ...build an id_token with:
//   claims[LTI+'message_type'] = 'LtiDeepLinkingRequest'
//   claims[DL+'deep_linking_settings'] = { deep_link_return_url: 'https://lms.example/return', data: 'd1' }
// and an instructor roles claim.
var r = await runLaunch(state(nonce), await idToken({ nonce: nonce, messageType: 'LtiDeepLinkingRequest', dlSettings: { deep_link_return_url: 'https://lms.example/return', data: 'd1' } }));
ok(r.redirect === '/lti/deep-link', 'DL launch redirects to the picker');
ok(savedSession.ltiDeepLink && savedSession.ltiDeepLink.deep_link_return_url === 'https://lms.example/return', 'return url stored in session');
ok(savedSession.ltiDeepLink.data === 'd1', 'opaque data stored in session');
```

(Extend the harness's `yar` stub so `set(k,v)` records into `savedSession`, and extend the test's `idToken()` builder to set `message_type` and the `deep_linking_settings` claim from options.)

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-deeplinking-launch.js`
Expected: FAIL — DL launch currently rejected with `Unsupported message_type`.

- [ ] **Step 3: Implement the fork.** In `lib/controllers/lti.js`, require the seam at the top (`var ltiDeepLinking = require('../util/ltiDeepLinking');`) and a constant `var DL = 'https://purl.imsglobal.org/spec/lti-dl/claim/';`. Replace the message-type check (lines 211-217) with:

```javascript
          // 5. message type + version.
          var messageType = claims[LTI + 'message_type'];
          if (messageType !== 'LtiResourceLinkRequest' && messageType !== 'LtiDeepLinkingRequest') {
            throw Boom.badRequest('Unsupported message_type.');
          }
          if (claims[LTI + 'version'] !== '1.3.0') {
            throw Boom.badRequest('Unsupported LTI version.');
          }
```

Then inside the `ltiNonceStore.checkAndRecord(...).then(function(fresh){...})` block, after the `fresh` check and before the existing provisioning, branch for deep linking:

```javascript
            if (messageType === 'LtiDeepLinkingRequest') {
              var dlSettings = claims[DL + 'deep_linking_settings'] || {};
              var email0 = (claims.email || '').toLowerCase();
              var lmsTeacher0 = ltiRoles.isTeacherRole(claims[LTI + 'roles']);
              return ltiInstructorAuthority.resolveInstructor({ email: email0, lmsTeacher: lmsTeacher0 })
                .catch(function () { return false; })
                .then(function (isInstructor0) {
                  return ltiProvision.provisionUser(claims, platform, { isInstructor: isInstructor0 }).then(function (user) {
                    request.yar.reset();
                    request.yar._logIn(user, function () {});
                    request.yar.set('ltiDeepLink', {
                      deep_link_return_url: dlSettings.deep_link_return_url,
                      data: dlSettings.data,
                      deploymentId: deploymentId,
                      platformIss: platform.issuer,
                      platformCid: platform.clientId
                    });
                    return reply().redirect('/lti/deep-link');
                  });
                });
            }
```

(The existing `LtiResourceLinkRequest` provisioning stays as the `else` path — leave it unchanged below this branch.)

- [ ] **Step 4: Add the picker route.** In `config/routes.js`, after the `POST /lti/launch` entry (around line 456), add:

```javascript
  {
    route : 'GET /lti/deep-link lti.deepLinkPicker',
    html  : 'lti/deep-link-picker.html',
    config: { auth: 'session' }
  },
```

(Implement `deepLinkPicker` minimally in Task 4; a stub that renders the view is enough for this task's redirect test, which does not hit the route.)

- [ ] **Step 5: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-deeplinking-launch.js`
Expected: PASS. Then re-run `scripts/test-lti-launch.js` to confirm the normal ResourceLink path still passes.

- [ ] **Step 6: Commit**

```bash
git add lib/controllers/lti.js config/routes.js scripts/test-lti-deeplinking-launch.js
git commit -m "feat(lti): fork deep-linking launches to the picker"
```

---

## Task 4: Picker — list the instructor's courses & assignments

**Data model (verified against the code — read before implementing):** `Course.lessons` is an array of **lesson ids** (`ref: 'Lesson'`); `Lesson.materials` is an array of **material ids** (`ref: 'Material'`); `Material` has `name` (its title) and `type` (`'page'|'assignment'`, default `'page'`) and **no** back-reference to its course/lesson. So the picker must traverse Course → Lesson → Material. This is **not a hot path** (an instructor sets up an assignment occasionally), so the per-course traversal is acceptable; resolve in parallel. The owned-courses method is `Course.findForUser(userId, cb)` (a `model.js` classMethod that queries `{ _owner: userId }` — confirmed at `lib/models/model.js:197`; it is callback-style and takes `request.user.id`, NOT the username). `Lesson.findById(id)` and `Material.findById(id)` return promises.

**Files:**
- Modify: `lib/controllers/lti.js` (add `deepLinkPicker` + requires for `Course`, `Lesson`, `Material`)
- Create: `lib/views/lti/deep-link-picker.html`
- Test: `scripts/test-lti-deeplink-picker.js`

**Interfaces:**
- Consumes: `request.user` (the session user from Task 3); `Course.findForUser(userId, cb)` → owned courses (each has `lessons: [lessonId]`); `Lesson.findById(lessonId)` → `{ materials: [materialId] }`; `Material.findById(materialId)` → `{ id, name, type }`; `request.yar.get('ltiDeepLink')`.
- Produces: `deepLinkPicker(request, reply)` renders the picker with `{ courses: [{ id, name, slug, assignments: [{ materialId, title }] }], returnConfigured: Boolean }`. If `request.yar.get('ltiDeepLink')` is absent → `request.fail({ message: 'Deep linking session expired — relaunch from your LMS.' })`.

- [ ] **Step 1: Write the failing test** (`scripts/test-lti-deeplink-picker.js`). Use the `Module._load` shim to stub `../models/course`, `../models/lesson`, `../models/material`, and require only `lib/controllers/lti`. Set up: the user owns course A (`lessons:['L1']`) and course B (`lessons:['L2']`); `Lesson.findById('L1')` → `{ materials:['M1','M2'] }`, `Lesson.findById('L2')` → `{ materials:['M3'] }`; `Material.findById('M1')` → `{ id:'M1', name:'Lab 1', type:'assignment' }`, `'M2'` → `{ id:'M2', name:'Reading', type:'page' }`, `'M3'` → `{ id:'M3', name:'Notes', type:'page' }`. Stub `Course.findForUser(userId, cb)` to `cb(null, [courseA, courseB])`. Call `lti.deepLinkPicker` with a fake request whose `yar.get('ltiDeepLink')` returns `{ deep_link_return_url: 'https://lms/return' }` and a `request.success`/`request.fail` capture. Assert: `success` is called; `courses[0].assignments` is `[{ materialId:'M1', title:'Lab 1' }]` (only the assignment, not the page); `courses[1].assignments` is `[]`. Second case: `yar.get` returns `undefined` → `request.fail` is called.

```javascript
// shim sketch (model on scripts/test-lti-deeplinking.js for the Module._load pattern):
var courses = { A: { id:'A', name:'Course A', slug:'a', lessons:['L1'] },
                B: { id:'B', name:'Course B', slug:'b', lessons:['L2'] } };
var lessons = { L1:{ materials:['M1','M2'] }, L2:{ materials:['M3'] } };
var mats    = { M1:{ id:'M1', name:'Lab 1', type:'assignment' },
                M2:{ id:'M2', name:'Reading', type:'page' },
                M3:{ id:'M3', name:'Notes', type:'page' } };
var fakeCourse   = { findForUser: function(uid, cb){ cb(null, [courses.A, courses.B]); } };
var fakeLesson   = { findById: function(id){ return Promise.resolve(lessons[id]); } };
var fakeMaterial = { findById: function(id){ return Promise.resolve(mats[id]); } };
// Module._load: map /models/course$, /models/lesson$, /models/material$ to these.
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-tests node /usr/local/node/trinket/scripts/test-lti-deeplink-picker.js`
Expected: FAIL — `lti.deepLinkPicker is not a function`.

- [ ] **Step 3: Implement `deepLinkPicker`** in `lib/controllers/lti.js`. Add `var Course = require('../models/course');`, `var Lesson = require('../models/lesson');`, `var Material = require('../models/material');` at the top if not present, then:

```javascript
  // GET /lti/deep-link — the instructor picks content to return to the LMS. Session + the
  // deep_linking_settings were established by the deep-linking launch (Task 3, in request.yar).
  // Not a hot path (an instructor sets up an assignment occasionally), so the per-course
  // Course->Lesson->Material traversal is acceptable; resolve in parallel.
  deepLinkPicker: function(request, reply) {
    var dl = request.yar.get('ltiDeepLink');
    if (!dl || !dl.deep_link_return_url) {
      return request.fail({ message: 'Deep linking session expired — relaunch from your LMS.' });
    }
    return new Promise(function(resolve, reject) {
      Course.findForUser(request.user.id, function(err, courses) {
        return err ? reject(err) : resolve(courses || []);
      });
    }).then(function(courses) {
      return Promise.all(courses.map(function(course) {
        return Promise.all((course.lessons || []).map(function(lessonId) {
          return Promise.resolve(Lesson.findById(lessonId)).then(function(lesson) {
            if (!lesson) return [];
            return Promise.all((lesson.materials || []).map(function(materialId) {
              return Promise.resolve(Material.findById(materialId)).then(function(m) {
                return (m && m.type === 'assignment') ? { materialId: m.id, title: m.name } : null;
              });
            }));
          });
        })).then(function(perLesson) {
          var assignments = [].concat.apply([], perLesson).filter(Boolean);
          return { id: course.id, name: course.name, slug: course.slug, assignments: assignments };
        });
      }));
    }).then(function(view) {
      return request.success({ courses: view, returnConfigured: true });
    });
  },
```

- [ ] **Step 4: Create the view** `lib/views/lti/deep-link-picker.html` — a minimal server-rendered list. Each assignment is a button that POSTs `{ targetType: 'assignment', targetId: <materialId>, title: <title> }` to `/lti/deep-link/select`; each course is a button posting `{ targetType: 'course', targetId: <courseId>, title: <name> }`. Follow the existing `lib/views/lti/*.html` markup conventions. Empty state when a course has no assignments / the instructor has no courses ("Create a course or assignment in Trinket first, then return here.").

- [ ] **Step 5: Run the test to confirm it passes**

Run: `docker exec trinket-tests node /usr/local/node/trinket/scripts/test-lti-deeplink-picker.js`
Expected: PASS.

- [ ] **Step 6: Commit** (the test is gitignored — commit only the source + view)

```bash
git add lib/controllers/lti.js lib/views/lti/deep-link-picker.html
git commit -m "feat(lti): deep-linking picker lists instructor courses + assignments"
```

---

## Task 5: Select → return the signed Deep Linking Response

**Files:**
- Modify: `lib/controllers/lti.js` (add `deepLinkSelect`)
- Create: `lib/views/lti/deep-link-response.html` (auto-submitting form)
- Modify: `config/routes.js` (add the select route)
- Test: `scripts/test-lti-deeplink-select.js`

**Interfaces:**
- Consumes: `request.payload` `{ targetType, targetId, title }`; `request.yar.get('ltiDeepLink')`; `ltiDeepLinking.assignmentContentItem` / `linkContentItem` / `buildDeepLinkingResponse`; `LtiPlatform.findByIssuer`.
- Produces: `deepLinkSelect(request, reply)` renders `deep-link-response.html` with `{ returnUrl, jwt }`; the view auto-POSTs `JWT=<jwt>` to `returnUrl`.

- [ ] **Step 1: Write the failing test.** Shim `LtiPlatform.findByIssuer` to yield `{ clientId, issuer }`; set `yar.get('ltiDeepLink')` to a settings object with `deploymentId` + `deep_link_return_url` + `data`. Call `lti.deepLinkSelect` with payload `{ targetType: 'assignment', targetId: 'm1', title: 'Lab 1' }`. Assert `request.success` is called with `{ returnUrl: 'https://lms.example/return', jwt: <string> }`, and that `jwt.decode(jwt)` shows `content_items[0].custom.trinket_assignment === 'm1'` and the echoed `data`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-deeplink-select.js`
Expected: FAIL — `lti.deepLinkSelect is not a function`.

- [ ] **Step 3: Implement `deepLinkSelect`** in `lib/controllers/lti.js`:

```javascript
  // POST /lti/deep-link/select — build the content item the instructor chose and return the signed
  // Deep Linking Response for auto-POST back to the platform's deep_link_return_url.
  deepLinkSelect: function(request, reply) {
    var dl = request.yar.get('ltiDeepLink');
    if (!dl || !dl.deep_link_return_url) {
      return request.fail({ message: 'Deep linking session expired — relaunch from your LMS.' });
    }
    var b = request.payload || {};
    var item = (b.targetType === 'assignment')
      ? ltiDeepLinking.assignmentContentItem({ materialId: b.targetId, title: b.title, scoreMaximum: 1 })
      : ltiDeepLinking.linkContentItem({ targetType: b.targetType, targetId: b.targetId, title: b.title });
    return new Promise(function(resolve) {
      LtiPlatform.findByIssuer(dl.platformIss, dl.platformCid, function(err, platform) {
        resolve(platform);
      });
    }).then(function(platform) {
      if (!platform) return request.fail({ message: 'Unknown platform for this deep-linking session.' });
      var token = ltiDeepLinking.buildDeepLinkingResponse({
        platform: platform, deploymentId: dl.deploymentId,
        settings: { deep_link_return_url: dl.deep_link_return_url, data: dl.data },
        contentItems: [item]
      });
      return request.success({ returnUrl: dl.deep_link_return_url, jwt: token });
    });
  },
```

- [ ] **Step 4: Create** `lib/views/lti/deep-link-response.html` — a body-onload auto-submitting form:

```html
<form id="dl" method="post" action="{{ returnUrl }}">
  <input type="hidden" name="JWT" value="{{ jwt }}"/>
</form>
<script>document.getElementById('dl').submit();</script>
```

(Match the existing `lib/views/lti/register-close.html` conventions for the surrounding template.)

- [ ] **Step 5: Add the select route** in `config/routes.js` after the picker route:

```javascript
  {
    route : 'POST /lti/deep-link/select lti.deepLinkSelect',
    html  : 'lti/deep-link-response.html',
    config: { auth: 'session' }
  },
```

- [ ] **Step 6: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-deeplink-select.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/controllers/lti.js lib/views/lti/deep-link-response.html config/routes.js scripts/test-lti-deeplink-select.js
git commit -m "feat(lti): select returns the signed Deep Linking Response"
```

---

## Task 6: `LtiResourceLink` — line-item field + assignment lookup; capture on launch

**Files:**
- Modify: `lib/models/ltiResourceLink.js:6-22`
- Modify: `lib/util/ltiTarget.js`
- Test: `scripts/test-lti-target-assignment.js`

**Interfaces:**
- Produces:
  - `LtiResourceLink.agsLineItemUrl` (String) on the schema.
  - `LtiResourceLink.findAssignmentLink(courseId, materialId, cb)` → the assignment link for `(courseId, targetId=materialId, targetType='assignment')`.
  - `ltiTarget.resolveTarget` now also resolves the `trinket_assignment` custom param to the assignment's course **and** captures `agsLineItemUrl` from the launch's AGS endpoint claim (write-once).

- [ ] **Step 1: Write the failing test** (`scripts/test-lti-target-assignment.js`). Stub `Course` + `LtiResourceLink` via the shim. Drive `ltiTarget.resolveTarget(claims, platform)` with a `custom.trinket_assignment` and an AGS `endpoint` claim carrying `lineitem`. Assert: it resolves the assignment's course, persists an `LtiResourceLink` with `targetType:'assignment'`, `targetId` = the material id, and `agsLineItemUrl` = the claim's `lineitem`. Add a second case: a re-launch where the link already has `agsLineItemUrl` does **not** re-write (capture write-once).

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-target-assignment.js`
Expected: FAIL.

- [ ] **Step 3: Add the field + query** in `lib/models/ltiResourceLink.js`:

```javascript
var schema = {
  platformId     : { type: String, required: true },
  resourceLinkId : { type: String, required: true },
  contextId      : { type: String },
  courseId       : { type: String },
  targetType     : { type: String },   // course | topic | assignment
  targetId       : { type: String },
  agsLineItemUrl : { type: String }    // AGS line-item endpoint, captured write-once on launch
};

function findByLink(platformId, resourceLinkId, cb) {
  return this.model.findOne({ platformId: platformId, resourceLinkId: resourceLinkId }, cb);
}

function findAssignmentLink(courseId, materialId, cb) {
  return this.model.findOne(
    { courseId: courseId, targetId: materialId, targetType: 'assignment' }, cb);
}

var LtiResourceLink = model.create('LtiResourceLink', {
  schema: schema,
  classMethods: { findByLink: findByLink, findAssignmentLink: findAssignmentLink }
}).publicModel;
```

- [ ] **Step 4: Extend `resolveTarget`** in `lib/util/ltiTarget.js` to handle `trinket_assignment` and capture the line item. Read the AGS endpoint claim and the assignment custom param:

```javascript
var AGS = 'https://purl.imsglobal.org/spec/lti-ags/claim/';
// inside resolveTarget, after the existing trinket_course branch fails to resolve:
//   var endpoint = claims[AGS + 'endpoint'] || {};
//   var lineItemUrl = endpoint.lineitem;
//   var materialId = custom.trinket_assignment;
// Resolve the material -> its course, persist an assignment LtiResourceLink with agsLineItemUrl
// (only writing agsLineItemUrl when absent on an existing record — write-once).
```

Implementation: resolve `Material.findById(materialId)` → its `courseId` → `Course.findById`. Persist/refresh the `LtiResourceLink` (`targetType:'assignment'`, `targetId: materialId`, `agsLineItemUrl: lineItemUrl`). On an existing record that already has `agsLineItemUrl`, do not re-write (CLAUDE.md). Return `{ course: course, targetType: 'assignment' }`. (Use `require('../models/material')` for `Material`.)

- [ ] **Step 5: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-target-assignment.js`
Expected: PASS. Re-run `scripts/test-lti-launch.js` (course resolution unchanged).

- [ ] **Step 6: Commit**

```bash
git add lib/models/ltiResourceLink.js lib/util/ltiTarget.js scripts/test-lti-target-assignment.js
git commit -m "feat(lti): resolve assignment targets + capture AGS line-item write-once"
```

---

## Task 7: `ltiServiceToken` — client-assertion → cached AGS bearer

**Files:**
- Create: `lib/util/ltiServiceToken.js`
- Test: `scripts/test-lti-service-token.js`

**Interfaces:**
- Consumes: `ltiKeys.signJwt`; global `fetch`; `LtiPlatform` fields `clientId`, `authTokenUrl`.
- Produces: `getToken(platform, scope)` → `Promise<string>` (a bearer access token), cached per `(platform.id + scope)` until ~60s before expiry. `_clearCache()` for tests.

- [ ] **Step 1: Write the failing test.** Stand up a local HTTP server (like `test-lti-launch.js`) that asserts the POST body is `grant_type=client_credentials`, `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, a `client_assertion` JWT, and `scope`; respond `{ access_token: 'tok-1', expires_in: 3600 }`. Assert `getToken` returns `'tok-1'`, that a second call is served from cache (server hit once), and that the `client_assertion` (decoded) has `iss === sub === platform.clientId` and `aud === authTokenUrl`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-service-token.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/util/ltiServiceToken.js`:**

```javascript
// LTI Advantage service token: client_credentials grant with a private_key_jwt client-assertion
// (signed by the Tool key). Caches the bearer per (platform, scope). Pure HTTP + crypto; portable.
'use strict';
var crypto  = require('crypto');
var ltiKeys = require('./ltiKeys');

var JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
var _cache = {};   // key -> { token, expiresAt }

function clientAssertion(platform) {
  var now = Math.floor(Date.now() / 1000);
  return ltiKeys.signJwt({
    iss: platform.clientId,
    sub: platform.clientId,
    aud: platform.authTokenUrl,
    iat: now,
    jti: crypto.randomBytes(16).toString('hex')
  }, { expiresIn: '5m' });
}

function getToken(platform, scope) {
  var key = String(platform.id) + '|' + scope;
  var hit = _cache[key];
  if (hit && hit.expiresAt > Date.now() + 60000) return Promise.resolve(hit.token);

  var body = new URLSearchParams();
  body.set('grant_type', 'client_credentials');
  body.set('client_assertion_type', JWT_BEARER);
  body.set('client_assertion', clientAssertion(platform));
  body.set('scope', scope);

  return fetch(platform.authTokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  }).then(function(res) {
    if (!res.ok) throw new Error('AGS token endpoint returned HTTP ' + res.status);
    return res.json();
  }).then(function(json) {
    var ttl = (json.expires_in || 3600) * 1000;
    _cache[key] = { token: json.access_token, expiresAt: Date.now() + ttl };
    return json.access_token;
  });
}

module.exports = { getToken: getToken, _clearCache: function() { _cache = {}; } };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-service-token.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiServiceToken.js scripts/test-lti-service-token.js
git commit -m "feat(lti): ltiServiceToken — cached client-credentials AGS bearer"
```

---

## Task 8: `ltiAgs` — build + POST the "submitted" Score

**Files:**
- Create: `lib/util/ltiAgs.js`
- Test: `scripts/test-lti-ags.js`

**Interfaces:**
- Consumes: `ltiServiceToken.getToken`; global `fetch`.
- Produces:
  - `buildScore({ userId, reviewUrl, submittedAt })` → the Score body object (no `scoreGiven`/`scoreMaximum`).
  - `postSubmission(platform, lineItemUrl, { userId, reviewUrl, submittedAt })` → `Promise` that POSTs to `<lineItemUrl>/scores`; on HTTP 401 refreshes the token once and retries; resolves on success, **rejects** on final failure (the caller treats rejection as best-effort — Task 9).

- [ ] **Step 1: Write the failing test.** Unit-test `buildScore` shape: `activityProgress === 'Submitted'`, `gradingProgress === 'PendingManual'`, no `scoreGiven`, and `body['https://canvas.instructure.com/lti/submission']` = `{ new_submission: true, submission_type: 'basic_lti_launch', submission_data: reviewUrl, submitted_at }`. Then a local server test for `postSubmission`: assert it POSTs to `<lineItem>/scores` with `Content-Type: application/vnd.ims.lis.v1.score+json` and `Authorization: Bearer tok-1` (stub `ltiServiceToken.getToken` via the shim to return `'tok-1'`); and that a first `401` then `200` results in exactly one retry.

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-ags.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/util/ltiAgs.js`:**

```javascript
// LTI AGS — post a "submitted, pending manual grade" Score with Canvas's submission extension, so a
// trinket submission becomes reviewable in the LMS grader. NO numeric score: the human grades in the
// LMS. Pure HTTP; portable.
'use strict';
var ltiServiceToken = require('./ltiServiceToken');

var SCORE_SCOPE   = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
var SUBMISSION_EXT = 'https://canvas.instructure.com/lti/submission';

function buildScore(args) {
  var body = {
    userId: String(args.userId),
    timestamp: (args.submittedAt || new Date()).toISOString ? (args.submittedAt || new Date()).toISOString() : new Date().toISOString(),
    activityProgress: 'Submitted',
    gradingProgress: 'PendingManual'
  };
  body[SUBMISSION_EXT] = {
    new_submission: true,
    submission_type: 'basic_lti_launch',
    submission_data: args.reviewUrl,
    submitted_at: body.timestamp
  };
  return body;
}

function doPost(lineItemUrl, token, scoreBody) {
  var url = lineItemUrl.replace(/\/?$/, '') + '/scores';
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/vnd.ims.lis.v1.score+json', authorization: 'Bearer ' + token },
    body: JSON.stringify(scoreBody)
  });
}

function postSubmission(platform, lineItemUrl, args) {
  var scoreBody = buildScore(args);
  return ltiServiceToken.getToken(platform, SCORE_SCOPE).then(function(token) {
    return doPost(lineItemUrl, token, scoreBody).then(function(res) {
      if (res.status === 401) {
        ltiServiceToken._clearCache();
        return ltiServiceToken.getToken(platform, SCORE_SCOPE).then(function(t2) {
          return doPost(lineItemUrl, t2, scoreBody);
        });
      }
      return res;
    });
  }).then(function(res) {
    if (!res.ok) throw new Error('AGS score POST returned HTTP ' + res.status);
  });
}

module.exports = { buildScore: buildScore, postSubmission: postSubmission, SCORE_SCOPE: SCORE_SCOPE };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-ags.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiAgs.js scripts/test-lti-ags.js
git commit -m "feat(lti): ltiAgs — post submitted/pending-manual Score with submission extension"
```

---

## Task 9: Fire the AGS post on student submit (best-effort)

**Files:**
- Modify: `lib/models/ltiUserIdentity.js:14-21` (add `findByUserAndIss`)
- Create: `lib/util/ltiNotifySubmission.js` (the glue: resolve link → platform → student sub → post)
- Modify: `lib/controllers/course.js` (`submitAssignment` ~`:1021`, `updateMySubmission` ~`:1039`)
- Test: `scripts/test-lti-notify-submission.js`

**Interfaces:**
- Produces:
  - `LtiUserIdentity.findByUserAndIss(userId, iss, cb)` → the identity (for the student's `sub`).
  - `ltiNotifySubmission.notify(submission)` → `Promise` (always resolves; logs + swallows errors). Resolves a no-op when the submission has no LTI assignment link.

- [ ] **Step 1: Write the failing test.** Shim `LtiResourceLink.findAssignmentLink` (returns a link with `agsLineItemUrl` + `platformId`), `LtiPlatform.findById` (returns `{ id, issuer, clientId, authTokenUrl }`), `LtiUserIdentity.findByUserAndIss` (returns `{ sub: 'lms-sub-1' }`), and `ltiAgs.postSubmission` (captures args). Call `ltiNotifySubmission.notify({ courseId:'c1', materialId:'m1', _creator:'u1', id:'sub1', submittedOn: new Date() })`. Assert `postSubmission` was called with the captured lineItem URL, `userId:'lms-sub-1'`, and `reviewUrl` ending `/lti/review/sub1`. Second case: no assignment link → `postSubmission` NOT called, promise still resolves. Third case: `postSubmission` rejects → `notify` still resolves (best-effort).

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-notify-submission.js`
Expected: FAIL.

- [ ] **Step 3: Add the identity query** in `lib/models/ltiUserIdentity.js`:

```javascript
function findByIssSub(iss, sub, cb) {
  return this.model.findOne({ iss: iss, sub: sub }, cb);
}

function findByUserAndIss(userId, iss, cb) {
  return this.model.findOne({ userId: userId, iss: iss }, cb);
}

var LtiUserIdentity = model.create('LtiUserIdentity', {
  schema: schema,
  classMethods: { findByIssSub: findByIssSub, findByUserAndIss: findByUserAndIss }
}).publicModel;
```

- [ ] **Step 4: Implement `lib/util/ltiNotifySubmission.js`:**

```javascript
// Best-effort: when a student submits an LTI-launched assignment, announce the submission to the LMS
// gradebook (AGS Score, no grade) so it is reviewable in the LMS grader. Never throws to the caller.
'use strict';
var config          = require('config');
var LtiResourceLink = require('../models/ltiResourceLink');
var LtiPlatform     = require('../models/ltiPlatform');
var LtiUserIdentity = require('../models/ltiUserIdentity');
var ltiAgs          = require('./ltiAgs');

function findAssignmentLinkP(courseId, materialId) {
  return new Promise(function(resolve) {
    LtiResourceLink.findAssignmentLink(courseId, materialId, function(err, link) { resolve(err ? null : link); });
  });
}
function findPlatformP(id) {
  return new Promise(function(resolve) { LtiPlatform.findById(id, function(err, p) { resolve(err ? null : p); }); });
}
function findSubP(userId, iss) {
  return new Promise(function(resolve) {
    LtiUserIdentity.findByUserAndIss(userId, iss, function(err, idn) { resolve(err ? null : idn); });
  });
}

function notify(submission) {
  var userId = submission._creator && submission._creator.toString ? submission._creator.toString() : submission._creator;
  return findAssignmentLinkP(submission.courseId, submission.materialId).then(function(link) {
    if (!link || !link.agsLineItemUrl) return null;   // not an LTI assignment → no-op
    return findPlatformP(link.platformId).then(function(platform) {
      if (!platform) return null;
      return findSubP(userId, platform.issuer).then(function(identity) {
        if (!identity) return null;
        var reviewUrl = config.url + '/lti/review/' + submission.id;
        return ltiAgs.postSubmission(platform, link.agsLineItemUrl, {
          userId: identity.sub, reviewUrl: reviewUrl, submittedAt: submission.submittedOn || new Date()
        });
      });
    });
  }).catch(function(e) {
    console.error('[lti] submission notify failed (best-effort):', e && e.message);
    return null;
  });
}

module.exports = { notify: notify };
```

- [ ] **Step 5: Wire into the submit handlers.** In `lib/controllers/course.js`, add `var ltiNotifySubmission = require('../util/ltiNotifySubmission');` at the top. In `submitAssignment`, in the `.then(function(savedSubmission){ ... })` block (after `submission = savedSubmission;`, before `return request.success(...)`), add a non-blocking call:

```javascript
        submission = savedSubmission;
        ltiNotifySubmission.notify(submission);   // best-effort; never awaited, never blocks the response
        return request.success({ ... });          // (unchanged)
```

Do the same in `updateMySubmission` after its submission save (the resubmit path).

- [ ] **Step 6: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-notify-submission.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/models/ltiUserIdentity.js lib/util/ltiNotifySubmission.js lib/controllers/course.js scripts/test-lti-notify-submission.js
git commit -m "feat(lti): announce LTI assignment submissions to the LMS gradebook (best-effort)"
```

---

## Task 10: Add the AGS score scope to registration

**Files:**
- Modify: `lib/util/ltiRegistration.js` (`buildToolConfiguration`)
- Modify: `scripts/test-lti-registration-pure.js` (the Task 2 assertion)

**Interfaces:**
- Produces: `buildToolConfiguration()` now requests the AGS score scope (`scope` string + the tool-config `messages` unchanged from Task 2/12).

- [ ] **Step 1: Update the registration test.** Change the Task-2 assertion `'no AGS score scope yet (Task 10)'` to assert the score scope **is** present:

```javascript
  assert.ok(JSON.stringify(reg).indexOf('lti-ags/scope/score') >= 0, 'requests the AGS score scope');
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-pure.js`
Expected: FAIL — `requests the AGS score scope`.

- [ ] **Step 3: Add the scope** in `buildToolConfiguration` (`lib/util/ltiRegistration.js`). Change the `scope: ''` line in the `doc` object to:

```javascript
    scope: 'https://purl.imsglobal.org/spec/lti-ags/scope/score'
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-pure.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiRegistration.js scripts/test-lti-registration-pure.js
git commit -m "feat(lti): request the AGS score scope at registration"
```

---

## Task 11: Review launch → render the submission in the LMS grader

**Files:**
- Modify: `lib/controllers/lti.js` (the `launch` handler — review-target branch)
- Test: `scripts/test-lti-review-launch.js`

**Interfaces:**
- Consumes: `claims[LTI + 'target_link_uri']`; the existing provisioning + enrollment path; `Trinket.findById` (the submission, for its `lang`); the `send-submission-feedback` permission check.
- Produces: when the launch's `target_link_uri` matches `…/lti/review/<submissionId>`, the launch establishes the instructor session, enrolls them in the submission's course (`course-admin`), and redirects to `/assignment-embed-feedback/<lang>/<submissionId>`. Unauthorized launcher → `Boom.forbidden`.

- [ ] **Step 1: Write the failing test.** In the launch harness, set the id_token `target_link_uri` claim to `https://tool.example/lti/review/sub1`, instructor roles, and a `context`/`resource_link` resolving (via the stubbed `ltiTarget`) to a course. Stub `Trinket.findById('sub1')` → `{ id:'sub1', lang:'python3', courseId:'c1' }` and the user's permission check to allow. Assert the reply redirects to `/assignment-embed-feedback/python3/sub1`. Second case: permission denied → status 403.

- [ ] **Step 2: Run it to confirm it fails**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-review-launch.js`
Expected: FAIL.

- [ ] **Step 3: Implement the review branch.** In `lib/controllers/lti.js`, add `var Trinket = require('../models/trinket');` at the top, and a parser constant `var REVIEW_RE = /\/lti\/review\/([^/?#]+)/;`. In the `LtiResourceLinkRequest` path (the existing provisioning block), after the user is provisioned and the target course resolved + enrolled, but before the normal course redirect, detect a review target:

```javascript
                    var tlu = claims[LTI + 'target_link_uri'] || '';
                    var reviewMatch = REVIEW_RE.exec(tlu);
                    if (reviewMatch) {
                      var submissionId = reviewMatch[1];
                      return enrollP.then(function () {
                        if (!user.hasPermission('send-submission-feedback', 'course', { id: target.course && target.course.id })) {
                          return reply(Boom.forbidden('Not authorized to review this submission.'));
                        }
                        return Promise.resolve(Trinket.findById(submissionId)).then(function (sub) {
                          if (!sub) return reply(Boom.notFound('Submission not found.'));
                          request.yar.reset();
                          request.yar._logIn(user, function () {});
                          return reply().redirect('/assignment-embed-feedback/' + sub.lang + '/' + sub.id);
                        });
                      });
                    }
```

Place this inside the resolved-target block (where `target.course` is available and `enrollP` is defined), guarding so it only fires when `reviewMatch` is non-null; otherwise fall through to the existing `enrollP.then(...) → reply().redirect(redirectPath)`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-review-launch.js`
Expected: PASS. Re-run `scripts/test-lti-launch.js` and `scripts/test-lti-launch-authz.js` (normal launch + role mapping unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/controllers/lti.js scripts/test-lti-review-launch.js
git commit -m "feat(lti): SpeedGrader review launch renders the student submission"
```

---

## Task 12: Course/topic Deep Linking (independent placement)

**Files:**
- Modify: `lib/util/ltiRegistration.js` (`buildToolConfiguration` — add `link_selection`)
- Modify: `lib/views/lti/deep-link-picker.html` (course/topic selection — already posts `targetType: 'course'`)
- Modify: `scripts/test-lti-registration-pure.js` (assert `link_selection`)
- Test: `scripts/test-lti-deeplink-course.js`

**Interfaces:**
- Produces: registration advertises `LtiDeepLinkingRequest` with placements `['assignment_selection', 'link_selection']`; `deepLinkSelect` returns a course/topic content item (already implemented in Task 5 via `linkContentItem`).

- [ ] **Step 1: Update tests.** In `scripts/test-lti-registration-pure.js`, extend the DL assertion: `assert.ok(dlMsg.placements.indexOf('link_selection') >= 0, 'DL offers link_selection');`. Create `scripts/test-lti-deeplink-course.js` mirroring Task 5's select test but with payload `{ targetType: 'course', targetId: 'c1', title: 'My Course' }`; assert the returned JWT's `content_items[0].custom.trinket_course === 'c1'` and that it has **no** `lineItem`.

- [ ] **Step 2: Run them to confirm they fail**

Run: `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-registration-pure.js` (FAIL: `link_selection`), then `docker exec trinket-gcr node /usr/local/node/trinket/scripts/test-lti-deeplink-course.js` (PASS already if Task 5 is in — run to confirm the course path; if it fails, fix the picker view's course buttons).

- [ ] **Step 3: Add the placement** in `buildToolConfiguration`:

```javascript
      { type: 'LtiDeepLinkingRequest', placements: ['assignment_selection', 'link_selection'] }
```

- [ ] **Step 4: Run the tests to confirm they pass**

Run both scripts above.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/util/ltiRegistration.js lib/views/lti/deep-link-picker.html scripts/test-lti-registration-pure.js scripts/test-lti-deeplink-course.js
git commit -m "feat(lti): course/topic Deep Linking (link_selection placement)"
```

---

## Task 13: End-to-end manual validation on the Canvas testbed

**Files:** none (manual). Document the run in `canvas-lti-testbed` notes if useful.

This is the real proof — automated suites cover the units, but the Canvas mechanism is what we verified the design against. STEVE drives the LMS logins (Claude enters no passwords).

- [ ] **Step 1:** Re-register trinket against the local Canvas (Dynamic Registration or the manual Developer Key, per `LTI-REGISTRATION.md`), now advertising Deep Linking + the score scope.
- [ ] **Step 2:** As an instructor, add a trinket assignment via the assignment's external-tool/"Find" → confirm the picker lists your courses/assignments → select one → confirm Canvas creates the external-tool assignment **and** a gradebook column.
- [ ] **Step 3:** As a student, launch the assignment, do the work, submit. Confirm (Canvas SpeedGrader, instructor) the submission appears as "needs grading."
- [ ] **Step 4:** In SpeedGrader, open the submission → confirm trinket renders the student's work (the `assignment-embed-feedback` view) → enter a grade in SpeedGrader → confirm it lands in the Canvas gradebook and trinket stored no grade.
- [ ] **Step 5:** Add a course/topic link via Deep Linking and confirm the launch lands on the course/topic.

Record any mechanism surprises (e.g. the exact `target_link_uri` Canvas sends on the SpeedGrader re-launch) back into the spec's §3 and adjust `REVIEW_RE` / `submission_data` if the real Canvas URL shape differs from `…/lti/review/<id>`.

---

## Self-Review

**1. Spec coverage:**
- Deep Linking assignment placement → Tasks 1–5. Course/topic → Task 12. ✅
- Select-existing picker (no inline create) → Task 4 (lists existing only). ✅
- Custom-param targeting reusing `ltiTarget` → Tasks 1, 6. ✅
- AGS line-item capture write-once → Task 6. ✅
- `ltiServiceToken` + `ltiAgs` "submitted/pending-manual/no-score" POST → Tasks 7–9. ✅
- Best-effort, never blocks submit → Task 9 (`notify` always resolves; not awaited). ✅
- Review URL = plain submission id in `target_link_uri`; reuse `assignment-embed-feedback`; authorize via `send-submission-feedback` → Task 11. ✅
- Score scope at registration → Task 10. ✅
- Manual testbed validation → Task 13. ✅
- Firestore: no new per-launch writes (line-item capture folded into the existing write, write-once) → Task 6. ✅

**2. Placeholder scan:** The two implementation notes that defer exactness are explicit and bounded: (a) `Course.findByOwner` in Task 4 — confirm the real owner-listing method name at implementation; (b) the `ltiTarget` assignment-capture body in Task 6 Step 4 is described with the exact claims/fields to use. Both name the precise data and file; neither is an open "TODO". No "add error handling"/"etc." placeholders.

**3. Type consistency:** `assignmentContentItem`/`linkContentItem`/`buildDeepLinkingResponse` (Task 1) are consumed with the same signatures in Task 5. `LtiResourceLink.findAssignmentLink(courseId, materialId, cb)` (Task 6) matches its use in Task 9. `ltiServiceToken.getToken(platform, scope)` (Task 7) matches `ltiAgs` (Task 8). `ltiAgs.postSubmission(platform, lineItemUrl, {userId, reviewUrl, submittedAt})` (Task 8) matches `ltiNotifySubmission` (Task 9). `LtiUserIdentity.findByUserAndIss(userId, iss, cb)` (Task 9) is defined and used consistently. Review URL shape `…/lti/review/<id>` is identical in Task 9 (writes it) and Task 11 (`REVIEW_RE` reads it).
