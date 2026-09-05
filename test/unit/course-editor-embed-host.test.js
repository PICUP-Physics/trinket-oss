'use strict';

// Course material must not carry the AUTHORING deploy's hostname.
//
// The course editor's "insert trinket" built its iframe src with
// trinketConfig.getUrl(), which is `protocol://apphostname + path`. That
// absolute string is then STORED in the material, so a page authored on one
// deploy keeps pointing at that deploy forever. Found when a course created on
// the cdn-test trial was opened on rba-merge-trial — the two share a Firestore,
// so the course appeared correctly and every embed pointed at the other host.
//
// The renderers are already host-agnostic (lib/views/trinket/*/*.html all use a
// bare /embed/...), so this is purely a write-time problem. It CANNOT be fixed
// on serve: getMaterial used to normalize hosts, but patchContent applies the
// editor's diff to RAW stored content, so the patch base stopped matching
// storage and every save conflicted forever (M&I #7, pinned by
// test/lib/api/editor-embed-conflict.test.js). material-parser's
// normalizeEmbedUrls is the leftover of that revert — exported, zero callers.
//
// Static markup/source assertions, as in course-editor-menu.test.js: there is
// no Angular harness here, and the controller's dependencies make executing
// insertSelectedTrinket disproportionate to what is being pinned.
const fs   = require('fs');
const path = require('path');

const TOOLBAR = path.join(__dirname, '../../public/js/courseEditor/controllers/toolbarControl.js');
const EMBED   = path.join(__dirname, '../../public/js/embed/embed.js');

const toolbar = fs.readFileSync(TOOLBAR, 'utf8');
const embedJs = fs.readFileSync(EMBED, 'utf8');

// The body of insertSelectedTrinket, so the assertions cannot be satisfied by
// some unrelated part of the file.
function insertFn() {
  const start = toolbar.indexOf('insertSelectedTrinket');
  expect(start, 'insertSelectedTrinket should exist').toBeGreaterThan(-1);
  const end = toolbar.indexOf('\n    }', start);
  expect(end).toBeGreaterThan(start);
  // Strip line comments: these assertions are about what the CODE does, and the
  // comment here explains why getUrl() is deliberately not used.
  return toolbar.slice(start, end).replace(/^\s*\/\/.*$/gm, '');
}

describe('course editor: inserted embeds are host-less', () => {
  it('builds a root-relative /embed/ src, not an absolute one', () => {
    const fn = insertFn();
    expect(fn, 'the insert should still write an embed iframe').toContain('/embed/');
    expect(fn,
      'getUrl() stamps protocol://apphostname into content that is then STORED, '
      + 'pinning the material to the deploy it was authored on')
      .not.toContain('getUrl');
  });

  it('writes no protocol or host into the stored snippet', () => {
    const fn = insertFn();
    expect(fn).not.toMatch(/https?:/);
    expect(fn).not.toMatch(/\/\/'\s*\+|\+\s*'\/\//);   // no protocol-relative //host either
  });
});

describe('the Share snippet stays absolute', () => {
  // Guard against over-correcting. The copy-paste embed code is for pasting into
  // SOMEONE ELSE'S site, where a root-relative src resolves against their host.
  it('still builds an absolute URL for external embedding', () => {
    const i = embedJs.indexOf("code  = '<iframe src=\"'");
    expect(i, 'the share snippet builder should exist').toBeGreaterThan(-1);
    const region = embedJs.slice(Math.max(0, i - 400), i + 200);
    expect(region, 'the share snippet must qualify its URL for external sites')
      .toContain('qualifyUrl');
  });

  it('qualifies against the page the user is on, not a configured host', () => {
    // Deliberate: the snippet should embed from whatever host served the editor,
    // so a user on a trial gets a trial URL rather than a config-pinned one.
    expect(embedJs).toMatch(
      /function qualifyUrl[\s\S]{0,120}window\.location\.protocol[\s\S]{0,60}window\.location\.host/);
  });
});
