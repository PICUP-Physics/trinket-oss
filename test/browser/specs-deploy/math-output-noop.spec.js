const { test, expect, devices } = require('@playwright/test');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The #247 gate: features.mathOutput is a no-op for programs that do not ask
// for typeset output.
//
// WHY THIS EXISTS. The deploy-wide flag is safe only because the feature
// changes nothing for existing trinkets (#239, Andrew's condition): bare ints,
// strings, plain lists, matplotlib return values and module docstrings all stay
// silent, and only objects with `_repr_latex_` display. #247 made that
// "testable rather than arguable" the gate before the flag goes near
// trinket.gopicup.org. This file is that test.
//
// WHAT IT ASSERTS, per program, comparing a flag-OFF run with a flag-ON run of
// the same deploy:
//   1. #console-output text is IDENTICAL once the math cards are taken out --
//      and a program that produced no cards must be identical outright. The
//      one allowance: the first typeset card of a page announces KaTeX with a
//      single "Loading math…" line (ensureKatex() in pyodide.js), which is part
//      of the card, not a change to the program's own output. It is removed
//      only where it sits immediately before a card, so a program that prints
//      the same words itself is still compared.
//   2. no .math-card appears unless the program imports SymPy, or the corpus
//      entry expects one. SymPy is the common case, not the rule: the feature
//      typesets ANY object that defines _repr_latex_, so numpy polynomials
//      typeset too (numpy-polynomial below). A stored trinket that typesets
//      without SymPy still FAILS here -- by design, and for this gate that is a
//      visible change to an existing trinket, which is what #247 exists to show.
//   3. flag-OFF produces no .math-card at all, ever.
//
// HOW IT IS INVOKED. By a person -- nothing runs this file automatically.
// specs-deploy/ is run by no workflow (#293: browser-smoke.yml ends with a bare
// `npx playwright test`, which takes the default config and testDir ./specs).
// The flag is read at server boot, so off and on are two runs of this file
// against ONE deploy, with the flag flipped and the server restarted between
// them. Order does not matter; the second run does the comparing.
//
//   # 1. flag off
//   TRINKET_BASE_URL=http://localhost:3000 npx playwright test \
//     -c playwright.noop.config.js math-output-noop math-output
//   # 2. flip features.mathOutput, restart the server, run the same command again
//
// playwright.noop.config.js, NOT playwright.deploy.config.js. The deploy
// config's globalSetup (ephemeral-setup.js) refuses production outright --
// trinket.gopicup.org throws before any test starts -- and on a Firebase trial
// it mints two test identities. This file needs neither, so its config is the
// deploy config minus the global setup and teardown.
//
// Each run records what it saw in test/browser/.mathoutput-noop/<host>.json
// (gitignored). A run that finds no record of the other phase SKIPS with a
// printed reason -- it is half a measurement, and must not read as a pass.
// Recording the SAME half twice (the flag was not flipped) fails instead of
// skipping again. Delete the file to start over. The comparing run refuses a pair that differs
// in anything but mathOutput: another feature flag, the runtime a program ran
// on, its source, or the served code itself (every same-origin .js/.py the page
// fetched is hashed and compared wherever both halves fetched it, because
// /version says 'unknown' on a dev stack).
//
// RUN math-output.spec.js ALONGSIDE IT (the command above does). That spec is
// the positive control: flag-off and a feature that silently does nothing both
// satisfy every assertion here, and only a control that MUST typeset tells the
// two apart. The built-in `sympy-bare` entry below is a second, in-corpus
// control, and it is always run for the same reason. It downloads Pyodide once
// per test (its tests do not share a context), so with the flag on it costs
// several times what this file does.
//
// THE CORPUS, and what a pass does and does not prove.
//   TRINKET_CORPUS=abc123,def456   short codes ON THE TARGET DEPLOY. This is
//                                  what #247 asks for, and the only mode that
//                                  says anything about the trinkets people
//                                  actually have there.
//   (unset)                        a built-in set of program SHAPES typed into
//                                  a blank embed. A pass proves "a no-op for
//                                  programs like these" -- NOT "a no-op for the
//                                  trinkets on <deploy>". Do not report one as
//                                  the other; the difference is why #247 exists.
//
// WHY IT LIVES HERE, AND DOES NOT SEED ITS OWN DATA. Every spec in this
// directory that can run anonymously does, and this one never signs in and
// never writes: a short code is opened read-only at /embed/python3/<code>, and
// the built-in programs are typed into the blank embed, exactly as
// math-output.spec.js does. That keeps it safe to aim at production, which is
// the one deploy it exists for -- ephemeral-identity.js refuses to mint an
// identity on trinket.gopicup.org at all, so a spec that created its corpus
// could never run where the gate is. Seeding would buy nothing locally either:
// a seeded trinket is a program somebody wrote for the test, which is the
// built-in corpus with a database write in front of it.
//
// OPTIONAL KNOBS
//   MATH_NOOP_RUNTIME=main|worker  append ?runtime= to every embed. Unset runs
//                                  the deploy's default, which is what students
//                                  get unless a trinket pins its runtime.
//   MATH_NOOP_ANSWER=3             the reply to every input() (default "3").
//
// Two kinds of entry pass without testing the display hook, and the spec says
// so rather than counting them: a VPython program (runVpython() bypasses
// runProgram(), where the hook lives) and a program whose halves both end in a
// traceback. They are kept because a no-op must hold for them too.
//
// Each FAILED test restarts Playwright's worker, and with it the shared
// browser context below, so every failure costs one more Pyodide download.
//
// A program must FINISH to be compared: a `while True: rate(30)` animation has
// no final console to compare, and this file fails it by name rather than
// comparing a timing-dependent prefix.

const SHORT_CODES = (process.env.TRINKET_CORPUS || '').split(/[\s,]+/).filter(Boolean);
const RUNTIME = process.env.MATH_NOOP_RUNTIME || '';
const ANSWER = process.env.MATH_NOOP_ANSWER || '3';
const RECORD_DIR = path.join(__dirname, '..', '.mathoutput-noop');

// How long one run may take. The first Run downloads and boots Pyodide from
// jsDelivr (~10 MB) plus whatever wheels the program imports.
const RUN_TIMEOUT = 150_000;

// ONE browser context for the whole file, a fresh PAGE per program. A page is
// a fresh interpreter, which is all the isolation a run needs; a context is
// also a fresh HTTP cache, and Playwright's default of one context per test
// would download Pyodide and its wheels again for every program -- hundreds of
// MB across a corpus, on someone else's CDN, possibly over a metered link.
let sharedContext = null;
const assetHashes = new Map();   // full served URL -> content hash, for this run
async function freshPage(browser, baseURL) {
  if (!sharedContext) {
    sharedContext = await browser.newContext({ ...devices['Desktop Chrome'], baseURL });
  }
  return sharedContext.newPage();
}

// The built-in corpus. `cards` is what flag-ON must produce: 0 exactly, or
// 'some'. Every program terminates and is deterministic -- a program that
// prints random numbers differs from ITSELF, and would fail here for a reason
// that has nothing to do with the flag.
const BUILTIN = [
  {
    id: 'plain-script',
    cards: 0,
    code: [
      '"""A module docstring is a bare string expression, and must stay silent."""',
      'def area(r):',
      '    """So is a function docstring."""',
      '    3.14159 * r * r      # a bare expression inside a def',
      '    return 3.14159 * r * r',
      'total = 0',
      'for i in range(5):',
      '    total += i',
      '    i * 2                # a bare expression inside a loop',
      'print("total", total)',
      'print(f"area {area(2):.3f}")',
      'total;',
    ].join('\n'),
  },
  {
    id: 'bare-values',
    cards: 0,
    code: [
      '42',
      '"a string"',
      '[1, 2, 3]',
      '(1, "two", 3.0)',
      '{"a": 1, "b": [2, 3]}',
      'None',
      '3.5e-3',
      'print("bare values done")',
    ].join('\n'),
  },
  {
    id: 'student-object',
    // The classifier looks up _repr_latex_ on the TYPE, so a class whose
    // __getattr__ raises KeyError -- an everyday student bug -- must neither
    // typeset nor break a program that runs fine with the flag off.
    cards: 0,
    code: [
      'class Particle:',
      '    def __init__(self):',
      '        self.cache = {}',
      '    def __getattr__(self, name):',
      '        return self.cache[name]',
      '    def __repr__(self):',
      '        return "Particle()"',
      'p = Particle()',
      'p',
      'print("particle ok", repr(p))',
    ].join('\n'),
  },
  {
    id: 'numpy',
    cards: 0,
    code: [
      'import numpy as np',
      'x = np.linspace(0, 1, 5)',
      'x',
      'np.float64(2.5)',
      'print(x)',
      'print("mean", x.mean(), "sum", np.sum(x ** 2))',
      'm = np.array([[1, 2], [3, 4]])',
      'print(m @ m)',
    ].join('\n'),
  },
  {
    id: 'numpy-polynomial',
    // A feature, not an exception: the display hook typesets any object that
    // defines _repr_latex_, and numpy's Polynomial does, so a bare Polynomial
    // renders as typeset math with no SymPy anywhere. The text around the card
    // must still be identical.
    cards: 'some',
    why: 'numpy.polynomial.Polynomial defines _repr_latex_',
    code: [
      'from numpy.polynomial import Polynomial',
      'print("before")',
      'Polynomial([1, 2, 3])',
      'print("after")',
    ].join('\n'),
  },
  {
    id: 'matplotlib',
    cards: 0,
    code: [
      'import matplotlib.pyplot as plt',
      'plt.plot([0, 1, 2], [0, 1, 4])     # returns a list of Line2D',
      'plt.title("parabola")              # returns a Text',
      'plt.xlabel("t (s)")',
      'plt.show()',
      'print("plotted")',
    ].join('\n'),
  },
  {
    id: 'vpython',
    cards: 0,
    code: [
      'from vpython import *',
      'ball = sphere(pos=vector(0, 0, 0), radius=0.5)',
      'ball.velocity = vector(1, 0, 0)',
      'dt = 0.1',
      'for step in range(20):',
      '    rate(1000)',
      '    ball.pos = ball.pos + ball.velocity * dt',
      'ball.pos',
      'print("final x", round(ball.pos.x, 3))',
    ].join('\n'),
  },
  {
    id: 'input',
    cards: 0,
    code: [
      'name = input("name? ")',
      'n = int(input("how many? "))',
      'for i in range(n):',
      '    print("hello", name, i)',
      'n',
    ].join('\n'),
  },
  {
    id: 'traceback',
    // An error mid-program: the traceback is console text too, and the display
    // hook rewrites the module's statements, so line numbers are at stake.
    cards: 0,
    code: [
      'print("about to fail")',
      'values = [1, 2, 0]',
      'for v in values:',
      '    print(10 / v)',
    ].join('\n'),
  },
  {
    id: 'sympy-print-only',
    // Imports SymPy, so cards are ALLOWED -- but it only ever print()s, which
    // gives str(). A card here would mean print() had started typesetting.
    cards: 0,
    code: [
      'from sympy import symbols, integrate, sqrt, simplify',
      'x = symbols("x")',
      'print(integrate(sqrt(x), x))',
      'print(simplify((x**2 - 1) / (x - 1)))',
    ].join('\n'),
  },
  {
    id: 'prints-the-notice',
    // A program that prints the feature's own KaTeX notice text, then typesets.
    // Only the notice immediately before the card may be removed; the
    // student's identical line must survive, in both halves.
    cards: 'some',
    why: 'it typesets a bare SymPy expression',
    code: [
      'from sympy import symbols',
      'x = symbols("x")',
      'print("Loading math…")',
      'print("mid")',
      'print("Loading math…")      # immediately before the card, like the notice',
      'x**2 + 1',
      'print("end")',
    ].join('\n'),
  },
  {
    id: 'sympy-bare',
    // THE IN-CORPUS POSITIVE CONTROL. Flag-on must typeset this; if it does
    // not, every "identical" above is as consistent with a dead feature as with
    // a correct one.
    cards: 'some',
    control: true,
    code: [
      'from sympy import symbols, Integral, sqrt',
      'x = symbols("x")',
      'print("BEFORE")',
      'Integral(sqrt(1/x), x)',
      'print("AFTER")',
    ].join('\n'),
  },
];

const CORPUS = SHORT_CODES.length
  ? SHORT_CODES.map((c) => ({ id: c, shortCode: c }))
      .concat(BUILTIN.filter((e) => e.control))
  : BUILTIN;

// `import sympy`, `import numpy as np, sympy as sp`, `from sympy.abc import x`.
// A regex over source, so an import inside a string also counts; that errs
// towards ALLOWING cards, which only ever loosens the cards rule, never the
// identity rule.
const IMPORTS_SYMPY = /^\s*(?:import\s+[^\n#]*\bsympy\b|from\s+sympy(?:\.\w+)*\s+import\b)/m;

function embedUrl(entry) {
  const base = entry.shortCode ? '/embed/python3/' + encodeURIComponent(entry.shortCode)
                               : '/embed/python3';
  return RUNTIME ? base + '?runtime=' + encodeURIComponent(RUNTIME) : base;
}

// --- the record, one file per deploy ------------------------------------------

function recordPath(baseURL) {
  return path.join(RECORD_DIR, new URL(baseURL).host.replace(/[^\w.-]/g, '_') + '.json');
}
// Only a MISSING file is an empty record. A corrupt one throws: silently
// starting over would discard both halves and read as a procedure mistake.
function loadRecord(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return JSON.parse(text);
}
// Write-then-rename, so a run killed mid-write leaves the previous record whole.
function saveRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(record, null, 2));
  fs.renameSync(file + '.tmp', file);
}

// --- one run of one program -----------------------------------------------

async function runOnce(page, entry) {
  // finishRun() posts "complete" to window.parent; for a top-level page the
  // parent IS the window, so counting those messages is a completion signal
  // both runtimes share. readyForSnapshot is not: input() sets it too.
  await page.addInitScript(() => {
    // Chromium keeps 250 resource-timing entries and drops the rest silently;
    // a main-thread run's Pyodide wheels can pass that, and a dropped script
    // would vanish from the same-build comparison below without a word.
    performance.setResourceTimingBufferSize(10000);
    window.__noopComplete = 0;
    window.addEventListener('message', (e) => {
      if (e.data === 'complete') window.__noopComplete++;
    });
  });
  // The main thread answers input() through window.prompt.
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? ANSWER : undefined));

  const resp = await page.goto(embedUrl(entry));
  expect(resp && resp.status(), 'the embed must load: ' + embedUrl(entry)).toBeLessThan(400);
  await expect(page.locator('.ace_editor').first()).toBeVisible();

  // The page's own config object -- what mathOutputEnabled() reads -- rather
  // than a regex over the DOM, which would also match a trinket's source.
  // Every boolean is kept: the halves must differ in mathOutput and NOTHING
  // else, or a difference is not the flag's.
  const features = await page.evaluate(() => {
    const cfg = (window.trinket && window.trinket.config) || {};
    const out = {};
    for (const k of Object.keys(cfg)) if (typeof cfg[k] === 'boolean') out[k] = cfg[k];
    return out;
  });

  if (!entry.shortCode) {
    await page.evaluate((src) => {
      document.querySelector('.ace_editor').env.editor.setValue(src, 1);
    }, entry.code);
  }

  // Every file, not just the one on screen: a multi-file trinket can import
  // SymPy from a helper module.
  const files = await page.evaluate(() => window.jQuery('#editor').codeEditor('getAllFiles'));
  const source = Object.keys(files).sort().map((k) => '# ' + k + '\n' + files[k]).join('\n');
  expect(source.trim().length, 'the trinket must have code to run').toBeGreaterThan(0);

  // The embed's own run event, which is what Ctrl-Enter uses. Clicking .run-it
  // at narrow widths opens the split button's menu and runs nothing.
  await page.evaluate(() =>
    window.jQuery('#editor').trigger('trinket.code.run', { action: 'code.run' }));

  // Wait for completion, answering input() on the worker (an inline jqconsole
  // field rather than a dialog) as it comes up. The textarea is jqconsole's,
  // scoped to the console: an embed with inline comments has others.
  const input = page.locator('#console-output .jqconsole-input');
  const box = page.locator('#console-output textarea').first();
  const deadline = Date.now() + RUN_TIMEOUT;
  let finished = false;
  while (Date.now() < deadline) {
    if (await page.evaluate(() => window.__noopComplete > 0)) { finished = true; break; }
    if (await input.isVisible().catch(() => false)) {
      await box.pressSequentially(ANSWER);
      await box.press('Enter');
      // Let the field close before looking again, or a second answer lands in
      // the NEXT prompt and the console depends on timing.
      await expect(input).toBeHidden({ timeout: 10_000 }).catch(() => {});
    }
    await page.waitForTimeout(250);
  }

  const out = await page.evaluate((notice) => {
    const el = document.querySelector('#console-output');
    if (!el) return { text: '', bare: '', cards: 0 };
    // Each card becomes a sentinel first, so the feature's own KaTeX notice can
    // be recognized by POSITION -- queueMathCard() queues it immediately before
    // the first card that carries LaTeX -- rather than by its text, which a
    // student's program is free to print too.
    const MARK = '\u0000card\u0000';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.math-card-wrap').forEach((n) => n.replaceWith(MARK));
    clone.querySelectorAll('.math-card').forEach((n) => n.replaceWith(MARK));
    const marked = clone.textContent || '';
    // textContent, not innerText: below ~1100 px the output pane is tabbed and
    // innerText of the hidden console is ''.
    return {
      text:  el.textContent || '',
      bare:  marked.replace(notice + MARK, MARK).split(MARK).join(''),
      cards: el.querySelectorAll('.math-card').length,
    };
  }, KATEX_NOTICE);

  // Which runtime this program ACTUALLY ran on. The deploy default is not it:
  // VPython goes to the main thread unless workerVPython is on, and
  // MATH_NOOP_RUNTIME or a trinket's own setting can pin either.
  const runtime = await page.evaluate(() => window.__trinketRuntime || 'unknown');

  // The build. /version is 'unknown' on a dev stack, and 'checkout' reports
  // HEAD while ignoring uncommitted edits, so hash what was actually SERVED:
  // every same-origin .js/.py the DOCUMENT fetched (a worker's own fetches are
  // in the worker's timeline, not here), keyed by path with the per-boot cache
  // prefix removed, and compared wherever both halves fetched it. Two halves on
  // different code compare two programs, not one program with the flag flipped.
  //
  // Hashed once per URL per run: page.request has no HTTP cache, and without
  // this every program would re-fetch ~36 scripts (~1 MB) from the target.
  const version = await page.request.get('/version').then((r) => r.json()).catch(() => ({}));
  const assetUrls = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((e) => e.name)
    .filter((u) => { try { const x = new URL(u); return x.origin === location.origin
      && /\.(js|py)$/.test(x.pathname); } catch (e) { return false; } }));
  const assets = {};
  for (const u of assetUrls) {
    const key = new URL(u).pathname.replace(/^\/cache-prefix-[^/]*/, '');
    if (!assetHashes.has(u)) {
      const res = await page.request.get(u).catch((e) => ({ ok: () => false, status: () => e.message }));
      // A failed hash must not quietly shrink what the two halves compare.
      expect(res.ok(), 'could not re-fetch ' + key + ' to hash it (' + res.status() + ')').toBe(true);
      assetHashes.set(u, crypto.createHash('sha256').update(await res.body()).digest('hex').slice(0, 16));
    }
    assets[key] = assetHashes.get(u);
  }

  return {
    finished,
    features,
    math: features.mathOutput === true,
    runtime,
    commit: version.commit || 'unknown',
    assets,
    sha: crypto.createHash('sha256').update(source).digest('hex').slice(0, 16),
    sympy: IMPORTS_SYMPY.test(source),
    ...out,
  };
}

// The one line the feature itself adds when -- and only when -- it typesets.
// runOnce() removes it from `bare` where it sits immediately before a card.
const KATEX_NOTICE = 'Loading math…\n';

// First index where two strings differ, with a little of each around it --
// "not identical" on two 4 KB consoles is useless without this.
function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 60);
  return 'first difference at char ' + i + ':\n'
    + '  OFF: ' + JSON.stringify(a.slice(from, i + 60)) + '\n'
    + '  ON : ' + JSON.stringify(b.slice(from, i + 60));
}

// Keys whose values differ between two flat objects. `union` also counts a key
// present on only one side: right for feature flags, where a flag appearing or
// vanishing is a change; wrong for assets, where flag-on legitimately loads
// files flag-off never requests, so those compare shared keys only.
function changedKeys(a, b, { ignore, union } = {}) {
  const keys = union ? [...new Set([...Object.keys(a), ...Object.keys(b)])]
                     : Object.keys(a).filter((k) => k in b);
  return keys.filter((k) => k !== ignore && a[k] !== b[k]);
}

test.describe('mathOutput is a no-op for programs that do not ask for it (#247)', () => {
  // Above the config's 90 s: one run may take RUN_TIMEOUT plus page load,
  // asset hashing and up to 10 s per input() answer, and a mismatch re-runs
  // once. The cap must EXCEED both runs, or it fires before the wait reports
  // and "Test timeout exceeded" replaces the message that says what differed.
  //
  // retries: 0 overrides the config's 1. A retry here can only HIDE a failure:
  // an intermittent flag effect that passes on the retry is reported as
  // "flaky" and exits 0, and the retry overwrites the failing sample. The
  // re-run below already asks "is this noise?", and says so in its message.
  test.describe.configure({ timeout: 2 * (RUN_TIMEOUT + 45_000) + 30_000, retries: 0 });

  test.beforeAll(() => {
    console.log('  [math-noop] corpus: ' + (SHORT_CODES.length
      ? SHORT_CODES.length + ' short code(s) from TRINKET_CORPUS, plus the sympy-bare control'
      : BUILTIN.length + ' BUILT-IN program shapes -- this says nothing about the '
        + 'trinkets stored on the deploy; set TRINKET_CORPUS for that'));
  });

  test.afterAll(async () => {
    if (sharedContext) await sharedContext.close();
    sharedContext = null;
  });

  for (const entry of CORPUS) {
    test(entry.id, async ({ browser, baseURL }) => {
      const page = await freshPage(browser, baseURL);
      const run = await runOnce(page, entry);
      await page.close();
      const phase = run.math ? 'on' : 'off';
      const other = phase === 'on' ? 'off' : 'on';
      const where = embedUrl(entry);

      expect(run.finished, entry.id + ' did not finish within ' + RUN_TIMEOUT / 1000 + ' s. '
        + 'A program that never ends has no final console to compare; drop it from the '
        + 'corpus. Console so far: ' + JSON.stringify(run.text.slice(-300))).toBe(true);

      // Record this phase before asserting anything else, so a failure below
      // still leaves a usable half for the next run.
      const file = recordPath(baseURL);
      const record = loadRecord(file);
      record[phase] = record[phase] || {};
      const key = entry.id + (RUNTIME ? '@' + RUNTIME : '');
      const mine = {
        at: new Date().toISOString(), url: where, runtime: run.runtime, features: run.features,
        commit: run.commit, assets: run.assets, sha: run.sha, sympy: run.sympy,
        cards: run.cards, text: run.text, bare: run.bare,
      };
      const already = record[phase][key];
      record[phase][key] = mine;
      saveRecord(file, record);

      expect(phase !== 'off' || run.cards === 0,
        'flag OFF must never produce a math card, and ' + entry.id + ' produced ' + run.cards)
        .toBe(true);

      const prev = record[other] && record[other][key];
      // The same half, twice: the flag was never flipped (or the restart did not
      // take). Skipping again would exit 0 having compared nothing, which reads
      // like the gate passed. Fail and say what to do.
      expect(Boolean(prev || !already), entry.id + ': the mathOutput ' + phase.toUpperCase()
        + ' half was ALREADY recorded (at ' + (already && already.at) + ') and the '
        + other.toUpperCase() + ' half is still missing. Flip features.mathOutput, restart the '
        + 'server, and run again -- or delete ' + file + ' to start over.').toBe(true);
      if (!prev) {
        console.log('  [math-noop] ' + entry.id + ': recorded mathOutput ' + phase.toUpperCase()
          + '; nothing to compare yet -- flip the flag, restart, and run again');
        test.skip(true, 'recorded the ' + phase + ' half only; the ' + other + ' half is missing');
      }

      // Refuse comparisons that would not mean anything.
      expect(Boolean(prev.features && prev.assets && prev.runtime), 'the recorded ' + other
        + ' half predates this revision of the spec; delete ' + file + ' and re-record both')
        .toBe(true);
      expect(prev.sha, entry.id + ' changed between the two runs (source sha '
        + prev.sha + ' -> ' + run.sha + '); re-record both halves').toBe(run.sha);
      expect(changedKeys(prev.features || {}, run.features, { ignore: 'mathOutput', union: true }),
        'the two halves differ in more than mathOutput, so a difference would not be the '
        + "flag's; restore the other flags and re-record").toEqual([]);
      expect(prev.runtime, entry.id + ' ran on a different runtime in each half').toBe(run.runtime);
      expect(changedKeys(prev.assets || {}, run.assets),
        'the served code CHANGED between the two runs (these files hash differently); '
        + 're-record both halves against one build').toEqual([]);
      // The anchor, required in BOTH halves: shared-key comparison alone passes
      // vacuously when one half hashed nothing.
      const anchor = Object.keys(run.assets).find((k) => /\/js\/embed\/pyodide\.js$/.test(k));
      expect(Boolean(anchor && prev.assets[anchor]),
        'pyodide.js was not hashed in both halves, so there is no evidence they ran one build')
        .toBe(true);
      if (prev.commit !== 'unknown' && run.commit !== 'unknown') {
        expect(prev.commit, 'the deploy was REBUILT between the two runs; re-record both halves')
          .toBe(run.commit);
      } else if (prev.commit !== run.commit) {
        console.log('  [math-noop] ' + entry.id + ': one half reports commit ' + prev.commit
          + ' and the other ' + run.commit + '; relying on the asset hashes');
      }

      const off = phase === 'off' ? mine : prev;
      const on  = phase === 'on'  ? mine : prev;

      // Flag-OFF is re-checked here, not only in its own run: the comparing run
      // is the one a person reads, and a failed OFF half is still on disk.
      // No separate check for a flag-OFF KaTeX notice: a program may print that
      // text itself, and a real one would already differ in the identity rule.
      expect(off.cards, entry.id + ': the recorded flag-OFF half has math cards').toBe(0);

      // The cards rule.
      const allowed = entry.cards !== undefined ? entry.cards : (run.sympy ? 'some' : 0);
      if (allowed === 0) {
        expect(on.cards, entry.id + ' produced ' + on.cards + ' math card(s) with the flag on'
          + (run.sympy ? ''
            : ' without importing SymPy. That is by design -- something in it defines '
              + '_repr_latex_ (numpy polynomials do) -- but it is a VISIBLE change to this '
              + 'trinket when the flag goes on, so a person has to decide whether it is wanted'))
          .toBe(0);
      } else if (entry.cards === 'some') {
        expect(on.cards, entry.id + ' must typeset with the flag on'
          + (entry.control ? ' -- this is the positive control, and without it every '
            + '"identical" in this run is as consistent with a dead feature as a working one'
            : ' (' + entry.why + ')')).toBeGreaterThan(0);
      } else if (on.cards > 0) {
        console.log('  [math-noop] ' + entry.id + ': imports SymPy and typeset ' + on.cards
          + ' card(s) with the flag on -- allowed; the text around them is still compared');
      }

      // Say when a pass is weaker than it looks. Both halves ending in a
      // traceback compare an ERROR, and a VPython run never reaches the display
      // hook at all (runVpython bypasses runProgram), so neither is evidence
      // about the wrap -- report them, do not count them.
      if (/Traceback \(most recent call last\)/.test(off.text)
          && /Traceback \(most recent call last\)/.test(on.text)) {
        console.log('  [math-noop] ' + entry.id + ': both halves end in a traceback -- identical, '
          + 'but it compares an error, not the program');
      }

      // The identity rule. With no cards, bare === text and nothing is
      // removed, so this IS the byte-for-byte console comparison #247 asks for.
      const onBare = on.bare;
      if (off.bare === onBare) return;

      // Different. Is that the flag, or a program that differs from itself?
      // Re-run THIS phase once, on a fresh page (a fresh interpreter; the HTTP
      // cache is shared), and see whether it agrees with its own first run.
      // Only this phase can be re-run, so agreement proves THIS half is stable,
      // not that the other one was.
      const retry = await freshPage(browser, baseURL);
      const again = await runOnce(retry, entry);
      await retry.close();
      let verdict;
      if (!again.finished) {
        verdict = 'UNCLASSIFIED: ' + entry.id + ' differs, and the re-run to classify it did '
          + 'not finish. ';
      } else if (again.bare === mine.bare) {
        verdict = 'LIKELY FLAG EFFECT: ' + entry.id + ' prints different console text with '
          + 'mathOutput ' + phase + ', and a second ' + phase + ' run reproduced this half '
          + 'exactly. The ' + other + ' half was not re-run; re-record it to rule out noise '
          + 'there before calling this the flag. ';
      } else {
        verdict = 'NONDETERMINISTIC: ' + entry.id + ' differs from ITSELF between two ' + phase
          + ' runs, so it cannot be evidence either way; drop it from the corpus. ';
      }
      expect(off.bare, verdict + firstDifference(off.bare, onBare)).toBe(onBare);
    });
  }
});
