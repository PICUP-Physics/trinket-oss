'use strict';
// #333: the "Loading Python (Pyodide)…" status line belongs to a run that is going
// to WAIT ON A BOOT, and to nothing else.
//
// Two halves, each correct on its own and each already tested on its own: the
// worker client fires onReady once per worker (worker-client.test.js), and the page
// closes the line when told to (the #27 fix, console-status.spec.js). Nothing
// asserted their RELATIONSHIP across more than one run -- and more than one run is
// the case a student lives in: run, edit, run again. On the second run the worker
// is already warm, onReady never fires, and a line opened unconditionally is left
// open with the program's first output line written onto the end of it.
//
// So this drives the REAL worker client and the REAL openRuntimeLine /
// closeRuntimeLine (lifted out of pyodide.js and executed, not read) through the
// sequence the page performs for each press of Run, and then pins the two call
// sites that sequence stands in for. The call sites are read as source, because
// runInWorker and ensureWorkerClient are far too entangled with the page to lift;
// the second describe says what that reading cannot see.
const fs   = require('node:fs');
const path = require('node:path');
const { createWorkerClient } = require('../../public/js/embed/worker-client.js');

const SRC = path.join(__dirname, '..', '..', 'public/js/embed/pyodide.js');
const source = () => fs.readFileSync(SRC, 'utf8');

/** Lift one small top-level `function name(...) { ... }` out of the embed source. */
function extract(name) {
  const src = source();
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in pyodide.js');
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('unbalanced braces while extracting ' + name);
}

/**
 * A whole top-level function, up to the next one. For the two big ones, where
 * counting braces would trip over braces inside strings and regexes.
 */
function extractWhole(name) {
  const src = source();
  const start = src.indexOf('\nfunction ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in pyodide.js');
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next < 0 ? src.length : next);
}

/** Whole-line comments only, so a comment that NAMES the call cannot satisfy a match. */
const code = (s) => s.replace(/^\s*\/\/.*$/gm, '');

/** The real status-line helpers, with writeOut replaced by a recorder. */
function statusLine() {
  const out = [];
  const api = new Function('writeOut', [
    'var runtimeLineOpen = false;',
    extract('openRuntimeLine'),
    extract('closeRuntimeLine'),
    'return { open: openRuntimeLine, close: closeRuntimeLine, isOpen: function () { return runtimeLineOpen; } };'
  ].join('\n'))((t) => out.push(t));
  return Object.assign(api, { out, text: () => out.join('') });
}

/** The page: a real client over a fake Worker, wired the way ensureWorkerClient wires it. */
function newPage() {
  const made = [];
  function FakeWorker() {
    this.posted = [];
    this.booted = false;
    this.postMessage = (m) => { this.posted.push(m); };
    this.terminate = () => {};
    made.push(this);
  }
  const line = statusLine();
  const client = createWorkerClient({
    workerUrl: '/js/embed/pyodide-worker.js',
    pyodideUrl: 'https://cdn/pyodide.mjs',
    WorkerCtor: FakeWorker,
    onReady: () => line.close(),          // pinned against the real source below
    onStdout: (t) => line.out.push(t)
  });
  return { client, made, line };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * One press of Run, as runInWorker performs it, returning what the console shows.
 * `guarded` selects the call site: false is the sequence before #333 (open on every
 * run), true is the one after (open only when this run will wait on a boot).
 */
async function pressRun(p, stdout, guarded) {
  p.line.out.length = 0;                                   // the console is cleared per run
  if (!guarded || !p.client.isReady()) p.line.open('Loading Python (Pyodide)… ');
  const done = p.client.run('print()');                    // creates a worker if there is none
  const w = p.made[p.made.length - 1];
  if (!w.booted) {                                         // a cold worker finishes booting
    w.booted = true;
    w.onmessage({ data: { type: 'ready', v: 1 } });
  }
  await tick();
  const id = w.posted.filter((m) => m.type === 'run').pop().id;
  w.onmessage({ data: { type: 'stdout', text: stdout } });
  w.onmessage({ data: { type: 'done', id } });
  await done;
  return p.line.text();
}

describe('the "Loading Python (Pyodide)…" line across runs (#333)', () => {
  it('a cold first run opens it, and the boot closes it', async () => {
    const p = newPage();
    expect(await pressRun(p, 'ONE\n', true)).toBe('Loading Python (Pyodide)… ready\nONE\n');
  });

  it('a second run on the warm worker prints no status line at all', async () => {
    const p = newPage();
    await pressRun(p, 'ONE\n', true);
    expect(await pressRun(p, 'TWO\n', true)).toBe('TWO\n');
    expect(p.line.isOpen(), 'nothing may be left open').toBe(false);
  });

  it('REGRESSION: opened on every run, the second run dangles and swallows its first line', async () => {
    // What production showed at 486a659, kept as the statement of what must not
    // recur. Also the proof this model can see the bug: the guarded sequence above
    // is only evidence if the unguarded one fails here.
    const p = newPage();
    await pressRun(p, 'ONE\n', false);
    expect(await pressRun(p, 'TWO\n', false)).toBe('Loading Python (Pyodide)… TWO\n');
    expect(p.line.isOpen()).toBe(true);
  });

  it('after stop() the next run is a cold boot, and says so', async () => {
    // ready is only reset when a REPLACEMENT worker is created, so a guard that
    // read it bare would call this boot warm and announce it with nothing.
    const p = newPage();
    await pressRun(p, 'ONE\n', true);
    p.client.stop();
    expect(await pressRun(p, 'THREE\n', true)).toBe('Loading Python (Pyodide)… ready\nTHREE\n');
    expect(p.made.length, 'a second worker was booted').toBe(2);
  });

  it('after discardWorker() (the worker-VPython path) likewise', async () => {
    const p = newPage();
    await pressRun(p, 'ONE\n', true);
    p.client.discardWorker();
    expect(await pressRun(p, 'FOUR\n', true)).toBe('Loading Python (Pyodide)… ready\nFOUR\n');
    expect(p.made.length).toBe(2);
  });
});

describe('createWorkerClient().isReady()', () => {
  it('is false while the first boot is pending, and true once the worker reports ready', () => {
    const p = newPage();
    expect(p.client.isReady()).toBe(false);
    p.made[0].onmessage({ data: { type: 'ready', v: 1 } });
    expect(p.client.isReady()).toBe(true);
  });

  it('is false the moment the worker is destroyed, not only once a replacement exists', () => {
    const p = newPage();
    p.made[0].onmessage({ data: { type: 'ready', v: 1 } });
    p.client.stop();
    expect(p.made.length, 'no replacement yet -- this is the window the guard is for').toBe(1);
    expect(p.client.isReady()).toBe(false);
  });

  it('is false for a replacement worker until ITS boot completes', async () => {
    const p = newPage();
    p.made[0].onmessage({ data: { type: 'ready', v: 1 } });
    p.client.stop();
    const done = p.client.run('print()');                  // creates the replacement
    expect(p.made.length).toBe(2);
    expect(p.client.isReady()).toBe(false);
    p.made[1].onmessage({ data: { type: 'ready', v: 1 } });
    expect(p.client.isReady()).toBe(true);
    p.client.stop();
    await done;
  });
});

describe('the two call sites the sequence stands in for', () => {
  // WHAT THIS CANNOT SEE: that the guard is reached on every path into
  // runInWorker, or that its answer is right at the moment it is asked. The first
  // is a property of the callers, the second of the sequence modelled above; a
  // browser spec (console-status.spec.js, second run) is what covers the page.
  it('runInWorker opens the line only behind the isReady() guard', () => {
    const body = code(extractWhole('runInWorker'));
    const opens = body.match(/openRuntimeLine\(/g) || [];
    const guarded = body.match(/if\s*\(\s*!workerClient\.isReady\(\)\s*\)\s*\{\s*openRuntimeLine\(/g) || [];
    expect(opens.length, 'runInWorker should still announce a cold boot').toBeGreaterThan(0);
    expect(guarded.length, 'every openRuntimeLine in runInWorker must sit behind the guard').toBe(opens.length);
  });

  it('the page still wires onReady to closeRuntimeLine, which is what the model assumes', () => {
    const body = code(extractWhole('ensureWorkerClient'));
    expect(body).toMatch(/onReady\s*:\s*function\s*\(\s*\)\s*\{\s*closeRuntimeLine\(\s*\)\s*;?\s*\}/);
  });
});
