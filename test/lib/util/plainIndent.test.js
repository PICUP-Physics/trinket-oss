'use strict';

// The plain-text editor's indentation help (#318). Pure logic; the editor
// wiring and the real keyboard are covered by specs-deploy/exam-mode.spec.js.
const P = require('../../../public/js/plugins/plain-indent.js');

// Apply an edit the way the editor does, and return the new value.
function apply(value, edit) {
  return value.slice(0, edit.start) + edit.text + value.slice(edit.end);
}

const PY = { lang: 'glowscript', tabSize: 4 };

describe('Enter', () => {
  it('carries the current indentation onto the new line', () => {
    const v = 'while True:\n    x = 1';
    expect(P.enter(v, v.length, v.length, PY).text).toBe('\n    ');
  });

  it('goes one level deeper after a line ending in ":"', () => {
    const v = 'for i in range(3):';
    expect(P.enter(v, v.length, v.length, PY).text).toBe('\n    ');
    const w = '    if x:   ';   // trailing spaces after the colon still count
    expect(P.enter(w, w.length, w.length, PY).text).toBe('\n        ');
  });

  it('steps back out after return/pass/break/continue/raise', () => {
    for (const word of ['return x', 'pass', 'break', 'continue', 'raise ValueError()']) {
      const v = 'def f():\n        ' + word;
      expect(P.enter(v, v.length, v.length, PY).text, word).toBe('\n    ');
    }
    const top = 'pass';   // nothing to step out of
    expect(P.enter(top, 4, 4, PY).text).toBe('\n');
  });

  it('follows tab indentation instead of mixing in spaces', () => {
    const v = '\tif x:';
    expect(P.enter(v, v.length, v.length, PY).text).toBe('\n\t\t');
    const w = 'def f():\n\t\treturn 1';
    expect(P.enter(w, w.length, w.length, PY).text).toBe('\n\t');
  });

  it('uses the viewer\'s indent size', () => {
    const v = 'if x:';
    expect(P.enter(v, v.length, v.length, { lang: 'python3', tabSize: 2 }).text).toBe('\n  ');
  });

  // #367: Firestore deploys stored the setting as the form string "4", and
  // "4" + 1 built an indent of "41".
  it('takes an indent size given as a string', () => {
    const v = 'if x:';
    expect(P.enter(v, v.length, v.length, { lang: 'python3', tabSize: '4' }).text).toBe('\n    ');
    expect(P.tab('', 0, 0, { tabSize: '4' }).text).toBe('    ');
  });

  it('falls back to 2 for an indent size that is not a positive number', () => {
    const v = 'if x:';
    for (const size of ['', 'abc', 0, -3, null]) {
      expect(P.enter(v, v.length, v.length, { lang: 'python3', tabSize: size }).text, String(size)).toBe('\n  ');
    }
  });

  it('does not add a level after ":" in languages without colon blocks', () => {
    const v = '  a {color: red;}\n  b:';
    expect(P.enter(v, v.length, v.length, { lang: 'html', tabSize: 2 }).text).toBe('\n  ');
  });

  it('splits a line in the middle and keeps only the text before the caret in mind', () => {
    const v = '    x = f(a, b)';
    const at = v.indexOf(', b');
    const e = P.enter(v, at + 1, at + 1, PY);
    expect(apply(v, e)).toBe('    x = f(a,\n     b)');
  });

  it('replaces a selection', () => {
    const v = '    abc';
    const e = P.enter(v, 5, 7, PY);
    expect(apply(v, e)).toBe('    a\n    ');
  });
});

describe('Tab and Shift-Tab', () => {
  it('Tab inserts one level at the caret', () => {
    const v = 'x';
    const e = P.tab(v, 0, 0, { tabSize: 4 });
    expect(apply(v, e)).toBe('    x');
  });

  it('Tab indents every line of a multi-line selection and reselects them', () => {
    const v = 'a\nb\nc';
    const e = P.tab(v, 0, 3, { tabSize: 2 });
    expect(apply(v, e)).toBe('  a\n  b\nc');
    expect(e.select).toEqual([0, 7]);
  });

  // Copilot review on #320: Tab on a selection inside one line replaced the
  // selected code with spaces. ACE and VS Code indent the line instead, and
  // replace the selection only when it is nothing but whitespace.
  it('Tab on a one-line selection of code indents its line and keeps the code selected', () => {
    const v = 'x = abc';
    const e = P.tab(v, 4, 7, { tabSize: 4 });
    expect(apply(v, e)).toBe('    x = abc');
    expect(e.select).toEqual([8, 11]);
  });

  it('Tab on a whitespace-only selection still replaces it, as ACE does', () => {
    const v = 'a  b';
    expect(apply(v, P.tab(v, 1, 3, { tabSize: 4 }))).toBe('a    b');
  });

  it('a selection ending at the start of a line leaves that line alone', () => {
    const v = 'a\nb\nc';
    expect(apply(v, P.tab(v, 0, 4, { tabSize: 2 }))).toBe('  a\n  b\nc');
  });

  it('Shift-Tab outdents the current line and keeps the caret with its text', () => {
    const v = 'x\n      y';
    const caret = v.length;
    const e = P.tab(v, caret, caret, { tabSize: 4, shift: true });
    expect(apply(v, e)).toBe('x\n  y');
    expect(e.select).toEqual([caret - 4, caret - 4]);
  });

  it('Shift-Tab outdents a tab-indented line too (Enter keeps tabs, so they happen)', () => {
    const v = '\tfoo';
    const e = P.tab(v, v.length, v.length, { tabSize: 4, shift: true });
    expect(e).not.toBeNull();
    expect(apply(v, e)).toBe('foo');
    expect(e.select).toEqual([3, 3]);
    const w = '\t\tbar\n\t  baz';    // one tab per line, then spaces
    expect(apply(w, P.tab(w, 0, w.length, { tabSize: 4, shift: true }))).toBe('\tbar\n  baz');
  });

  it('Shift-Tab removes only what is there, and does nothing on an unindented line', () => {
    const v = ' a\n    b';
    expect(apply(v, P.tab(v, 0, v.length, { tabSize: 4, shift: true }))).toBe('a\nb');
    expect(P.tab('abc', 1, 1, { tabSize: 4, shift: true })).toBeNull();
  });
});

describe('which keys are claimed', () => {
  const key = (k, extra) => Object.assign({ key: k }, extra);

  it('Enter always', () => {
    expect(P.handleKey(key('Enter'), 'a', 1, 1, { lang: 'python3', tabSize: 2 })).not.toBeNull();
  });

  it('Tab only in exam mode — the screen-reader editor keeps Tab for moving focus', () => {
    expect(P.handleKey(key('Tab'), 'a', 1, 1, { examMode: false, tabSize: 2 })).toBeNull();
    expect(P.handleKey(key('Tab'), 'a', 1, 1, { examMode: true, tabSize: 2 })).not.toBeNull();
  });

  it('never copy, cut, paste or other shortcuts', () => {
    for (const k of ['c', 'x', 'v', 'z']) {
      expect(P.handleKey(key(k, { ctrlKey: true }), 'a', 0, 1, { examMode: true })).toBeNull();
      expect(P.handleKey(key(k, { metaKey: true }), 'a', 0, 1, { examMode: true })).toBeNull();
    }
    expect(P.handleKey(key('Enter', { ctrlKey: true }), 'a', 1, 1, { examMode: true })).toBeNull();
    expect(P.handleKey(key('Enter', { shiftKey: true }), 'a', 1, 1, { examMode: true })).toBeNull();
    expect(P.handleKey(key('Enter', { isComposing: true }), 'a', 1, 1, { examMode: true })).toBeNull();
  });
});
