'use strict';
// The worker's Save path (#252) is Python embedded in a JS string array, so
// nothing in this suite type-checks it and nothing runs it. What can be pinned
// here is the structural property the fix actually rests on, plus the shape of
// the page-side half.
//
// The ordering is the load-bearing part. The {type:'save'} swallow has to come
// BEFORE `_m.handle_json(_evt)`. If it ever moves after, handle_json dispatches
// to Pyodide's patched Python handle_save first, which renders the figure and
// delivers it with document.createElement('a') -- against the worker's inert
// stub. The swallow would then still run and the file would still arrive, so
// the regression would not look like a failure: Save would appear to work while
// rendering the figure twice, once into nothing. That is precisely the kind of
// thing a human does not notice and a test does.
const fs = require('node:fs');
const path = require('node:path');

const ROOT   = path.join(__dirname, '..', '..');
const WORKER = path.join(ROOT, 'public/js/embed/pyodide-worker.js');
const PAGE   = path.join(ROOT, 'public/js/embed/pyodide.js');

/**
 * The worker source as text. Deliberately NOT evaluated: every assertion below
 * is about the order and presence of lines, which the raw source answers just
 * as well, and evaluating the MPL_SETUP array literal would break confusingly
 * the day it stops being one.
 */
function workerSource() {
  return fs.readFileSync(WORKER, 'utf8');
}

describe('worker figure save — the worker source', () => {
  const py = workerSource();

  it('swallows the save message before handle_json can dispatch it', () => {
    const swallow = py.indexOf("if _evt.get('type') == 'save':");
    const dispatch = py.indexOf('_m.handle_json(_evt)');

    expect(swallow).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(swallow).toBeLessThan(dispatch);
  });

  it('returns from the save branch rather than falling through to dispatch', () => {
    const branch = py.slice(py.indexOf("if _evt.get('type') == 'save':"),
                            py.indexOf('_m.handle_json(_evt)'));
    expect(branch).toContain('return');
  });

  it('renders with savefig, not from a canvas', () => {
    expect(py).toContain('savefig');
    expect(py).not.toContain('toDataURL');
  });

  it('reports a failed render instead of swallowing it', () => {
    const branch = py.slice(py.indexOf("if _evt.get('type') == 'save':"),
                            py.indexOf('_m.handle_json(_evt)'));
    expect(branch).toContain('save-error');
  });

  // The same silence that made #252 hard to find: matplotlib alerts on an
  // unsupported format, and a no-op stub makes that indistinguishable from a
  // successful save.
  it('routes alert() to the console rather than discarding it', () => {
    const src = fs.readFileSync(WORKER, 'utf8');
    const stub = src.slice(src.indexOf('function installDomStubs()'),
                           src.indexOf('var MPL_SETUP'));
    expect(stub).toContain('self.alert');
    expect(stub).toMatch(/self\.alert = function[^}]*stderr/s);
  });
});

// This is the half that running it actually caught. Everything above was in
// place and the button still did nothing, because worker-client scopes every
// `type: 'figure'` message to the current run and drops the rest -- and a save
// reply, by its nature, arrives after the run has settled and `current` is
// null. The scoping is right for frame data and wrong for a file.
describe('worker figure frames are scoped to the WORKER, not the run', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/embed/worker-client.js'), 'utf8');
  const branch = src.slice(src.indexOf("if (msg.type === 'figure')"),
                           src.indexOf("if (msg.type === 'scene-ops')"));

  // This block used to scope frames to `current`, the live RUN. settle() nulls
  // `current` when a program ends, so every frame after that was dropped --
  // and a matplotlib figure outlives its run. Pan, zoom, home and resize on a
  // finished plot were all handled by Python and then discarded here.
  it('does not scope frames to the current run', () => {
    expect(branch).not.toMatch(/!current \|\| msg\.id !== current\.id/);
  });

  it('drops frames from a worker that has been replaced', () => {
    expect(branch).toContain('e.target !== worker');
  });

  // Save needed its own exemption under run scoping (#252). Worker scoping
  // subsumes it: a save reply is late for the same reason an interactive frame
  // is, so the special case should be GONE rather than left as dead code.
  it('needs no special case for save replies any more', () => {
    expect(branch).not.toContain("msg.kind === 'save'");
    expect(branch).not.toContain('isSave');
  });
});

describe('worker figure save — the page half', () => {
  const src = fs.readFileSync(PAGE, 'utf8');

  it('handles the save and save-error kinds the worker sends', () => {
    expect(src).toContain("msg.kind === 'save'");
    expect(src).toContain("msg.kind === 'save-error'");
  });

  // The worker's reply is not a trusted source for this: MPL_SETUP and the
  // student's program share pyodide.globals, so student Python can call
  // _trinket_mpl_send and pick the string that lands in `download`.
  it('constrains the extension it puts in the download filename', () => {
    expect(src).toMatch(/\[a-z0-9\]\{1,5\}/);
    expect(src).not.toContain("'plot.' + (saved.format");
  });

  // Pyodide's patched mpl.js does not call ondownload, but the patch is theirs
  // and not ours. If a future Pyodide restores the call, this must not quietly
  // become a canvas grab -- toDataURL ignores savefig.dpi, .transparent and
  // .bbox_inches, so a student who set dpi=300 would get screen pixels.
  it('does not grab the canvas anywhere', () => {
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    expect(code).not.toContain('toDataURL');
  });
});

// The plot-style panel's Save PNG reaches the SAME savefig round trip, because
// on the worker runtime it has no backend of its own and asks the host instead
// (plotpolish #30, answered from v0.3.5). The one thing that must not happen
// here is the substitution the describe above exists to prevent: if this
// reached for the canvas or the <img> first, the Save tab's savefig.dpi,
// transparent and bbox would stop applying on the runtime the panel is FOR.
describe('worker figure save — the plot-style panel reaches the same route', () => {
  const src  = fs.readFileSync(PAGE, 'utf8');
  const body = src.slice(src.indexOf('function requestWorkerFigureSave'),
                         src.indexOf('function runInWorker'));

  it('defines the entry point the adapter is handed', () => {
    expect(body.length).toBeGreaterThan(0);
    expect(src).toContain('saveFigure :');
    expect(src).toContain('requestWorkerFigureSave(format)');
  });

  it('sends the same {type:\'save\'} message the mpl toolbar sends', () => {
    expect(body).toContain("type: 'save'");
    expect(body).toContain('figure_id');
  });

  // There is deliberately NO <img> fallback. An earlier version had one, on
  // the theory that mpl.js failing to load leaves a static PNG to download --
  // but `self.__trinket_worker_figure`, the only thing that posts `kind:'png'`,
  // has no caller anywhere in the repo, so the <img> is never painted. Dead
  // code defended by a paragraph that was not true. If someone revives the
  // sender, revive the fallback deliberately rather than by accident.
  it('builds no download of its own -- the socket route is the only route', () => {
    const code = body.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
    // The mechanics of a download, not the WORD: the watchdog's message to the
    // student legitimately contains "download", and matching on that made this
    // fail on a string change. An anchor needs these.
    expect(code).not.toContain('createElement');
    expect(code).not.toMatch(/\.download\s*=/);
    expect(code).not.toContain('img.worker-figure');
  });

  it('has no orphan sender revived behind its back', () => {
    // If this ever fails, __trinket_worker_figure gained a caller and the
    // fallback question is open again -- which is exactly when someone should
    // be made to think about it.
    const worker = fs.readFileSync(WORKER, 'utf8');
    // AT MOST the definition. Not `=== 1`: that also failed when the orphan
    // was DELETED, which is the cleanup this branch explicitly defers and
    // endorses -- a test that fires on the fix it recommends is a trap, and
    // `expected 0 to be 1` points at nothing useful. It also fired on a mere
    // comment mentioning the name, so the follow-up could not leave a note.
    const hits = worker.split('__trinket_worker_figure').length - 1;
    expect(hits).toBeLessThan(2);
  });

  // The format the panel asks for reaches savefig, so a guard that inverts on
  // its own default is worse than none: it would send the nine-character
  // string "undefined" to matplotlib.
  it('defaults a missing format to png rather than to the string "undefined"', () => {
    // The expression as written, evaluated -- source text cannot tell a guard
    // from a guard-shaped string, and that is exactly how the bug shipped.
    const line = body.slice(body.indexOf('var fmt ='), body.indexOf('var ids'));
    const fmtOf = new Function('format', line + '; return fmt;');
    expect(fmtOf(undefined)).toBe('png');
    expect(fmtOf(null)).toBe('png');
    expect(fmtOf('')).toBe('png');
    expect(fmtOf('PDF')).toBe('pdf');
    expect(fmtOf('svg;')).toBe('png');
    expect(fmtOf('toolongformat')).toBe('png');
  });

  // The socket's ANSWER, not "send() did not throw". With no worker the frame
  // is dropped in silence and nothing throws, so a bare `return true` told the
  // panel to say "Saved" over a message that went nowhere. Source-text, which
  // is a weak instrument -- worker-client.test.js drives the real module for
  // the half that can actually be executed.
  it('returns what the socket said, rather than true for "did not throw"', () => {
    expect(body).toMatch(/if \(entry\.socket\.send\([^)]*\) !== true\) return false;/);
    expect(body).not.toMatch(/entry\.socket\.send\([^)]*\);\s*\n\s*return true;/);
  });

  // The panel calls preventDefault() only on a true return, so a false here is
  // what makes it tell the student the truth rather than claim a save.
  it('falls through to false when there is nothing to save', () => {
    // The LAST return in the function, not merely a `return false` somewhere:
    // the early ones are the socket's catch. If the fall-through ever becomes
    // `return true`, the panel claims a save on a run that produced no figure.
    const lastReturn = body.slice(body.lastIndexOf('return '));
    expect(lastReturn.startsWith('return false;')).toBe(true);
  });
});

/**
 * The save chain has THREE links and a source reading only ever pins two.
 *
 * A round-2 review mutated the middle one -- makeMplSocket's `send` ignoring
 * the client's answer and returning true -- and the whole 558-test suite
 * stayed green while the original bug was fully restored: after a Stop the
 * panel says "Saved" and no file appears. So these EXECUTE the links instead,
 * using the same extract-and-run idiom as mpl-resize-debounce.test.js.
 */
describe('worker figure save — the chain, executed', () => {
  const SRC = path.join(ROOT, 'public/js/embed/pyodide.js');
  function extract(name) {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error('unbalanced braces extracting ' + name);
  }

  // --- LINK 2: the socket passes the client's answer through -------------
  function socketWith(client) {
    const make = new Function('window', 'workerClient',
      'return (' + extract('makeMplSocket') + ')')({}, client);
    return make('fig1');
  }

  it('the socket returns false when the client says it did not post', () => {
    expect(socketWith({ sendMplEvent: () => false }).send({ type: 'save' })).toBe(false);
  });
  it('the socket returns true when the client posted', () => {
    expect(socketWith({ sendMplEvent: () => true }).send({ type: 'save' })).toBe(true);
  });
  it('the socket returns false when there is no client at all', () => {
    expect(socketWith(null).send({ type: 'save' })).toBe(false);
  });

  // --- LINK 3 + the in-flight state, which lives in this file now --------
  const TIMEOUT_MS = Number(/MPL_SAVE_TIMEOUT_MS\s*=\s*(\d+)/.exec(fs.readFileSync(SRC, 'utf8'))[1]);

  function sandbox(sendResult) {
    const sent = [];
    const out = [];
    const figures = {
      fig1: { socket: { send: () => true } },
      fig2: { socket: { send: (m) => { sent.push(m); return sendResult; } } },
    };
    const api = new Function(
      'mplFigures', 'writeOut', 'MPL_SAVE_TIMEOUT_MS', 'setTimeout', 'clearTimeout',
      'var mplSaveInFlight = false, mplSaveWatchdog = null, mplSaveOverdue = false,' +
      '    mplSaveRequestId = null, mplSaveSeq = 0;' +
      extract('clearMplSaveWait') +
      extract('requestWorkerFigureSave') +
      'return { save: requestWorkerFigureSave, clear: clearMplSaveWait,' +
      '         inFlight: function () { return mplSaveInFlight; } };'
    )(figures, (t) => out.push(t), 10000, setTimeout, clearTimeout);
    return { api, sent, out };
  }

  it('reports the socket\'s refusal rather than claiming a save', () => {
    const { api, out } = sandbox(false);
    expect(api.save('png')).toBe(false);
    expect(api.inFlight()).toBe(false);   // nothing left armed
    expect(out).toEqual([]);
  });

  it('takes the save, and answers a second request while one is out', () => {
    const { api, sent } = sandbox(true);
    try {
    expect(api.save('png')).toBe(true);
    expect(api.inFlight()).toBe(true);
    // True, not suppressed-and-lied-about: the student's request is satisfied
    // by the save already running, and the worker is asked only once.
    expect(api.save('png')).toBe(true);
    expect(sent.length).toBe(1);
    } finally { api.clear(); }   // or the 10s watchdog outlives the test
  });

  it('is askable again once the reply has cleared the wait', () => {
    const { api, sent } = sandbox(true);
    api.save('png');
    api.clear();                           // what the 'save' / 'save-error' branches do
    expect(api.inFlight()).toBe(false);
    api.save('png');
    expect(sent.length).toBe(2);
    api.clear();
  });

  // The default figure choice: the LAST key, not the first. Round 1 flagged
  // that `ids[0]` passed the whole suite; this is the assertion that closes it.
  // Source-text, deliberately: stopCode() reaches half the module's state and
  // cannot be lifted out the way the two above can. Presence-and-ordering is
  // what text answers well, and that is exactly the question here -- the save
  // wait must be cleared BEFORE the worker is terminated, or a Save click in
  // the seconds after a Stop is swallowed as a duplicate of a save that can
  // never be answered, and the panel says "Saved".
  it('a Stop clears the save wait, before it terminates the worker', () => {
    const page = fs.readFileSync(PAGE, 'utf8');
    const from = page.indexOf('function stopCode(');
    // BOUNDED to stopCode, and COMMENT-STRIPPED. Unbounded it sliced to end of
    // file and asserted over the wrong region; uncommented, the ordering could
    // be satisfied by a *comment* mentioning the call while the real one moved
    // below stop() -- the same trap the orphan-sender test fell into.
    const stop = page.slice(from, page.indexOf('\n}', from));
    const code = stop.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const clearAt = code.indexOf('clearMplSaveWait()');
    const stopAt  = code.indexOf('workerClient.stop()');
    expect(clearAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(-1);
    expect(clearAt).toBeLessThan(stopAt);
    // What this CANNOT see: a dead branch. `if (false) { clearMplSaveWait(); }`
    // passes. stopCode() reaches half the module's state and cannot be lifted
    // and run, so that gap is stated rather than papered over.
  });

  // The watchdog is the backstop for a reply that never comes. Three things
  // have to hold: it releases the button, it says so exactly once, and a reply
  // disarms it so nothing is written after a save that worked.
  it('releases the button when the reply never comes, and says so once', () => {
    vi.useFakeTimers();
    try {
      const { api, out } = sandbox(true);
      api.save('png');
      expect(api.inFlight()).toBe(true);
      vi.advanceTimersByTime(TIMEOUT_MS + 50);
      expect(api.inFlight()).toBe(false);
      expect(out.length).toBe(1);
      // And askable again, rather than wedged.
      api.save('png');
      expect(api.inFlight()).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a reply disarms the watchdog, so no line follows a save that worked', () => {
    vi.useFakeTimers();
    try {
      const { api, out } = sandbox(true);
      api.save('png');
      api.clear();                       // what the 'save' branch does
      vi.advanceTimersByTime(TIMEOUT_MS * 2);
      expect(out).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('arms the watchdog at the timeout the source declares', () => {
    // Read from source rather than duplicated: retuning the constant is a
    // legitimate change and must not fail a test that asserts no timing.
    expect(TIMEOUT_MS).toBeGreaterThan(0);
    expect(fs.readFileSync(SRC, 'utf8')).toContain('MPL_SAVE_TIMEOUT_MS');
  });

  it('asks the last figure, not the first', () => {
    const { api, sent } = sandbox(true);
    api.save('png');
    expect(sent[0].figure_id).toBe('fig2');
    api.clear();
  });
});

/**
 * The invariant the save design rests on is "mplSaveInFlight is always
 * eventually cleared" -- and a round-3 review found EIGHT one-line reverts to
 * it that passed the whole green suite. Dropping the clear from the SUCCESS
 * branch is the worst: the button wedges for ten seconds, answers every click
 * "Saved", sends nothing, and then prints a failure line about a save that
 * worked. Strictly worse than the bug this branch started by fixing.
 *
 * So the clear sites are executed, not counted.
 */
describe('worker figure save — the wait is always released', () => {
  const SRC = path.join(ROOT, 'public/js/embed/pyodide.js');
  function extract(name) {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error('unbalanced braces extracting ' + name);
  }

  /** handleWorkerFigure, with just enough of its world to drive the replies. */
  // `inFlight` is the panel request id the page is waiting on; replies below
  // carry it unless a test is about a reply that is NOT the panel's.
  const RID = 'panel-1';
  const reply = (extra) => JSON.stringify(Object.assign({ format: 'png', b64: 'aGk=', request_id: RID }, extra));
  function figureHandler(overdue, inFlight = RID) {
    const cleared = [];
    const downloads = [];
    const out = [];
    const doc = {
      getElementById: () => ({ appendChild() {} }),
      createElement: () => ({
        set download(v) { downloads.push(v); },
        get download() { return downloads[downloads.length - 1]; },
        href: '', click() {}, style: {},
      }),
      body: { appendChild() {}, removeChild() {} },
    };
    const fn = new Function(
      'document', 'writeOut', 'clearMplSaveWait', 'takeMplSaveOverdue', 'ensureMplAssets',
      'mplFigures', 'mplLoaded', 'atob', 'URL', 'Blob', 'setTimeout', 'mplSaveRequestId',
      extract('handleWorkerFigure') + 'return handleWorkerFigure;'
    )(doc, (t) => out.push(t), () => cleared.push(1), () => !!overdue, () => {},
      {}, false, (b) => Buffer.from(b, 'base64').toString('binary'),
      { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      function Blob() {}, setTimeout, inFlight);
    return { fn, cleared, downloads, out };
  }

  it("the 'save' branch clears the wait before it downloads", () => {
    const h = figureHandler();
    h.fn({ kind: 'save', data: reply() });
    expect(h.cleared.length).toBe(1);
    expect(h.downloads).toEqual(['plot.png']);
  });

  // The watchdog reports rather than diagnoses, so the reply has to answer it:
  // a save that arrives late must retract the warning, not leave the student
  // with a failure line and a file.
  it('a late arrival retracts the overdue warning', () => {
    const h = figureHandler(true);
    h.fn({ kind: 'save', data: reply() });
    expect(h.out.join('')).toContain('after all');
    expect(h.downloads).toEqual(['plot.png']);
  });

  it('says nothing extra when the save was never overdue', () => {
    const h = figureHandler(false);
    h.fn({ kind: 'save', data: reply() });
    expect(h.out).toEqual([]);
  });

  it("the 'save-error' branch clears the wait and tells the student", () => {
    const h = figureHandler();
    h.fn({ kind: 'save-error', data: JSON.stringify({ error: 'boom', request_id: RID }) });
    expect(h.cleared.length).toBe(1);
    expect(h.out.join('')).toContain('boom');
    expect(h.out.join('')).not.toContain('request_id');
  });

  // The toolbar's own Save sends {type:'save'} with no id. Its reply must still
  // download, and must NOT settle the panel's wait: that cancelled the panel's
  // watchdog, so a panel reply that never came was "Saved" with no line.
  it("a toolbar save's reply downloads but leaves the panel's wait alone", () => {
    const h = figureHandler(true);
    h.fn({ kind: 'save', data: reply({ request_id: null }) });
    expect(h.downloads).toEqual(['plot.png']);
    expect(h.cleared.length).toBe(0);
    expect(h.out.join('')).not.toContain('after all');
  });

  it("a reply to an older panel request leaves the current one's wait alone", () => {
    const h = figureHandler(false, 'panel-2');
    h.fn({ kind: 'save', data: reply() });
    expect(h.downloads).toEqual(['plot.png']);
    expect(h.cleared.length).toBe(0);
  });

  it("a toolbar save-error is reported but leaves the panel's wait alone", () => {
    const h = figureHandler();
    h.fn({ kind: 'save-error', data: JSON.stringify({ error: 'boom', request_id: null }) });
    expect(h.cleared.length).toBe(0);
    expect(h.out.join('')).toContain('boom');
  });

  // Student Python can call _trinket_mpl_send itself with any string.
  it('a bare-string save-error is still reported as-is', () => {
    const h = figureHandler();
    h.fn({ kind: 'save-error', data: 'raw text' });
    expect(h.out.join('')).toContain('raw text');
    expect(h.cleared.length).toBe(0);
  });

  it('a new run cancels a save that can never be answered', () => {
    const calls = [];
    // resetMplFigures also tears down the dpi pane fit's per-figure state
    // (#305). Seeded with a real-shaped entry, so that teardown actually runs
    // ahead of the clear -- an empty map would skip it and could not tell
    // whether it throws before clearMplSaveWait() is reached.
    const removed = [];
    const doc = { removeEventListener: (type, fn) => removed.push(type) };
    const pane = Object.create(null);
    pane.fig1 = { onPointerUp: () => {}, startupTimer: null };
    const fn = new Function('document', 'clearMplSaveWait', 'mplFigures', 'mplGeneration', 'paneFitState',
      extract('resetMplFigures') + 'return resetMplFigures;')(doc, () => calls.push(1), {}, 0, pane);
    fn();
    expect(removed).toEqual(['pointerup', 'pointercancel']);
    expect(calls.length).toBe(1);
  });
});

/**
 * A local reachability round (2026-09-22) found ten one-line reverts that
 * passed the whole suite. These close them. The overdue chain and the catch
 * are EXECUTED; the call sites that live inside functions too entangled to
 * lift (stopCode, startRun, runInWorker, clearMemory, the adapter's ctx) are
 * read as comment-stripped source, and each says what that reading cannot see.
 */
describe('worker figure save — the links nothing executed', () => {
  const SRC = path.join(ROOT, 'public/js/embed/pyodide.js');
  const page = () => fs.readFileSync(SRC, 'utf8');
  function extract(name) {
    const src = page();
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    return balanced(src, start);
  }
  function balanced(src, start) {
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error('unbalanced braces');
  }
  // Code lines only, trimmed: a comment naming a call must not satisfy a test.
  function codeLines(marker) {
    const src = page();
    const at = src.indexOf(marker);
    if (at < 0) throw new Error(marker + ' not found');
    return balanced(src, at).split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .map((l) => l.replace(/\s\/\/\s.*$/, '').trim()).filter(Boolean);   // and trailing comments
  }

  // The REAL overdue state and the real functions that touch it. The older
  // sandbox above never declared mplSaveOverdue, so the watchdog wrote a
  // global and takeMplSaveOverdue was only ever a stub.
  function overdueSandbox(timers, send = () => true) {
    const out = [];
    const figures = { fig1: { socket: { send } } };
    const api = new Function(
      'mplFigures', 'writeOut', 'MPL_SAVE_TIMEOUT_MS', 'setTimeout', 'clearTimeout',
      '"use strict"; var mplSaveInFlight = false, mplSaveWatchdog = null, mplSaveOverdue = false,' +
      '    mplSaveRequestId = null, mplSaveSeq = 0;' +
      extract('clearMplSaveWait') +
      extract('takeMplSaveOverdue') +
      extract('requestWorkerFigureSave') +
      'return { save: requestWorkerFigureSave, clear: clearMplSaveWait, take: takeMplSaveOverdue,' +
      '         inFlight: function () { return mplSaveInFlight; },' +
      '         rid: function () { return mplSaveRequestId; } };'
    )(figures, (t) => out.push(t), 10000, timers.setTimeout, timers.clearTimeout);
    return { api, out };
  }

  it('the watchdog marks the save overdue, and the reply reads that exactly once', () => {
    vi.useFakeTimers();
    try {
      const { api } = overdueSandbox({ setTimeout, clearTimeout });
      api.save('png');
      expect(api.take()).toBe(false);          // not late yet
      vi.advanceTimersByTime(10050);
      expect(api.take()).toBe(true);           // the reply that follows retracts
      expect(api.take()).toBe(false);          // ...and only that one
    } finally { vi.useRealTimers(); }
  });

  // Watchdog fires, then Stop (or a new run): the wait is cleared. The NEXT
  // save's ordinary reply must not print "answered after all" over a save
  // that was never late.
  it('the panel request carries an id, and a new request drops an older overdue', () => {
    vi.useFakeTimers();
    try {
      const sent = [];
      const { api } = overdueSandbox({ setTimeout, clearTimeout }, (m) => { sent.push(m); return true; });
      api.save('png');
      vi.advanceTimersByTime(10050);           // watchdog: overdue, button released
      api.save('png');                         // the student asks again
      expect(sent.map((m) => m.request_id)).toEqual(['panel-1', 'panel-2']);
      expect(api.take()).toBe(false);          // panel-2 is not late
    } finally { vi.useRealTimers(); }
  });

  // The id the reply is matched against: set by the send that was taken,
  // kept through the watchdog (a late reply still retracts), and dropped by
  // every clear so a torn-down request can never be matched again.
  it('remembers the id it sent until the wait is cleared', () => {
    vi.useFakeTimers();
    try {
      const { api } = overdueSandbox({ setTimeout, clearTimeout });
      expect(api.rid()).toBe(null);
      api.save('png');
      expect(api.rid()).toBe('panel-1');
      vi.advanceTimersByTime(10050);
      expect(api.rid()).toBe('panel-1');
      api.clear();
      expect(api.rid()).toBe(null);
    } finally { vi.useRealTimers(); }
  });

  it('a refused send leaves no id behind', () => {
    const { api } = overdueSandbox({ setTimeout, clearTimeout }, () => false);
    expect(api.save('png')).toBe(false);
    expect(api.rid()).toBe(null);
  });

  it('clearing the wait also forgets that an earlier save was overdue', () => {
    vi.useFakeTimers();
    try {
      const { api } = overdueSandbox({ setTimeout, clearTimeout });
      api.save('png');
      vi.advanceTimersByTime(10050);
      api.clear();
      expect(api.take()).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  // The catch matters only when something throws AFTER the flag is set --
  // arming the watchdog is the one statement that can. Without the clear the
  // button wedges: every later click is swallowed as a duplicate.
  it('a throw after the save was marked in flight releases it', () => {
    const { api } = overdueSandbox({
      setTimeout: () => { throw new Error('no timers'); },
      clearTimeout: () => {},
    });
    expect(api.save('png')).toBe(false);
    expect(api.inFlight()).toBe(false);
  });

  // Every teardown that replaces the figures has to cancel a save that can
  // no longer be answered. Deleting any one of these calls passed the suite.
  // Source-text: presence of the statement, not that its branch is taken.
  it.each([
    ['startRun', 'function startRun('],
    ['runInWorker', 'function runInWorker('],
    ['clearMemory', 'clearMemory : function('],
  ])('%s resets the figures, which clears the save wait', (_name, marker) => {
    expect(codeLines(marker)).toContain('resetMplFigures();');
  });

  // Tighter than the ordering test above: the clear is its own statement,
  // immediately before stop() in the same block, so `if (false) clear...`
  // or a clear moved into another branch fails.
  it('stopCode clears the wait as the statement right before stopping the worker', () => {
    const lines = codeLines('function stopCode(');
    const at = lines.indexOf('workerClient.stop();');
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe('clearMplSaveWait();');
  });

  // The adapter's ctx must hand back requestWorkerFigureSave's own answer.
  // `requestWorkerFigureSave(format); return true;` restores "Saved" after a
  // Stop with no file, and passed the suite.
  it("the panel's saveFigure returns the host's answer, with the format", () => {
    const src = page().replace(/\s+/g, ' ');
    expect(src).toMatch(/saveFigure : function\(format\) \{ return requestWorkerFigureSave\(format\); \}/);
  });
});

/**
 * A third local reachability round (2026-09-22) found two links the
 * request-id change left unguarded.
 */
describe('worker figure save — the request id, end to end', () => {
  const SRC = path.join(ROOT, 'public/js/embed/pyodide.js');
  const WORKER = path.join(ROOT, 'public/js/embed/pyodide-worker.js');
  function extract(name) {
    const src = fs.readFileSync(SRC, 'utf8');
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
    }
    throw new Error('unbalanced braces extracting ' + name);
  }

  // The REAL take and clear, sharing real state with the real handler. The
  // handler tests above stub both, so swapping the two calls -- clear first,
  // which resets the flag take reads -- passed the suite and silently lost
  // the "answered after all" retraction.
  it('a late panel reply retracts the overdue line, with the real take and clear', () => {
    const out = [];
    const doc = {
      getElementById: () => ({ appendChild() {} }),
      createElement: () => ({ set download(v) {}, href: '', click() {}, style: {} }),
      body: { appendChild() {}, removeChild() {} },
    };
    const h = new Function(
      'document', 'writeOut', 'ensureMplAssets', 'mplFigures', 'mplLoaded', 'atob', 'URL', 'Blob', 'setTimeout', 'clearTimeout',
      '"use strict"; var mplSaveInFlight = false, mplSaveWatchdog = null, mplSaveOverdue = true,' +
      '    mplSaveRequestId = "panel-1", mplSaveSeq = 1;' +
      extract('clearMplSaveWait') + extract('takeMplSaveOverdue') + extract('handleWorkerFigure') +
      'return { fn: handleWorkerFigure, state: function () {' +
      '  return { overdue: mplSaveOverdue, rid: mplSaveRequestId }; } };'
    )(doc, (t) => out.push(t), () => {}, {}, false,
      (b) => Buffer.from(b, 'base64').toString('binary'),
      { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, function Blob() {}, setTimeout, clearTimeout);
    h.fn({ kind: 'save', data: JSON.stringify({ format: 'png', b64: 'aGk=', request_id: 'panel-1' }) });
    expect(out.join('')).toContain('after all');
    expect(h.state()).toEqual({ overdue: false, rid: null });
  });

  // The worker half of the correlation is Python inside a JS setup string, so
  // it cannot be executed here; the deploy spec runs the save reply's echo.
  // Nothing ran the save-ERROR reply at all: reverting it to a bare str(_err)
  // passed everything, and then a panel save that raised left every Save
  // click for ten seconds answered "Saved" and sent nothing. Source-text,
  // bounded to the save branch and comment-stripped.
  it("the worker echoes the request id in both the save and the save-error reply", () => {
    const src = fs.readFileSync(WORKER, 'utf8');
    const from = src.indexOf("if _evt.get('type') == 'save':");
    const to = src.indexOf('_m.handle_json(_evt)', from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const code = src.slice(from, to).split('\n')
      .filter((l) => !/^\s*['"]\s*#/.test(l.trim()) && !/^\s*\/\//.test(l)).join('\n');
    expect(code).toContain("_rid = _evt.get('request_id')");
    expect(code.match(/'request_id': _rid/g) || []).toHaveLength(2);
    expect(code).toMatch(/'save-error', _json\.dumps\(/);
  });
});
