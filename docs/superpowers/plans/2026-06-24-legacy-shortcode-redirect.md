# Legacy-shortcode Redirect Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated endpoint that resolves an old trinket.io shortcode to the correct new URL and 301-redirects to it, so saved links and embeds can be systematically migrated.

**Architecture:** Two thin, public, no-auth routes (`GET /legacy/{shortCode}` for the page, `GET /legacy/embed/{shortCode}` for the iframe) map to two small controller actions in `lib/controllers/trinket.js`. Both delegate to one private helper that looks a trinket up **strictly by `legacyShortCode`** (never the live-shortCode namespace, so no collision is possible), then 301-redirects to a canonical URL built from the record's own `lang` + `shortCode`. No model changes — `findByLegacyShortCodes` already exists.

**Tech Stack:** Node (Hapi 20+ via the `lib/util/routeParser.js` compatibility shim), Mongoose 6, Mocha + supertest (`test/helpers/flow.js`), Chai `should`.

## Global Constraints

- **301 permanent** redirects (not 302). Achieved with `reply().redirect(target).permanent()`.
- Resolve **only** by `legacyShortCode` (via `Trinket.findByLegacyShortCodes`), never by `_id`/`shortCode`.
- Build the redirect target from the **record's own** `lang` and `shortCode` (this auto-fixes renamed langs, e.g. old `vpython` records whose `lang` is now `glowscript`).
- Soft-deleted trinkets (`deletedAt` set) → 404.
- **No model changes.** `findByLegacyShortCodes(codes)` already exists in `lib/models/trinket.js:231`.
- Controller globals already in scope in `lib/controllers/trinket.js`: `Trinket` (global, app.js:295), `errors` (= `@hapi/boom`, top of file), `log` (global, app.js:19).
- Routes are plain entries in the `routes` array in `config/routes.js`; the parser at `lib/util/routeParser.js` turns `'GET /path controller.action'` into a Hapi route and `require('../controllers/trinket')[action]` into the handler. A route that only redirects needs **no** `html` or `success` key.

---

### Task 1: Page redirect — `GET /legacy/{shortCode}`

Adds the shared helper, the page handler, the page route, and the test fixtures + page/404/soft-delete/lang-from-record tests.

**Files:**
- Create: `test/lib/api/legacy.js`
- Modify: `test/lib/api/index.js` (register the new suite in the `sequence` array)
- Modify: `lib/controllers/trinket.js` (add `resolveLegacy` helper + `legacyRedirect` action)
- Modify: `config/routes.js` (add the `/legacy/{shortCode}` route)

**Interfaces:**
- Consumes: `Trinket.findByLegacyShortCodes([code])` → Promise<Array<trinketDoc>> (Mongoose `find`, resolves to an array; each doc has `.lang`, `.shortCode`, `.deletedAt`). `reply().redirect(url).permanent()` → 301 response. `reply(errors.notFound())` → 404 response.
- Produces: private `resolveLegacy(request, reply, isEmbed)` → Promise (used by Task 2's embed action too); controller action `trinket.legacyRedirect`.

- [ ] **Step 1: Write the failing test**

Create `test/lib/api/legacy.js` with the full file below. It creates one python trinket via the API and stamps a `legacyShortCode` on it, plus a glowscript trinket (to prove lang is read from the record) and a soft-deleted trinket, all via the model.

```javascript
var flow    = require('../../helpers/flow'),
    Trinket = require('../../../lib/models/trinket');

module.exports = function() {
  describe('Legacy shortcode redirects', function() {
    var pythonShortCode,
        glowShortCode,
        legacyPython  = 'legacy-python-001',
        legacyGlow    = 'legacy-glow-001',
        legacyDeleted = 'legacy-deleted-001';

    before(function(done) {
      // 1) a normal python trinket created through the API, then stamped
      //    with a legacyShortCode the way an import would have.
      flow.createTrinket(function() {
        pythonShortCode = flow.lastResponse.body.data.shortCode;
        var pythonId    = flow.lastResponse.body.data.id;

        Trinket.findById(pythonId, function(err, doc) {
          if (err) return done(err);
          doc.legacyShortCode = legacyPython;
          doc.save(function(err) {
            if (err) return done(err);

            // 2) a glowscript trinket — proves the redirect uses the
            //    record's own lang (old vpython codes now live as glowscript).
            new Trinket({
              code            : 'GlowScript 3.0',
              lang            : 'glowscript',
              legacyShortCode : legacyGlow
            }).save(function(err, glow) {
              if (err) return done(err);
              glowShortCode = glow.shortCode;

              // 3) a soft-deleted trinket — must resolve to 404.
              new Trinket({
                code            : 'gone',
                lang            : 'python',
                legacyShortCode : legacyDeleted,
                deletedAt       : new Date()
              }).save(function(err) {
                done(err);
              });
            });
          });
        });
      });
    });

    it('redirects a known legacy code to the new trinket page (301)', function(done) {
      flow.get('/legacy/' + legacyPython).end(function(err, res) {
        res.statusCode.should.eql(301);
        res.headers.location.should.eql('/python/' + pythonShortCode);
        done();
      });
    });

    it('builds the target from the record lang (renamed langs land correctly)', function(done) {
      flow.get('/legacy/' + legacyGlow).end(function(err, res) {
        res.statusCode.should.eql(301);
        res.headers.location.should.eql('/glowscript/' + glowShortCode);
        done();
      });
    });

    it('returns 404 for an unknown legacy code', function(done) {
      flow.get('/legacy/does-not-exist').end(function(err, res) {
        res.statusCode.should.eql(404);
        done();
      });
    });

    it('returns 404 when the matched trinket is soft-deleted', function(done) {
      flow.get('/legacy/' + legacyDeleted).end(function(err, res) {
        res.statusCode.should.eql(404);
        done();
      });
    });
  });
};
```

Then register the suite — in `test/lib/api/index.js`, add `'legacy'` to the end of the `sequence` array:

```javascript
    'forgot_pass',
    'trinket',
    'legacy'
  ];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test 2>&1 | sed -n '/Legacy shortcode redirects/,/passing/p'`
Expected: the four "Legacy shortcode redirects" tests run and **fail** — the page test gets `404` (route does not exist yet) instead of `301`. (The unknown-code test may pass for the wrong reason since the route 404s too; that's fine, the page/lang tests prove the failure.)

- [ ] **Step 3: Add the helper + page handler to the controller**

In `lib/controllers/trinket.js`, add the two new actions to the `module.exports = { ... }` object (place them next to the other public trinket actions, e.g. right after `embed`/`viewOnly`). Add **only** `legacyRedirect` in this task; `legacyEmbedRedirect` comes in Task 2:

```javascript
  legacyRedirect : function(request, reply) {
    return resolveLegacy(request, reply, false);
  },
```

Then add the private helper. Put it with the other private `function` declarations inside the IIFE (e.g. just above `downloadJSON`); function declarations hoist, so placement does not affect behavior:

```javascript
// Resolve an OLD trinket.io shortcode (stored as legacyShortCode) to the
// canonical new URL and 301-redirect to it. Looks up ONLY by legacyShortCode
// so there is no overlap with the live shortCode namespace.
function resolveLegacy(request, reply, isEmbed) {
  var code = request.params.shortCode;

  return Trinket.findByLegacyShortCodes([code])
    .then(function(trinkets) {
      var live = (trinkets || []).filter(function(t) { return !t.deletedAt; });

      if (!live.length) {
        return reply(errors.notFound());
      }

      if (live.length > 1) {
        log.warn('Multiple trinkets share legacyShortCode "' + code +
          '"; redirecting to ' + live[0].shortCode);
      }

      var trinket = live[0];
      var target  = (isEmbed ? '/embed/' : '/') + trinket.lang + '/' + trinket.shortCode;

      return reply().redirect(target).permanent();
    });
}
```

- [ ] **Step 4: Add the page route**

In `config/routes.js`, add the page route. Place it right after the legacy language-redirect block that ends with the `GET /r/{shortCode}` entry (around line 501):

```javascript
  {
    route : 'GET /legacy/{shortCode} trinket.legacyRedirect'
  },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test 2>&1 | sed -n '/Legacy shortcode redirects/,/passing/p'`
Expected: the page-redirect, lang-from-record, unknown-code, and soft-deleted tests all **PASS**. (The embed tests do not exist yet.)

- [ ] **Step 6: Commit**

```bash
git add test/lib/api/legacy.js test/lib/api/index.js lib/controllers/trinket.js config/routes.js
git commit -m "Add legacy-shortcode page redirect endpoint

GET /legacy/{shortCode} resolves an old trinket.io shortcode via
legacyShortCode and 301-redirects to the canonical /{lang}/{shortCode}.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Embed redirect — `GET /legacy/embed/{shortCode}`

Adds the embed handler (one line, reusing `resolveLegacy`), the embed route, and embed-specific tests. Reuses the fixtures created in Task 1's `before`.

**Files:**
- Modify: `test/lib/api/legacy.js` (add embed tests inside the same `describe`)
- Modify: `lib/controllers/trinket.js` (add `legacyEmbedRedirect` action)
- Modify: `config/routes.js` (add the `/legacy/embed/{shortCode}` route)

**Interfaces:**
- Consumes: private `resolveLegacy(request, reply, isEmbed)` from Task 1; `legacyPython` / `pythonShortCode` fixtures from Task 1's `before`.
- Produces: controller action `trinket.legacyEmbedRedirect`.

- [ ] **Step 1: Write the failing embed tests**

In `test/lib/api/legacy.js`, add these two `it` blocks inside the existing `describe('Legacy shortcode redirects', ...)`, after the soft-delete test:

```javascript
    it('redirects a known legacy code to the embed (301)', function(done) {
      flow.get('/legacy/embed/' + legacyPython).end(function(err, res) {
        res.statusCode.should.eql(301);
        res.headers.location.should.eql('/embed/python/' + pythonShortCode);
        done();
      });
    });

    it('returns 404 for an unknown legacy embed code', function(done) {
      flow.get('/legacy/embed/nope').end(function(err, res) {
        res.statusCode.should.eql(404);
        done();
      });
    });
```

- [ ] **Step 2: Run the embed tests to verify they fail**

Run: `npm test 2>&1 | sed -n '/Legacy shortcode redirects/,/passing/p'`
Expected: the new "embed (301)" test **fails** — `/legacy/embed/legacy-python-001` matches the page route `/legacy/{shortCode}` (shortCode = `"embed"`), finds no such legacy trinket, and returns `404` instead of `301`. (This confirms the embed route is genuinely missing.)

- [ ] **Step 3: Add the embed handler**

In `lib/controllers/trinket.js`, add the embed action next to `legacyRedirect`:

```javascript
  legacyEmbedRedirect : function(request, reply) {
    return resolveLegacy(request, reply, true);
  },
```

- [ ] **Step 4: Add the embed route**

In `config/routes.js`, add the embed route **immediately before** the page route from Task 1 (so the two sit together; Hapi matches the more-specific literal `embed` segment regardless of array order, but keeping embed first is clearer):

```javascript
  {
    route : 'GET /legacy/embed/{shortCode} trinket.legacyEmbedRedirect'
  },
  {
    route : 'GET /legacy/{shortCode} trinket.legacyRedirect'
  },
```

- [ ] **Step 5: Run the full suite to verify it passes**

Run: `npm test 2>&1 | sed -n '/Legacy shortcode redirects/,/passing/p'`
Expected: all six "Legacy shortcode redirects" tests **PASS** (page 301, lang-from-record, page 404, soft-delete 404, embed 301, embed 404).

Then confirm nothing else regressed:

Run: `npm test 2>&1 | tail -5`
Expected: the overall run shows the same pass/fail baseline as before plus the six new passing tests (no new failures introduced by this change).

- [ ] **Step 6: Commit**

```bash
git add test/lib/api/legacy.js lib/controllers/trinket.js config/routes.js
git commit -m "Add legacy-shortcode embed redirect endpoint

GET /legacy/embed/{shortCode} 301-redirects an old trinket.io shortcode
to the canonical /embed/{lang}/{shortCode}, reusing resolveLegacy.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes / deviations from the spec

- **Lookup uses `findByLegacyShortCodes` (plural), not `findByLegacyShortCode`.** The spec named the singular `findOne` helper but also asked us to *log a warning on duplicate legacy codes* — a `findOne` cannot see duplicates. The plural helper returns all matches in a single query, so we get duplicate detection (and the warning) for free, then redirect to the first non-deleted match. Same intent, no extra round-trip.
- **No Joi param validation added.** The spec mentioned mirroring "the existing trinket routes," but the sibling `/embed/{lang}/{trinketId}` and `/{lang}/{shortCode}` routes do **not** Joi-validate their code param — the route pattern guarantees a non-empty string segment. Adding validation here would only introduce a `request.fail` path with nothing to render. Skipped to match the actual sibling-route convention and keep the handler to a single concern.

## Self-review

- **Spec coverage:** page redirect (Task 1) ✓, embed redirect (Task 2) ✓, 301 permanent ✓, lookup only by legacyShortCode ✓, lang from record + rename case ✓ (glowscript test), unknown → 404 ✓, soft-deleted → 404 ✓, duplicate-code warning ✓ (helper), no model changes ✓. All five spec test cases are covered (page 301, embed 301, unknown 404, soft-deleted 404, lang-rename).
- **Placeholder scan:** none — every step has complete code/commands.
- **Type consistency:** `resolveLegacy(request, reply, isEmbed)` is defined in Task 1 and consumed unchanged in Task 2; `legacyRedirect`/`legacyEmbedRedirect` action names match the route strings exactly; fixture names (`legacyPython`, `pythonShortCode`) defined in Task 1's `before` are reused by Task 2's tests in the same `describe`.
