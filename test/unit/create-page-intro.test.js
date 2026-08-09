'use strict';
// picup #115: the New-Python-trinket page promised "the examples below" and a
// Console mode. The examples gallery is populated from
// GET /api/trinkets/{lang}/list?name=examples — a curated list that existed on
// trinket.io and ships EMPTY in the open-source release — so the sentence
// referred to content no self-hosted deployment has.
const fs   = require('fs');
const path = require('path');

const HTML = fs.readFileSync(
  path.join(__dirname, '../../public/js/library/trinkets/create/create.html'), 'utf8');

// the python3 section only
const PY3 = HTML.slice(
  HTML.indexOf("lang == 'python3'"),
  HTML.indexOf("lang == 'java'")
);

describe('New-trinket page, python3 intro (#115)', () => {
  it('does not promise examples unconditionally', () => {
    // Any mention of the examples must be inside a directive that hides it when
    // the gallery is empty, exactly as the gallery itself does.
    const mentions = PY3.match(/[^<>]*examples below[^<>]*/gi) || [];
    mentions.forEach((m) => {
      const before = PY3.slice(0, PY3.indexOf(m));
      const openTag = before.lastIndexOf('<span');
      const tag = PY3.slice(openTag, PY3.indexOf('>', openTag) + 1);
      expect(tag, 'the examples sentence must be gated').toMatch(/ng-if=/);
    });
  });

  it('gates the examples wording on the same condition as the gallery', () => {
    expect(PY3).toContain('ng-if="examples && iframeUrl"');
    expect(HTML).toContain('ng-show="examples && iframeUrl"');   // the gallery
  });

  it('offers wording for the case where there are no examples', () => {
    expect(PY3).toContain('ng-if="!(examples && iframeUrl)"');
  });

  it('does not instruct the student to pick Console from the Run menu', () => {
    // On picup/main the Pyodide runner has no console branch, so the instruction
    // describes something that does nothing. PR #114 implements the REPL and
    // makes it true again — restore the sentence in the same pass that merges it.
    expect(PY3).not.toMatch(/Console from the Run menu/i);
  });

  it('points at what does work today for input', () => {
    expect(PY3).toContain('console.input');
  });
});
