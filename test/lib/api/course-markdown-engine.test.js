const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const path     = require('path');
const fs       = require('fs');
const zip      = require('adm-zip');
const nunjucks = require('nunjucks');
const { parserFor } = require(path.resolve(__dirname, '../../..', 'lib/controllers/courses.js'));

// lib/views/courses/download/base.html includes "courses/download/course.css",
// a build artifact (gitignored) normally produced by compiling
// static/scss/download/course.scss. That compile needs the vendored Foundation
// SCSS source, which isn't present in this checkout (see
// project_rehost_components_tarball backlog), so the artifact can't be
// (re)built here. Without SOME file at that path the download route 500s on
// every engine, unrelated to the markdown bug this test targets — write a
// trivial placeholder if it's missing so the test is reproducible on any
// checkout/CI run, not just a machine where a maintainer created it by hand.
// Its content is never asserted on and is irrelevant to markdown rendering.
var COURSE_CSS_PATH = path.resolve(__dirname, '../../../lib/views/courses/download/course.css');
if (!fs.existsSync(COURSE_CSS_PATH)) {
  fs.writeFileSync(COURSE_CSS_PATH,
    '/* test placeholder: see comment in test/lib/api/course-markdown-engine.test.js */\n');
}

// The download handler (lib/controllers/courses.js) calls nunjucks.render()
// (global, synchronous) to render each material's HTML page. In production
// the global nunjucks environment gets configured by the exports worker
// (lib/workers/exports.js); that worker never runs in the test process, so
// without this the download route 500s with "template not found:
// courses/download/view.html". Same pattern as test/lib/api/trinket.test.js.
// The real app registers custom filters (cachePrefix, json, translate...) on
// the Environment instance built in lib/util/nunjucks.js, which is never the
// module-level default the bare nunjucks.render() call above uses. The
// download template chain (base.html) only needs `cachePrefix` (for a
// hardcoded MathJax asset path, unrelated to markdown content) — stub it as
// a passthrough so the template compiles.
var __nunjucksEnv = nunjucks.configure(path.join(__dirname, '../../../lib/views'));
__nunjucksEnv.addFilter('cachePrefix', function(src) { return src; });

// Reset the cookie jar before every test.
beforeEach(() => {
  flow.cookies = {};
});

describe('partial updates must not reset course settings (reset-on-omit)', () => {
  // Course.setGlobalSettings walks the SCHEMA's keys, so before the fix any
  // key missing from the payload was reset to its schema default — a
  // name-only save silently downgraded markdownEngine to legacy (and
  // courseType to public). The Edit form happens to send some keys, but the
  // server must not depend on every client remembering every setting.
  it('keeps markdownEngine and courseType when the payload omits them', async () => {
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Omit Test', markdownEngine: 'modern', courseType: 'private' });
    expect(flow.wasOk).toBe(true);
    const created = flow.lastResponse.body.course;
    expect(created.globalSettings.markdownEngine).toBe('modern');
    expect(created.globalSettings.courseType).toBe('private');

    await flow.updateCourse(created.id, { name: 'Omit Test Renamed' });
    expect(flow.wasOk).toBe(true);
    const updated = flow.lastResponse.body.course;
    expect(updated.name).toBe('Omit Test Renamed');
    expect(updated.globalSettings.markdownEngine, 'a name-only save must not downgrade the engine').toBe('modern');
    expect(updated.globalSettings.courseType, 'a name-only save must not reset courseType').toBe('private');
  });
});

describe('Course export markdown engine selection', () => {
  describe('parserFor function (unit)', () => {
    it('selects legacy parser for courses without markdownEngine setting', () => {
      const course = {};
      const parser = parserFor(course);
      expect(typeof parser).toBe('function');
      const html = parser('*italics*');
      expect(html).toContain('<em>italics</em>');
    });

    it('selects modern parser for courses with markdownEngine=modern', () => {
      const course = { globalSettings: { markdownEngine: 'modern' } };
      const parser = parserFor(course);
      expect(typeof parser).toBe('function');
      const html = parser('- [x] task');
      expect(html).toContain('type="checkbox"');
    });
  });

  // Rounds 2-3 history: this describe block used to carry three "RED PROOF"
  // tests that called parserFor() directly (never touching line 309 of
  // lib/controllers/courses.js). Reverting line 309 to the old
  // parserFor(fullCourse) bug left them green, because they only exercised
  // parserFor's own selection logic, not what the download handler passes to
  // it. Demoted to a plain discriminator sanity check; the real regression
  // coverage for line 309 is the download-route integration block below,
  // which drives GET .../download.zip and DOES fail on revert (see
  // task-8-report.md Round 4 for the captured red-proof output).
  // DISCRIMINATOR NOTE: this suite used to tell the engines apart by heading
  // ids (modern emitted none). The modern engine now reproduces legacy's
  // heading ids on purpose — course material links to those anchors — so that
  // signal is gone. The discriminator is now raw-HTML handling, verified:
  //   content: '<script>x</script>hi\n\n# Hello'
  //   legacy → '<p>&lt;script&gt;x&lt;/script&gt;hi</p>\n<h1 id="hello">Hello</h1>\n'
  //   modern → 'hi\n\n<h1 id="hello">Hello</h1>\n'
  // i.e. legacy ESCAPES the raw script tag into visible text, DOMPurify
  // REMOVES it. Both engines emit the same heading, so only the
  // `&lt;script&gt;` presence separates them.
  const DISCRIMINATOR_MD = '<script>x</script>hi\n\n# Hello';

  describe('Raw-script discriminator (unit sanity — does not prove wiring)', () => {
    it('modern parser strips the raw script tag entirely', () => {
      const html = parserFor({ globalSettings: { markdownEngine: 'modern' } })(DISCRIMINATOR_MD);
      expect(html).not.toContain('&lt;script&gt;');
      expect(html).toContain('Hello');
    });

    it('legacy parser escapes the raw script tag into visible text', () => {
      const html = parserFor({})(DISCRIMINATOR_MD);
      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('Hello');
    });
  });

  // Real regression coverage for lib/controllers/courses.js line ~309
  // (`parserFor(course)(info.content)` inside the download handler). Drives
  // the actual HTTP route so a revert to the old `parserFor(fullCourse)` bug
  // (fullCourse is a stripped rendering object with no globalSettings) makes
  // these tests FAIL — proven by temporarily reverting and capturing the
  // failure (see task-8-report.md Round 4).
  describe('Download route integration (drives the real download handler)', () => {
    it('modern-engine course: downloaded HTML has the raw script REMOVED (line 309 must pass `course`, not `fullCourse`)', async () => {
      await flow.switchUser('user');
      await flow.createCourse({ name: 'Modern Engine Download Test', markdownEngine: 'modern' });
      expect(flow.wasOk).toBe(true);
      const course = flow.lastResponse.body.course;

      await flow.addNewLesson(course.id);
      expect(flow.wasOk).toBe(true);
      const lessonId = flow.lastResponse.body.data.id;

      await flow.addNewMaterial(course.id, lessonId, { content: DISCRIMINATOR_MD });
      expect(flow.wasOk).toBe(true);

      await flow.downloadCourse(
        '/' + defaults.user.username + '/courses/' + course.slug + '/download.zip?format=html'
      );
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);

      const archive = new zip(flow.lastResponse.raw);
      const htmlEntry = archive.getEntries().find(function(e) { return /\.html$/.test(e.entryName); });
      expect(htmlEntry).toBeTruthy();
      const html = archive.readAsText(htmlEntry);

      expect(html).toContain('Hello');
      expect(html).not.toContain('&lt;script&gt;');

      // The archive manifest is what a re-import restores course settings
      // from; without markdownEngine in it, exporting and re-importing a
      // modern course silently downgrades it to legacy.
      const manifestEntry = archive.getEntries().find(function(e) { return /course\.json$/.test(e.entryName); });
      expect(manifestEntry).toBeTruthy();
      const manifest = JSON.parse(archive.readAsText(manifestEntry));
      expect(manifest.globalSettings.markdownEngine).toBe('modern');

      // The handler builds the archive under /tmp/<owner> and removes that
      // directory before replying, so nothing is left behind on the server.
      expect(fs.existsSync('/tmp/' + defaults.user.username), 'build dir removed').toBe(false);
    });

    it('legacy-engine course: downloaded HTML has the raw script ESCAPED', async () => {
      await flow.switchUser('user2');
      await flow.createCourse({ name: 'Legacy Engine Download Test', markdownEngine: 'legacy' });
      expect(flow.wasOk).toBe(true);
      const course = flow.lastResponse.body.course;

      await flow.addNewLesson(course.id);
      expect(flow.wasOk).toBe(true);
      const lessonId = flow.lastResponse.body.data.id;

      await flow.addNewMaterial(course.id, lessonId, { content: DISCRIMINATOR_MD });
      expect(flow.wasOk).toBe(true);

      await flow.downloadCourse(
        '/' + defaults.user2.username + '/courses/' + course.slug + '/download.zip?format=html'
      );
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);

      const archive = new zip(flow.lastResponse.raw);
      const htmlEntry = archive.getEntries().find(function(e) { return /\.html$/.test(e.entryName); });
      expect(htmlEntry).toBeTruthy();
      const html = archive.readAsText(htmlEntry);

      expect(html).toContain('&lt;script&gt;');
      expect(html).toContain('Hello');
    });
  });
});
