const fs = require('fs');
const path = require('path');

// The injected matplotlib setup strings END by deleting names, so that nothing
// is left in pyodide.globals for the Variables tab:
//
//     _plt.show = _trinket_show
//     del _plt, _trinket_show
//
// Anything those strings DEFINE, though, outlives the setup and runs later --
// when the student clicks Save, presses Home, or resizes the pane. A function
// body resolves its globals at CALL time, so referencing a deleted name inside
// one is a NameError waiting for the first click, and nothing at setup time
// says so.
//
// That is not hypothetical: the export-dpi wrapper read `_plt.rcParams`, and
// because `del _plt` runs after it, EVERY main-thread Download would have
// raised instead of exporting -- including the ordinary numeric path, since the
// wrapper reads the rc before delegating. It survived a unit test that
// exercised the resolver in isolation, with _plt still present.
//
// So: no function defined in a setup string may reference a name that string
// deletes. Use the module (`matplotlib.rcParams`), which is never deleted, or
// bind the value at definition time.

function extractSetup(file, varName) {
  const src = fs.readFileSync(path.join(__dirname, '../../public/js/embed/', file), 'utf8');
  const open = src.indexOf('var ' + varName + ' = [');
  if (open < 0) throw new Error(`${varName} not found in ${file}`);
  const close = src.indexOf('].join(', open);
  const body = src.slice(open, close);
  // Each element is a single- or double-quoted JS string literal on its own
  // line, optionally followed by a JS line comment -- several carry one.
  const ELEMENT = /^\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*,?\s*(?:\/\/.*)?$/;
  const lines = [...body.matchAll(new RegExp(ELEMENT.source, 'gm'))]
    .map(m => {
      const t = m[1];
      return t[0] === "'"
        ? t.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
        : JSON.parse(t);
    });
  if (!lines.length) throw new Error(`extracted no lines from ${varName}`);

  // The extractor MUST NOT silently skip a line it cannot parse -- a dropped
  // line is invisible to every check built on this, which turns the whole file
  // into decoration. Found exactly that way: a trailing `// comment` after a
  // string literal made the line vanish and a deliberately broken build still
  // passed. So account for every line in the block.
  const inBlock = body.split('\n').slice(1)               // drop `var X = [`
    .filter(l => l.trim() && !/^\s*\/\//.test(l));       // blanks and JS comments
  if (inBlock.length !== lines.length) {
    const unparsed = inBlock.filter(l => !ELEMENT.test(l));
    throw new Error(
      `${varName}: extracted ${lines.length} of ${inBlock.length} lines; ` +
      `could not parse:\n${unparsed.slice(0, 5).join('\n')}`);
  }
  return lines;
}

// Names the string deletes, from any `del a, b` statement.
function deletedNames(lines) {
  const out = new Set();
  for (const line of lines) {
    const m = /^\s*del\s+(.+?)\s*$/.exec(line);
    if (m) m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(n => out.add(n));
  }
  return out;
}

// Line ranges belonging to a `def`, by indentation. Comments are ignored: a
// deleted name may perfectly well be DISCUSSED inside one.
function functionBodyLines(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const def = /^(\s*)def\s+\w+\s*\(/.exec(lines[i]);
    if (!def) continue;
    const indent = def[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) continue;
      const lead = line.length - line.replace(/^\s*/, '').length;
      if (lead <= indent) break;
      if (/^\s*#/.test(line)) continue;
      out.push({ line, n: j + 1 });
    }
  }
  return out;
}

const SETUPS = [
  ['pyodide.js', 'MATPLOTLIB_SETUP_CODE'],
  ['pyodide-worker.js', 'MPL_SETUP'],
];

describe('injected matplotlib setup: deleted names must not be used at call time', () => {
  for (const [file, varName] of SETUPS) {
    it(`${varName} (${file}) defines nothing that resolves a deleted global`, () => {
      const lines = extractSetup(file, varName);
      const deleted = deletedNames(lines);
      if (!deleted.size) return;               // nothing deleted, nothing to check

      const offences = [];
      for (const { line, n } of functionBodyLines(lines)) {
        for (const name of deleted) {
          // Word-boundary, and not an attribute access like `x._plt`.
          const re = new RegExp(`(^|[^\\w.])${name}\\b`);
          if (re.test(line)) offences.push(`${varName} line ${n}: ${name} in "${line.trim()}"`);
        }
      }
      expect(offences, offences.join('\n')).toEqual([]);
    });
  }

  // Guard the guard: the extraction and the del-parsing have to actually work,
  // or the test above passes by finding nothing.
  it('extracts real Python and finds the del statements', () => {
    for (const [file, varName] of SETUPS) {
      const lines = extractSetup(file, varName);
      expect(lines.length, `${varName} is non-trivial`).toBeGreaterThan(20);
      expect(lines.some(l => /^import |^from /.test(l)), `${varName} looks like Python`).toBe(true);
      expect(functionBodyLines(lines).length, `${varName} defines functions`).toBeGreaterThan(5);
    }
    // The main-thread string is the one that deletes; if that ever stops being
    // true the first test becomes vacuous and this says so.
    expect([...deletedNames(extractSetup('pyodide.js', 'MATPLOTLIB_SETUP_CODE'))].sort())
      .toEqual(['_plt', '_trinket_show']);
  });
});
