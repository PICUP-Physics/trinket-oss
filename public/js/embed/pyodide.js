(function(window, TrinketIO) {
// Pyodide trinket runner (proof of concept).
//
// Mirrors the framework-facing surface of /js/embed/python.js (the embed
// framework in embed.js merges window.TrinketAPI over its base API and drives
// it via initialize / getType / getValue / serialize / reset and the
// trinket.code.* events), but swaps the Skulpt execution core for Pyodide —
// real CPython compiled to WASM, loaded from the jsDelivr CDN.
//
// Out of scope for this slice: turtle/matplotlib graphics, micropip packages,
// input()/stdin, the interactive console REPL, drafts autosave hooks, hints,
// and the unittest checker.

// Injected by the embed template from config.features.pyodideVersion; fallback for non-template contexts.
var PYODIDE_INDEX_URL = window.__PYODIDE_INDEX_URL__ || 'https://cdn.jsdelivr.net/pyodide/v0.28.1/full/';

// VPython/GlowScript support (experimental). When a program is detected as
// VPython, we load the GlowScript graphics library and a Python `vpython`
// bridge package into Pyodide so real CPython can drive 3D objects (sphere,
// box, rate(), …) — the approach proven by webvpython's wmWVPRunner. The glow
// library is the same build the `glowscript` trinket uses; the bridge zip is
// the webvpython `vpython` package.
// 3.2.3 = the rsWVPRunner GCS build the Dockerfile provisions; 3.2.2 was the stale components-tarball fallback (spec 2026-08-10, decision V3).
var GLOW_SRC = '/components/vpython-glowscript/package/glow.3.2.3.min.js';
// Asset URLs built here at runtime must carry the deploy token or they are
// served max-age=300 and re-fetched every five minutes (#234). Stamp ONLY when
// the embed projected assetToken (#270): without it trinketConfig.prefix()
// falls back to Date.now(), a url nothing has cached -- worse than bare (#269).
function assetUrl(path) {
  var cfg = window.trinketConfig;
  return (cfg && cfg.get && cfg.get('assetToken')) ? cfg.prefix(path) : path;
}
var VPYTHON_ZIP_URL = assetUrl('/js/embed/wvpython/vpython.zip');
// The vpython-jupyter wheel the WORKER path installs (spec 2026-08-10) — a
// different package from the main-thread bridge zip above. This name is the ONE
// place the page says which file to fetch; scripts/sync-vpython-worker.sh reads
// it back and refuses to sync a wheel that does not match, because a bump on one
// side alone is a run-time 404 with nothing pointing at the cause.
var VPYTHON_WHEEL_NAME = 'vpython-7.6.6.dev0-py3-none-any.whl';

// Python code injected before user code runs each time a matplotlib program
// executes.  Pyodide 0.28+ ships a Pyodide-patched WebAgg backend that reads
// document.pyodideMplTarget (set by JS below) so figures land in #graphic,
// and wires the full interactive toolbar + 3D mouse-orbit automatically.
// plt.close('all') ensures stale figures from a previous run don't resurface.
// figure.autolayout keeps axis labels/titles from clipping (picup PR #18).
//
// #254: plt.show() is also made idempotent PER FIGURE here, and a repeat
// show() of a figure already on the page redraws it in place.
//
// Pyodide's webagg manager.show() builds a brand new mpl.figure and appends it
// to document.pyodideMplTarget on every call, overwriting self.js_fig — so a
// show() inside a loop stacks one orphaned container per pass. Measured on a
// six-iteration loop: six containers, all labelled "Figure 1", 3,726px of pane
// for a program with exactly one figure (get_fignums() == [1]).
//
// `js_fig` is the "already on the page" marker, and it lives on the MANAGER,
// which is what makes this safe against the trap that produced defect 3:
// plt.close() destroys the manager, so a figure created afterwards gets a
// fresh manager with no js_fig even though matplotlib REUSES the number.
// Measured: two successive figures both report number 1 with different id().
// A registry keyed on the figure number would silently never draw the second.
//
// Redrawing in place is draw_idle() + refresh_all(), which pushes a new image
// over the socket the existing js_fig is already attached to. Verified against
// a control run: same single container, different rendered pixels.
var MATPLOTLIB_SETUP_CODE = [
  "import matplotlib",
  "matplotlib.use('webagg')",
  "matplotlib.rcParams['figure.autolayout'] = True",
  "import matplotlib.pyplot as _plt",
  "_plt.close('all')",
  "",
  "def _trinket_show(*args, **kwargs):",
  "    import warnings",
  "    from matplotlib._pylab_helpers import Gcf",
  "    from matplotlib.backend_bases import NonGuiException",
  "    from matplotlib.backends.backend_webagg import WebAggApplication",
  // Loads mpl.css and the mpl JS the figure constructor needs. Skipping it
  // fails with "ReferenceError: mpl is not defined" on the very first show;
  // it guards on cls.initialized and returns early, so calling it every time
  // costs nothing after the first.
  "    WebAggApplication.initialize()",
  "    for _m in Gcf.get_all_fig_managers():",
  // Mirror matplotlib's own pyplot_show, which catches NonGuiException and
  // warns rather than raising. A student who calls switch_backend('agg') and
  // then show() gets a warning upstream; without this they would get a
  // traceback pointing into injected code they never wrote.
  "        try:",
  "            if getattr(_m, 'js_fig', None) is None:",
  "                _m.show()",
  "            else:",
  "                _m.canvas.draw_idle()",
  "                _m.refresh_all()",
  "        except NonGuiException as _exc:",
  // stacklevel=2 attributes the warning to the CALLER -- the student's own
  // plt.show() line. Without it the warning is stamped with the injected
  // wrapper's location, which surfaces as "<exec>:21: UserWarning: ..." for
  // code the student cannot see or open.
  "            warnings.warn(str(_exc), stacklevel=2)",
  "",
  // Patch after use(), which selects the backend show() dispatches to. The
  // name is deleted so nothing is left behind in pyodide.globals for the
  // Variables tab to list; the function itself survives as pyplot.show.
  "_plt.show = _trinket_show",
  "del _plt, _trinket_show",
].join('\n');

// The `console` module surfaced to python3 user code: an async input() that
// reads inline from the trinket console. `input()` (the builtin) is unchanged;
// this is an opt-in, importable alternative. runPythonAsync permits the await.
// The `r is None` / EOFError branch mirrors the `input()` builtin's cancel
// handling, but jqconsole has no cancel affordance today, so __trinket_console_input
// never actually resolves null — this is reserved for a future stop mechanism
// (kept intentionally, not dead code to delete).
var CONSOLE_MODULE_CODE = [
  'import js',
  '',
  'async def input(prompt=""):',
  '    r = await js.window.__trinket_console_input(str(prompt) if prompt else "")',
  '    if r is None:',
  '        raise EOFError',
  '    return str(r)',
  ''
].join('\n');

var api;
var codeRuns = {};
var editor;
var start, runOption;
var autoRun;
var isConsoleOpen = false;
var jqconsole;
var mainFile = 'main.py';
var template = TrinketIO.import('utils.template');
var ActivityLog = TrinketIO.import('embed.analytics.activity');
var runtimeRouter   = TrinketIO.import('embed.runtimeRouter');
var consoleBuffer   = TrinketIO.import('embed.consoleBuffer');
var workerClientApi = TrinketIO.import('embed.workerClient');
var replContinuation = TrinketIO.import('embed.replContinuation');
var workerClient    = null;   // created lazily; null means the main-thread path
var disableAceEditor = window.userSettings && window.userSettings.disableAceEditor || false;

// Pyodide is loaded lazily on the first run so the ~10MB download doesn't block
// page load. pyodideLoading memoizes the in-flight / completed load promise.
var pyodide = null;
var pyodideReady = false;
var pyodideLoading = null;
var running = false;

function loadingHeader() {
  var src = (window.trinketConfig && trinketConfig.logo)
    ? trinketConfig.logo()
    : '/img/trinket-logo.png';
  return '<span class="jqconsole-header" aria-hidden="true" role="presentation">Powered by '
    + '<img id="powered-by-trinket" src="' + src + '">\n</span>';
}

function initConsoleOutput() {
  if (isConsoleOpen) return;

  isConsoleOpen = true;
  $('#console-wrap').removeClass('hide');
  $('#console-wrap').css('height', '100%');

  jqconsole = $('#console-output').jqconsole();
  outResetBuffer();
  jqconsole.Write("\x1b[0m");
  jqconsole.Reset();
  jqconsole.Append(loadingHeader());
}

function resetOutput(consoleOnly) {
  // Clearing output while a step-through replay is active would otherwise
  // leave a half-state: blank console but replay-locked variables and live
  // step controls. Exit replay first (quiet — this reset IS the console
  // rewrite). No-op when replay isn't active.
  exitReplay(true);

  if (editor) {
    editor.clearTabMarkers();
  }

  if (jqconsole) {
    // Discard queued output too: the console it was headed for is gone, and a
    // pending flush would otherwise paint the old run's tail into the new one.
    outResetBuffer();
    jqconsole.Write("\x1b[0m");
    jqconsole.Reset();
    jqconsole.Append(loadingHeader());
  }

  // A fresh run may interrupt a pending console.input() (jqconsole is reset
  // above, so its Input() callback — the only other place this class is
  // removed — never fires). Clear it here too so stale "active input"
  // styling can't survive into a run that isn't waiting on input.
  $('#console-output').removeClass('console-active');

  if (!consoleOnly) {
    $('#graphic').empty();
    $('#graphic').removeData("graphicMode");
  }
}

// ---------------------------------------------------------------------------
// Console output buffering (#142)
//
// pydoc's plain_pager hands `help(numpy)` to stdout as ONE 2.45 MB write, and
// Pyodide's batched stdout flushes on every newline — so the console took
// 70,605 separate writes. Each jqconsole.Write appends a span and then calls
// _ScrollToEnd, which READS scrollHeight and .position() before writing back:
// a forced layout per line, against a container growing to 70k children. The
// cost is superlinear, and it is all synchronous on the main thread, so the
// page stops painting and Stop can never fire. `help(np)` looks like a harmless
// one-liner and froze the tab for minutes.
//
// Two guards, both general — the trigger is output VOLUME, not help():
//
//   1. Coalesce. Text queues and is appended once per animation frame in a
//      single Write, so N lines cost one reflow per frame instead of N.
//   2. Cap. Program output stops being APPENDED past the line limit (the
//      program itself keeps running). Coalescing alone is not enough: a big
//      enough program still builds a DOM the browser cannot lay out.
//
// Three paths share the one queue, which is what keeps them ordered:
//   writeStream() — program stdout/stderr; capped.
//   writeOut()    — loader notices, '[stopped]'; queued but never capped, since
//                   those must survive a truncated run.
//   consoleWrite()— styled/immediate (errors, headers, REPL results); flushes
//                   the queue first so it cannot jump ahead of program output.
// The queue/cap accounting is in embed/console-buffer.js, kept pure so the
// rules are testable in node (same split as runtime-router.js). Timers and the
// actual write stay here, where the DOM is.
// maxRich is far smaller than maxLines because one extra typeset card costs
// ~14 ms against microseconds for a printed line; past it results degrade to
// plain text rather than being dropped. Measurements are in console-buffer.js.
var outBuf   = consoleBuffer.createOutputBuffer({ maxLines: 5000, maxRich: 30 });
var outRaf   = null;
var outTimer = null;

function outCancelFlush() {
  if (outRaf !== null && window.cancelAnimationFrame) window.cancelAnimationFrame(outRaf);
  if (outTimer !== null) clearTimeout(outTimer);
  outRaf = null;
  outTimer = null;
}

// rAF coalesces to one append per painted frame, but it does NOT fire in a
// backgrounded tab — a program finishing there would strand its last output.
// The timer is the backstop; whichever fires first cancels the other.
function outScheduleFlush() {
  if (outRaf !== null || outTimer !== null) return;
  if (window.requestAnimationFrame) {
    outRaf = window.requestAnimationFrame(function() { outRaf = null; flushConsoleNow(); });
  }
  outTimer = setTimeout(function() { outTimer = null; flushConsoleNow(); }, 100);
}

// One Write per run of text — this is the whole point: N lines cost one
// reflow, not N. Typeset math cards (features.mathOutput) sit in the same
// queue, so they are rendered here too, in the order the program produced
// them; runs of text on either side still coalesce into a single Write.
function flushConsoleNow() {
  outCancelFlush();
  var segments = outBuf.drain();
  if (!segments.length || !jqconsole) return;
  for (var i = 0; i < segments.length; i++) {
    // The empty-string check keeps exact parity with the pre-rich flush, which
    // tested the joined string for truthiness and so never wrote an empty span.
    if (typeof segments[i].text === 'string') {
      if (segments[i].text) jqconsole.Write(segments[i].text);
    } else if (segments[i].rich) {
      var item = segments[i].rich;
      // Dispatch on kind so a second rich kind is additive. Anything
      // unrecognised — including a payload predating the discriminator — takes
      // the math card, which already degrades to the text form when there is no
      // latex. The default is load-bearing, not laziness: _trinket_display.py is
      // fetched at run time while this file is a cached, cache-prefixed asset,
      // so a deploy can briefly pair new Python with old JS. Dropping unknown
      // kinds would break renderMathCard's invariant that output is never lost.
      switch (item.kind) {
        default: renderMathCard(item);
      }
    }
  }
}

// Drop anything queued: the console it was destined for is being rebuilt.
function outResetBuffer() {
  outCancelFlush();
  outBuf.reset();
}

// System/UI text — queued (so it stays ordered with program output) but never
// capped.
function writeOut(text) {
  initConsoleOutput();
  if (!jqconsole) return;
  outBuf.pushSystem(text);
  outScheduleFlush();
}

// Program stdout/stderr — queued AND capped.
function writeStream(text) {
  initConsoleOutput();
  if (!jqconsole) return;
  outBuf.pushStream(text);
  outScheduleFlush();
}

// One typeset result — queued AND capped, exactly like program output, which
// is what keeps a card in program order relative to print() and stops a
// derivation loop building an unlayoutable DOM.
function queueMathCard(payload) {
  if (!payload) return;
  initConsoleOutput();
  if (!jqconsole) return;
  // Started here, not in renderMathCard, for two reasons: the load overlaps the
  // rest of the run instead of starting a frame later, and the 'Loading math…'
  // notice is queued BEFORE this card rather than appearing under it.
  if (payload && payload.latex) { ensureKatex().catch(function() {}); }
  outBuf.pushRich(payload);
  outScheduleFlush();
}

// A styled or immediate write (errors, headers, REPL results). Flushes the
// queue first so it cannot jump ahead of program output already emitted.
function consoleWrite(text, cls, escape) {
  flushConsoleNow();
  if (jqconsole) jqconsole.Write(text, cls, escape);
}

// Direct, synchronous console write that bypasses Pyodide's *batched* stdout
// (which buffers partial lines until a newline). Used to echo an input prompt
// into the console before a blocking window.prompt, and by the console module's
// inline input. Exposed on window so Pyodide's `from js import ...` can reach it.
window.__trinket_console_write = function(text) {
  writeOut(String(text));
  // The "synchronous" in the contract above is load-bearing, and #142's
  // coalescing broke it: the one caller is the input() shim, which echoes the
  // prompt and then calls window.prompt(), blocking the JS thread. A blocked
  // thread never reaches an animation frame, so a queued echo stays invisible
  // until the dialog is dismissed — the student sees a bare box with no
  // question, which is the exact bug this echo was added to fix.
  flushConsoleNow();
};

// Inline console input for the `console` module: append the prompt, open a
// jqconsole input field, resolve with the typed line. Same widget/flow the
// Skulpt runner uses (python.js: skulpt_inputfun). jqconsole.Input has no
// cancel affordance, so `resolve` here only ever fires with the typed line;
// the Promise<string|null> signature (and the module's EOFError-on-null
// branch) is reserved for a future stop mechanism, not reachable today.
window.__trinket_console_input = function(prompt) {
  initConsoleOutput();
  window.readyForSnapshot = true;
  return new Promise(function(resolve) {
    // Anything the program printed before asking has to land BEFORE the input
    // widget: a queued flush landing afterwards would put the question above
    // output that preceded it.
    flushConsoleNow();
    if (prompt) { consoleWrite(String(prompt)); }
    var active = document.activeElement;
    $('#console-output').addClass('console-active');
    jqconsole.Input(function(line) {
      $('#console-output').removeClass('console-active');
      resolve(line);
      if (active) { try { $(active).focus(); } catch (e) {} }
    });
    if (!autoRun) {
      jqconsole.Focus();
    }
  });
};

// ---------------------------------------------------------------------------
// SPIKE (issue #109): interactive REPL on Pyodide.
//
// The "Interactive console" the Share dialog used to advertise was the
// server-backed `console` trinket type, which is gone. Pyodide ships its own
// REPL engine (pyodide.console.PyodideConsole) that handles the hard part —
// deciding whether a line completes a statement — so the work here is only
// wiring it to jq-console, which is already bundled and already drives program
// output and input().
//
// The loop deliberately mirrors python.js's Skulpt REPL (startPrompt): a
// jqconsole.Prompt whose second callback reports how far to indent a
// continuation line, then re-prompt after each evaluation.
//
// TWO EXISTING SYSTEMS THIS MUST NOT DISTURB — both are safe by construction:
//
//  1. VPython rate() cancellation. The wrapper around window.rate() and the
//     cancelRequested/rerunQueued state belong to runProgram; a REPL evaluation
//     never enters that path, never sets runningIsVpython, and never installs or
//     removes the rate wrapper. (A VPython animation typed AT the prompt is out
//     of scope for the spike — it would run with the unwrapped rate().)
//
//  2. console.input(). It calls jqconsole.Input(), which cannot coexist with an
//     ACTIVE jqconsole.Prompt. It doesn't have to: exactly as in python.js, the
//     prompt is consumed before evaluation begins and is only re-armed after the
//     evaluation settles — so during evaluation jqconsole is free, and
//     `console.input()` typed at the REPL works unchanged. `await` at the prompt
//     works too, because PyodideConsole evaluates asynchronously.
// ---------------------------------------------------------------------------
var pyodideConsole = null;   // the PyodideConsole instance, created on first use
var replActive     = false;  // a REPL prompt is armed or evaluating
// True only while a MAIN-THREAD REPL statement is actually executing. Distinct
// from replActive, which stays true for the whole console session: gating on
// that would disable the plot-style panel's live preview for as long as a
// student leaves the prompt open, which is most of the lesson.
//
// The window that matters is the await inside the Prompt callback below.
// PyodideConsole evaluates asynchronously and a REPL turn deliberately never
// sets `running` (see the note above), so without this flag every other "is
// Python busy?" test reads false while a statement is mid-flight, and the panel
// would re-enter this thread's Pyodide from a JS callback inside an awaited
// Python frame. The worker-backed REPL needs no equivalent: its interpreter is
// off-thread, and a worker run gives the panel no backend at all.
var replEvaluating = false;

// Build the PyodideConsole. Its globals are the SAME namespace the Run button
// uses, so a REPL session can inspect what a program just defined — the main
// reason a REPL is useful in a classroom.
function ensurePyodideConsole() {
  if (pyodideConsole) return pyodideConsole;
  pyodideConsole = pyodide.runPython(
    'from pyodide.console import PyodideConsole\n' +
    'PyodideConsole(globals())\n'
  );
  return pyodideConsole;
}

// jqconsole's Write(text, cls, escape) inserts raw HTML when `escape` is false.
// Everything we put in the console is Python text, and Python text is full of
// angle brackets: a traceback names its scope `<module>` and its console frame
// `<console>`, and repr() renders an object as `<Foo object at 0x…>`. Parsed as
// HTML those become unknown tags and DISAPPEAR — which is why a REPL traceback
// rendered as `File "", line 1, in ` with both names silently eaten, and why the
// dangling `, in` this file documents was never Python's doing at all.
//
// It is also an injection hole: an exception message or a repr that contains
// markup is executed by the page, and both can carry student-controlled text.
//
// The fix is the convention python.js already uses — escape here, keep the
// `false` (jqconsole's own escaping would also swallow the ANSI codes the run
// path emits).
function escapeConsoleHtml(text) {
  var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
}

// Write an error raised at the REPL prompt, through the SAME traceback filter
// the Run button uses (#107). Without this the REPL reported the raw Pyodide
// traceback — a dozen frames of console.py, codeop.py and _base.py above the one
// line that matters — which is precisely the noise #107 exists to remove. The
// frames are, if anything, worse here: at a prompt every frame above the user's
// single line is interpreter plumbing.
//
// `<stdin>` matches what CPython names the console frame, so a filtered REPL
// traceback reads exactly like the one a student sees in a terminal.
// The DOM half of switching to the output pane, WITHOUT running anything.
// showResult() does this and then calls runCode(); the REPL needs the switch but
// must NOT run the program — runCode() resets the console, which would wipe the
// REPL's transcript and namespace every time Console was selected.
function showOutputPane() {
  $('#codeOutput').removeClass('hide');
  $('#editor').addClass('hide');

  api.closeOverlay('#modules');

  $('#instructionsContainer').addClass('hide');
  $('#outputContainer').removeClass('hide');

  $('#codeOutputTab').addClass('active');
  $('#instructionsTab').removeClass('active');
  hideVariables();     // a run always returns focus to the Result pane
}

function writeReplError(err) {
  var msg = String(err && err.message || err);
  consoleWrite(escapeConsoleHtml(formatPythonTraceback(msg, '<stdin>')) + '\n', 'jqconsole-error', false);
}

// #128: reads and whitelists the trinket's own stored runtime setting, shared
// by replUsesWorker() (below) and the Run path (chooseRuntimeDecision()).
// Whitelisted here as well as on the server (lib/controllers/trinket.js)
// because this value is client-supplied data that also renders back into the
// settings modal — a value that predates or bypasses server validation must
// degrade to "no preference", not reach the rules.
//
// Read from api._trinket, not window.trinket: window.trinket is a DIFFERENT
// global (the `{config: {...}}` object embed/base.html's inline <script>
// creates) that never carries the trinket's settings. api._trinket is the live
// TrinketApp instance's trinket data (set by setTrinket() before initialize()
// runs, and already read the same way elsewhere in this file, e.g.
// api._trinket.description) — verified live against a stored
// settings.runtime='worker' trinket, where window.trinket.settings was
// undefined and api._trinket.settings was {runtime: 'worker'}.
function getStoredRuntime() {
  try {
    var settings = (api._trinket && api._trinket.settings) || {};
    if (settings.runtime === 'worker' || settings.runtime === 'main') {
      return settings.runtime;
    }
  } catch (e) {}
  return '';
}

// Does the REPL run in the worker? A REPL statement has no source to inspect up
// front, so the decision is made once from config and the query string rather
// than per statement.
//
// #128: MUST pass storedRuntime, same as the Run path — otherwise a trinket
// with settings.runtime='worker' runs Run in the worker but opens the REPL on
// a second, main-thread Pyodide (ensurePyodide(), a multi-MB download), and
// every variable the student's program just defined comes back NameError:
// the two namespaces live on different threads. The guard cannot trip here
// (called with an empty source), so this is purely about the stored value
// reaching the router.
function replUsesWorker() {
  try {
    return runtimeRouter.chooseRuntime('', {
      usesVPython   : false,
      workerEnabled : !!(window.trinket && window.trinket.config && window.trinket.config.workerRuntime),
      queryRuntime  : (api._queryString || {}).runtime,
      storedRuntime : getStoredRuntime()
    }).runtime === 'worker';
  } catch (e) { return false; }
}

// A console statement can change the scene — `ball.color = color.blue` is the
// whole point of having a REPL next to a 3D canvas — but only when both flags are
// on, so the REPL and the VPython run share one worker interpreter. The update it
// makes lands in the transport's buffer and stays there: the transport is
// request/reply, and the clock that does the asking belongs to the RUN, which
// ended. Nothing would flush it until some unrelated browser event happened to,
// which for a still scene is never.
//
// So: one ping when the statement settles, which is the tick that statement is
// owed. Deliberately the bare trigger rather than frontend.tick() — the clock is
// stopped, pacingStopped() has already put the front-end in its flush-everything
// state, and tick() would undo that.
function flushVPythonAfterRepl() {
  if (!vpythonFrontend || !workerClient) return;
  workerClient.sendSceneEvent('[{"trigger":1}]');
}

// One REPL turn: read a (possibly multi-line) statement, evaluate, print, repeat.
function startReplPrompt() {
  if (!jqconsole) return;
  replActive = true;

  // The previous statement's output must be on screen before the next prompt.
  flushConsoleNow();
  // Give each statement its own output budget. The cap is there to stop one
  // runaway command, and at the REPL "one command" is the natural unit — a
  // single `help(numpy)` should not leave the console mute for the session.
  outBuf.resetCap();

  jqconsole.Prompt(true, function(input) {
    // Worker-backed REPL: the namespace lives in the worker, so a runaway
    // statement is killable. Output and errors arrive on the same callbacks the
    // Run path uses, so formatting is shared.
    if (replUsesWorker()) {
      if (/^\s*$/.test(input)) { startReplPrompt(); return; }
      $('.stop-it').removeClass('hide');
      ensureWorkerClient().pushRepl(input).then(function() {
        $('.stop-it').addClass('hide');
        flushVPythonAfterRepl();
        startReplPrompt();
      });
      return;
    }

    // Blank line: just re-prompt (matches python.js and the CPython REPL).
    if (/^\s*$/.test(input)) { startReplPrompt(); return; }

    var console_ = ensurePyodideConsole();
    var result;
    replEvaluating = true;
    try {
      result = console_.push(input);
    } catch (e) {
      replEvaluating = false;
      writeReplError(e);
      startReplPrompt();
      return;
    }

    // push() returns a Future; awaiting it runs the statement. Errors arrive as
    // a rejection carrying the formatted traceback, which is what we display.
    Promise.resolve(result)
      .then(function(value) {
        if (value !== undefined && value !== null) {
          consoleWrite(escapeConsoleHtml(pyodide.runPython('repr')(value)) + '\n', 'jqconsole-output', false);
        }
      })
      .catch(function(err) {
        writeReplError(err);
      })
      // Runs on both outcomes -- the .catch above absorbs the rejection -- so
      // the flag cannot be stranded true by a failed statement.
      .then(function() { replEvaluating = false; startReplPrompt(); });

  }, function(input) {
    // Continuation callback. jq-console's contract (see python.js's Skulpt REPL,
    // which defaults `multilineReturn = false`): return FALSE to submit the
    // statement, or a NUMBER to keep reading with that indent. Returning 0 does
    // NOT mean "execute" — it means "continue, indent 0", which is how the first
    // version of this spike left every expression sitting at a `...` prompt.
    //
    // Ask Python itself whether the statement is finished: codeop.compile_command
    // is what the CPython REPL uses, returns None while input is incomplete, and
    // has no side effects (pushing the line into the console buffer would consume
    // it).
    // With the interpreter in the worker there is no local Python to ask, and
    // jq-console needs this answer synchronously — use the pure approximation.
    if (replUsesWorker()) {
      if (replContinuation.isComplete(input)) return false;      // submit
      return replContinuation.indentLevel(input);
    }

    try {
      var complete = pyodide.runPython(
        'import codeop\n' +
        'def __trinket_is_complete(src):\n' +
        '    try:\n' +
        '        return codeop.compile_command(src, "<console>", "single") is not None\n' +
        '    except (SyntaxError, OverflowError, ValueError):\n' +
        '        return True\n' +   // let evaluation report the real error
        '__trinket_is_complete\n'
      )(input);
      if (complete) return false;   // submit
    } catch (e) {
      return false;                 // submit; let evaluation surface the error
    }

    var lines = input.split('\n');
    var last  = lines[lines.length - 1] || '';

    // CPython's REPL rule: inside a block, a BLANK line ends it. Without this the
    // block never terminates — codeop keeps reporting "incomplete" for a suite
    // that could still be extended, so the prompt sits at `...` forever.
    if (lines.length > 1 && /^\s*$/.test(last)) return false;

    // The number is an indent LEVEL (jq-console multiplies it), NOT a character
    // count. Returning the measured character width made each continuation line
    // deeper than the last — 4, then 8, then 26 spaces. python.js only ever
    // returns 0/1/small negatives for the same reason: 1 to open a suite after a
    // colon, 0 to hold the current indent.
    return /:\s*$/.test(last) ? 1 : 0;
  });
}

// Enter REPL mode: boot Pyodide, print a banner, arm the prompt.
//
// Re-entrant by accident until now. reset() calls this whenever trinket content
// arrives, and an authenticated session loads its draft AFTER the first prompt
// is already armed — so a second call ran initConsoleOutput(), which resets
// jq-console, wiping the transcript and the student's session, and then armed a
// second prompt on top of the first. Nothing about the REPL had changed; only
// the console it was drawing into was thrown away underneath it.
//
// The namespace itself survives (ensurePyodideConsole is memoised), so what a
// student loses is everything they can see plus the input they had typed.
function startRepl() {
  if (replActive) {
    // Already running: leave the live session alone.
    return Promise.resolve();
  }

  initConsoleOutput();

  // In worker mode the interpreter is not on this thread. Do NOT call
  // ensurePyodide() below: that would boot a SECOND Pyodide on the main thread
  // purely to read sys.version for the banner, doubling start-up and memory for
  // an interpreter that never runs anything. The worker reports its version in
  // its ready message.
  if (replUsesWorker()) {
    $('#console-output').addClass('console-mode');
    var client = ensureWorkerClient();
    return client.ready().then(function(info) {
      consoleWrite('Python ' + (info.pythonVersion || '') +
                      ' on Pyodide — type Python at the >>> prompt\n', 'jqconsole-header', true);
      startReplPrompt();
    });
  }

  // The console palette is a MODE, not a default. Base `.jqconsole-output` is
  // WHITE, for the dark console a running program draws into; the light REPL
  // palette lives behind `.console-mode` (static/scss/embed/_python.scss). The
  // Skulpt REPL sets that class on the way in (python.js) and the run path
  // clears it again. This REPL only ever cleared it, so its output was white on
  // the near-white (#f9f9f9) REPL background — legible only by selecting it.
  $('#console-output').addClass('console-mode');

  return ensurePyodide().then(function() {
    consoleWrite('Python ' + pyodide.runPython('import sys; sys.version.split()[0]') +
                    ' on Pyodide — type Python at the >>> prompt\n', 'jqconsole-header', true);
    startReplPrompt();
  }).catch(function(err) {
    writeReplError(err);
  });
}

function ensurePyodide() {
  if (pyodideLoading) return pyodideLoading;

  if (typeof loadPyodide !== 'function') {
    return Promise.reject(new Error('Pyodide failed to load from the CDN.'));
  }

  pyodideLoading = loadPyodide({ indexURL: PYODIDE_INDEX_URL }).then(function(py) {
    pyodide = py;
    // pyodideReady is set at the END of this chain, not here. It gates Clear
    // memory (clearMainThreadMemory) and the Variables helpers, all of which
    // need __trinket_reset_baseline__ to exist — and with features.mathOutput
    // on there is now a real network fetch between here and that snapshot.
    // Clicking Clear memory inside that window would report "Could not clear
    // Python memory; reload the page".
    // Route Python stdout/stderr into the trinket console. batched gives us the
    // text without its trailing newline, so we re-add it per write.
    py.setStdout({ batched: function(s) { writeStream(s + '\n'); } });
    py.setStderr({ batched: function(s) { writeStream(s + '\n'); } });
    // Wire input() to a browser prompt. Pyodide configures no stdin by default,
    // so CPython's input() raises `OSError: [Errno 29] I/O error` the instant a
    // program reads input — which broke every intro-course trinket that uses
    // input(). Override the builtin directly (robust across Pyodide's evolving
    // setStdin/autoEOF contract): echo the prompt to the console (as a terminal
    // would), collect one line via window.prompt (also shown in the dialog),
    // echo the entry back, and treat a cancelled dialog as EOF. Runs once at
    // init; self-deletes its temporaries so the variable explorer and
    // __trinket_baseline__ stay clean.
    try {
      py.runPython([
        'def _trinket_input(prompt=""):',
        '    import js',
        '    if prompt:',
        '        js.window.__trinket_console_write(str(prompt))',
        '    r = js.window.prompt(str(prompt) if prompt else "")',
        '    if r is None:',
        '        print()',
        '        raise EOFError',
        '    print(r)',
        '    return str(r)',
        'import builtins as _b',
        '_b.input = _trinket_input',
        'del _b, _trinket_input'
      ].join('\n'));
    } catch (e) {}
    // Make `import console` resolve to the inline-input module (opt-in; the
    // builtin input() above is unchanged). Written to the Pyodide working
    // directory (/home/pyodide), which is on sys.path, so a plain
    // `import console` finds it.
    //
    // This write is unconditional, so a trinket that ships its OWN console.py
    // (a secondary file synced via syncFilesToFS) shadows it — last write wins,
    // and the user's module is what `import console` resolves to. In that case
    // userShadowsConsole() (near usesConsole, below) detects the user file and
    // SKIPS the async transform, so their code runs untransformed — pre-feature
    // behavior — instead of the transform inserting `await` before a
    // `console.input(...)` call that may not be a coroutine in their module (a
    // hard error).
    try {
      py.FS.writeFile('console.py', CONSOLE_MODULE_CODE);
    } catch (e) {}
    // Typeset math output: install the display module BEFORE the baseline
    // snapshot below. display() and the expression hook live on `builtins`, not
    // in globals(), but the `import _trinket_display` binding does not — and
    // installing ahead of the snapshot is what makes Clear memory
    // (clearMainThreadMemory, which restores __trinket_reset_baseline__) leave
    // the feature working instead of half-removed.
    //
    // Returned as a promise so the fetch completes before the snapshot is
    // taken. With the flag off this whole step is skipped and nothing is
    // fetched.
    return (mathOutputEnabled()
      ? fetch(TRINKET_DISPLAY_URL)
          .then(function(r) {
            // fetch does NOT reject on 4xx/5xx. Without this check a 404's HTML
            // body gets written to the Pyodide FS as _trinket_display.py and
            // only fails later, as a Python SyntaxError on the import — which
            // hides the actual HTTP status from anyone debugging a deploy.
            if (!r.ok) {
              throw new Error('HTTP ' + r.status + ' fetching ' + TRINKET_DISPLAY_URL);
            }
            return r.text();
          })
          .then(function(src) {
            py.FS.writeFile('_trinket_display.py', src);
            return py.runPythonAsync([
              'import _trinket_display as _d',
              'import json as _json',
              'import js as _js',
              // json.dumps in Python so no PyProxy crosses into JS and nothing
              // needs destroying — the same shape the Variables snapshot uses.
              //
              // dumps and the JS callback are bound as DEFAULT ARGUMENTS, not
              // read from globals: the del below removes the module names, and
              // a lambda body would have resolved them at call time and raised
              // NameError on the first displayed expression. Defaults are
              // evaluated here, once, and travel with the function.
              'def _trinket_sink(p, _dumps=_json.dumps, _rich=_js.window.__trinket_rich):',
              '    _rich(_dumps(p))',
              '_d.install(_trinket_sink)',
              // Same tidiness as the input() override above: the runner's own
              // temporaries do not belong in the student's namespace. The sink
              // survives because the module holds the reference.
              'del _d, _json, _js, _trinket_sink'
            ].join('\n')).then(function() {
              displayHookReady = true;
            });
          })
          .catch(function(e) {
            // A failed install must not stop the runtime booting: the student
            // loses typeset output, not their trinket.
            //
            // One exception, worth naming because the sentence above overstates
            // it: `display` is installed by _trinket_display.install, which is
            // inside the then() above, so with no helper a `display(...)` call
            // raises NameError while a bare expression is merely silent. The
            // worker behaves identically (see ensureDisplay in
            // pyodide-worker.js, which carries the same contract in full).
            try { console.warn('[mathOutput] display hook unavailable:', e); } catch (e2) {}
          })
      : Promise.resolve()
    ).then(function() {
      // Record the pristine namespace twice:
      //
      // - __trinket_baseline__ is the set the Variables panel hides.
      // - __trinket_reset_baseline__ is a shallow copy used by Clear memory to
      //   restore the runner's own globals without re-downloading Pyodide.
      //
      // The self-reference is intentional. A plain dict(globals()) is evaluated
      // before its assignment, so it would otherwise omit the reset snapshot and
      // work only once.
      try {
        py.runPython([
          '__trinket_baseline__ = set(globals().keys())',
          '__trinket_reset_baseline__ = dict(globals())',
          '__trinket_reset_baseline__["__trinket_reset_baseline__"] = __trinket_reset_baseline__',
          '__trinket_baseline__.add("__trinket_reset_baseline__")'
        ].join('\n'));
      } catch (e) {}
      pyodideReady = true;
      return py;
    });
  });

  return pyodideLoading;
}

// Writes secondary .py files to the Pyodide FS so `import` works, and returns
// the contents of the main file to execute.
function syncFilesToFS(files, main) {
  var prog = '', key;
  for (key in files) {
    if (!files.hasOwnProperty(key)) continue;
    if (key === main) {
      prog = files[key];
    }
    else if (/\.py$/.test(key)) {
      try { pyodide.FS.writeFile(key, files[key]); } catch (e) {}
    }
  }
  return prog;
}

// Heuristics on the source so we can show a "loading packages" hint and decide
// whether to set up matplotlib's render target. The package name can appear
// anywhere on an import line, not just first — e.g. `import numpy, matplotlib`
// or `from matplotlib import pyplot` — so match the whole (comment-stripped)
// line, not only the token right after import/from. Missing matplotlib here
// skips the render-target setup, so the figure falls back to document.body
// instead of the #graphic pane (see issue #21).
function importsMatch(code, names) {
  var re = new RegExp('(^|\\n)\\s*(import|from)\\s+[^\\n#]*\\b(' + names + ')\\b');
  return re.test(code);
}
function usesMatplotlib(code) {
  return importsMatch(code, 'matplotlib');
}

// ---------------------------------------------------------------------------
// Loading status lines (#27)
//
// "Loading Python (Pyodide)…" is written WITHOUT a newline and completed with
// "ready" once the runtime is up, so the ellipsis cannot sit above the
// program's output still reading as "loading in progress" — which is how a
// student is led to wait for something that already finished.
//
// A flag rather than a bare writeOut pair, because three call sites open this
// line (main thread, worker, VPython) and the worker's completion arrives on a
// callback that also fires for boots nobody announced. Only a line we actually
// opened gets closed, so a stray "ready" can never appear on its own.
//
// This regressed once already: a5f92de fixed it, 3890f89 (#108's worker
// runtime) reintroduced the newline form five weeks later. Keeping the pairing
// behind these two functions makes the next reintroduction visible as a
// dangling openRuntimeLine() rather than a plausible-looking writeOut.
var runtimeLineOpen = false;

function openRuntimeLine(text) {
  runtimeLineOpen = true;
  writeOut(text);
}

function closeRuntimeLine() {
  if (!runtimeLineOpen) return;
  runtimeLineOpen = false;
  writeOut('ready\n');
}

// Fraction of the output pane given to the graphic (vs. console). Default
// 65/35; updated when the user drags the separator so the split survives
// subsequent runs instead of resetting.
var graphicSplit = 0.65;

// Reveal the graphic pane (where matplotlib figures render) and split it with
// the console below, honoring any split the user dragged to.
function showGraphic() {
  var wrap = document.getElementById('graphic-wrap');
  if (!wrap) return;
  wrap.classList.remove('hide');
  $('#graphic-wrap').css('height', (graphicSplit * 100) + '%');
  $('#console-wrap').css('height', ((1 - graphicSplit) * 100) + '%');
  $('#output-dragbar').removeClass('hide');
}

// --- VPython / GlowScript bridge -------------------------------------------

var glowLoading = null;    // memoized GlowScript library load
var vpythonLoading = null; // memoized vpython package install + import
var glowScene = null;      // the GlowScript canvas/scene object

// Cooperative cancellation for VPython animation loops. Pyodide can't preempt a
// running coroutine, but VPython loops yield at rate(), so we wrap rate() to
// reject (raising in Python) when a re-run is requested mid-run — the loop
// unwinds at the next frame, then we start the fresh run. Loops with no rate()
// yield point can't be cancelled this way (they also freeze the tab anyway).
var CANCEL_MARKER = '__trinket_run_cancelled__';
var glowRate = null;          // original glow rate(), before our wrapper
var cancelRequested = false;  // set true to make the next rate()/sleep() reject
// Mirror of cancelRequested that PYTHON can see (js.window.…), used by the
// time.sleep wrapper injected as SLEEP_CANCEL_CODE.
window.__trinket_cancel_requested = false;
function setCancelRequested(v) {
  cancelRequested = v;
  window.__trinket_cancel_requested = v;
}
var rerunQueued = false;      // a Run was clicked mid-run; re-run once it stops
var runningIsVpython = false; // the in-flight run is a MAIN-THREAD VPython program (cancellable)
var runningIsWorkerVPython = false; // ...and the worker-path equivalent (restartable by terminate)
var vpythonBaselineCaptured = false; // folded vpython star-imports into the explorer baseline once

// Wrap the global rate() so it rejects when cancellation is requested. Must run
// before the vpython bridge does `from js import rate` (which binds at import
// time); idempotent, so calling it every run is fine.
function installRateCancellation() {
  if (glowRate || typeof window.rate !== 'function') return;
  glowRate = window.rate;
  window.rate = function() {
    if (cancelRequested) {
      return Promise.reject(new Error(CANCEL_MARKER));
    }
    return glowRate.apply(this, arguments);
  };
}

// Python-side cancellation at time.sleep(), the same idea as the rate() wrapper
// above (issue #108).
//
// Measured behaviour of an infinite loop in an embed:
//   while True: pass                       -> tab FROZEN
//   while True: print('.')                 -> tab FROZEN
//   while True: print('.'); time.sleep(1)  -> tab RESPONSIVE
//
// sleep() yields to the event loop; print() and a bare loop do not. So a loop
// containing a sleep leaves the UI alive — clicks are delivered, and this hook
// can raise inside the program at its next sleep, unwinding the loop while the
// student keeps whatever is in the editor.
//
// A loop with NO yield point cannot be stopped by any button: the thread never
// returns to the event loop, so the click is never delivered in the first place.
// That case needs a Worker (issue #108 stays open for it).
// NOTE the default-argument binding: the wrapper must capture the original
// sleep and the JS window AT DEFINITION TIME. An earlier version referenced them
// as globals and then deleted the temporary names, so the first sleep() raised
// NameError — breaking every program that sleeps. Bound defaults survive the del.
var SLEEP_CANCEL_CODE = [
  'import time as _t',
  'import js as _js',
  'if not getattr(_t, "_trinket_wrapped", False):',
  '    def _trinket_sleep(seconds=0, _orig=_t.sleep, _win=_js.window):',
  '        if _win.__trinket_cancel_requested:',
  '            raise KeyboardInterrupt("' + '__trinket_run_cancelled__' + '")',
  '        return _orig(seconds)',
  '    _t.sleep = _trinket_sleep',
  '    _t._trinket_wrapped = True',
  'del _t, _js'
].join('\n');

function isCancelError(err) {
  var msg = (err && (err.message || err.toString())) || '';
  return msg.indexOf(CANCEL_MARKER) >= 0;
}

// Strip the runtime's own frames out of a Python traceback before a student
// reads it (issue #107).
//
// PythonError.message is the FULL traceback, and Pyodide executes user code
// through its own machinery, so a one-line mistake arrives looking like this:
//
//   Traceback (most recent call last):
//     File "/lib/python313.zip/_pyodide/_base.py", line 597, in eval_code_async
//       await CodeRunner(
//       ...<9 lines>...
//       .run_async(globals, locals)
//     File "/lib/python313.zip/_pyodide/_base.py", line 411, in run_async
//       coroutine = eval(self.code, globals, locals)
//     File "", line 8, in
//   ValueError: invalid literal for int() with base 10: 'hi'
//
// Nine of those twelve lines are ours, they come FIRST, and the only line that
// matters is last. A beginner reads several frames of _base.py before reaching
// their own error and reasonably concludes they broke the system.
//
// Also fixes two smaller defects visible above: the user frame's filename is
// EMPTY (`File ""`), and the scope name is missing at module level, leaving a
// dangling `, in`.
// `, in <scope>` is optional, and BOTH halves of it are unreliable: at module
// level Python leaves the scope name empty, and the line arrives with its
// trailing whitespace already stripped — so the text is `, in` with nothing
// after it. Requiring a literal `, in ` (with the space) made that line fail to
// match, and an unmatched line is passed through verbatim, which is exactly the
// `File "", line 1, in` the filter is supposed to repair. Tolerate both forms.
var TRACEBACK_FRAME = /^\s*File "([^"]*)", line (\d+)(?:,\s*in\s*(.*?))?\s*$/;
// Pyodide's own frames: the stdlib zip, the _pyodide package, its asm module.
// _trinket_display and <trinket-runner> are the typeset-output runner's own
// frames (features.mathOutput). Without them a student's ValueError arrives
// with two frames of runner plumbing on top, one of which — the wrapper, which
// compiles under a filename of its own precisely so it can be matched here —
// would otherwise be renamed to main.py and report a line the student never
// wrote. That is exactly the "I broke the system" noise #107 removed.
var TRACEBACK_INTERNAL = /python\d*\.zip|[\\/]_pyodide[\\/]|pyodide\.asm|importlib\._bootstrap|_trinket_display|<trinket-runner>/;
// Names Python uses when code has no real file — all mean "the user's program".
var TRACEBACK_SYNTHETIC = /^$|^<(exec|console|string|stdin|unknown)>$/;

// escapeConsoleHtml is defined once, above, next to the other console helpers —
// #114 and #117 each introduced an identical copy, and two definitions of the
// same name in one file is a defect waiting to happen: the later declaration
// silently wins, so a future edit to the first would have no effect at all.

function formatPythonTraceback(msg, mainName) {
  if (!msg) return msg;

  // `_IncompleteInputError` is Pyodide's internal name for input that ends
  // mid-statement (`print("helo` at the prompt). CPython raises a plain
  // SyntaxError there, and the leading underscore advertises an implementation
  // detail no student should have to recognise — the same reason the frames
  // below get dropped. Rename it; the message text is already accurate.
  msg = String(msg).replace(/(^|\n)_IncompleteInputError:/g, '$1SyntaxError:');

  if (msg.indexOf('File "') === -1) return msg;

  var lines = String(msg).split('\n');
  var out = [];
  var keptFrame = false;

  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(TRACEBACK_FRAME);
    if (!m) { out.push(lines[i]); continue; }

    var file = m[1];
    if (TRACEBACK_INTERNAL.test(file)) {
      // Drop the frame AND the source lines that belong to it: everything
      // following that is indented further and isn't itself a frame header.
      while (i + 1 < lines.length
             && !TRACEBACK_FRAME.test(lines[i + 1])
             && /^\s{4,}\S/.test(lines[i + 1])) {
        i++;
      }
      continue;
    }

    keptFrame = true;
    var scope = (m[3] || '').trim();
    var name  = TRACEBACK_SYNTHETIC.test(file)
      ? (mainName || 'main.py')
      : file.replace(/^.*[\\/]/, '');          // secondary user file: basename only
    out.push('  File "' + name + '", line ' + m[2] + (scope ? ', in ' + scope : ''));
  }

  // Every frame was ours — the student has no stack to learn from, so the
  // "Traceback (most recent call last):" header is just noise above the message.
  if (!keptFrame) {
    return out.filter(function(l) {
      return l.trim() && !/^Traceback \(most recent call last\)/.test(l.trim());
    }).join('\n');
  }

  return out.join('\n');
}

// True when the program is a VPython/GlowScript program: either the classic
// first-line version header ("Web VPython 3.2" / "GlowScript 3.2 VPython") or
// an explicit vpython import.
function usesVPython(code) {
  return /^\s*(Web\s+VPython|GlowScript)\b/i.test(code)
      || /(^|\n)\s*(import\s+vpython|from\s+vpython\b)/.test(code);
}

// True when the program opts into the inline console module. Gate for applying
// the async transform on the python3 path — programs that don't import console
// take the untouched runPythonAsync path.
//
// Supported API: `import console` (including aliased `import console as c`)
// plus the attribute form `console.input(...)` — that's the only call shape
// the transform (_async_transform.py) knows how to rewrite with an `await`.
//
// Deliberately NOT gated: `from console import input`. That form binds the
// module's `async def input` directly into the caller's namespace, shadowing
// the builtin `input()`. The transform only rewrites attribute-access calls
// (`console.input(...)`), so a bare `input(...)` after `from console import
// input` would need the transform to rewrite ALL `input()` calls — which
// would also catch the unrelated builtin `input()` (window.prompt) path and
// break it. Rather than risk that, we leave this combination ungated: the
// program runs un-transformed, the bare call returns an un-awaited coroutine,
// and it fails/misbehaves at runtime same as it always would have (previously
// a clean `ModuleNotFoundError` since `console` didn't exist). This is a
// known, documented gap, not an oversight.
function usesConsole(code) {
  return /(^|\n)\s*import\s+console\b/.test(code);
}

// A trinket that ships its own console.py shadows our inline-input module:
// syncFilesToFS writes the user's file over ours on every run, so `import
// console` resolves to their module. When that happens we must NOT apply the
// async transform — their console.input may be an ordinary function, and
// `await`-ing a non-coroutine is a hard error. Skipping the transform restores
// pre-feature behavior (their console.py just runs). See the CONSOLE_MODULE_CODE
// write for the collision note.
function userShadowsConsole() {
  try {
    var files = editor.getAllFiles();
    return !!(files && Object.prototype.hasOwnProperty.call(files, 'console.py'));
  } catch (e) { return false; }
}

// Inject the GlowScript graphics library into the embed window (same realm as
// Pyodide, so the bridge's `from js import sphere, …` resolves). Memoized.
function ensureGlow() {
  if (glowLoading) return glowLoading;
  glowLoading = new Promise(function(resolve, reject) {
    if (typeof window.canvas === 'function') { resolve(); return; }
    var s = document.createElement('script');
    s.src = GLOW_SRC;
    s.onload = function() { resolve(); };
    s.onerror = function() { reject(new Error('Failed to load the GlowScript library.')); };
    document.head.appendChild(s);
  });
  return glowLoading;
}

// Build a fresh GlowScript scene inside a dedicated child of #graphic. Unlike
// the glowscript trinket — which throws away its whole iframe each run — we
// keep Pyodide and the glow library loaded (too expensive to reload) and
// instead rebuild just the scene every run: resetOutput() empties #graphic
// each run, destroying the old canvas DOM, so a memoized scene would be dead on
// re-run. Tear down the previous scene first so its render loop stops, then
// create a new canvas. GlowScript reads its container from
// window.__context.glowscript_container; canvas() does not set window.scene on
// this build, so we expose it explicitly for the bridge's `from js import scene`.
function setupGlowScene() {
  if (glowScene && typeof glowScene.remove === 'function') {
    try { glowScene.remove(); } catch (e) {}
  }
  glowScene = null;

  var graphic = document.getElementById('graphic');
  var cont = document.createElement('div');
  cont.id = 'glowscript';
  // Load-bearing: the plot-style adapter's hasFigure() excludes VPython
  // scenes with closest('.glowscript'), matching this CLASS rather than
  // either container's id -- there are two of them and an id check caught
  // only one (#251). A new scene container must carry this class or the
  // matplotlib pill will mount over it.
  cont.className = 'glowscript';
  graphic.appendChild(cont);

  window.__context = { glowscript_container: $(cont) };
  glowScene = window.canvas();
  window.scene = glowScene;
  return glowScene;
}

// Fetch + unpack the vpython package into Pyodide's FS so `import vpython`
// resolves. Memoized; assumes Pyodide is ready and GlowScript globals exist.
//
// NOTHING IS IMPORTED INTO THE USER'S NAMESPACE HERE — that is the rule, not an
// omission (Steve's ruling, 2026-08-10; docs/DEPLOY-OVERLAY-GUIDE.md known-gap 7).
// This used to run `from math import *`, `from random import *` and
// `from vpython import *` before every program usesVPython() matched, a sequence
// copied from wmWVPRunner. wmWVPRunner is a WEB VPYTHON runner, where those names
// ARE the environment (the RapydScript compiler makes `from vpython import *` the
// default). Here the trinket is a PLAIN PYTHON trinket that merely mentions
// vpython, and seeding it shadowed builtins with names the student never imported
// — propping up programs (`import vpython as vp`, then a bare `color.red`) that
// fail in desktop VPython, in a notebook and in plain Python. A python3 trinket
// now gets exactly what it imports, on both runtimes.
function ensureVpython() {
  if (vpythonLoading) return vpythonLoading;
  vpythonLoading = fetch(VPYTHON_ZIP_URL)
    .then(function(r) { return r.arrayBuffer(); })
    .then(function(buf) { pyodide.unpackArchive(buf, 'zip'); });
  return vpythonLoading;
}

var ASYNC_TRANSFORM_URL = assetUrl('/js/embed/wvpython/vpython/_async_transform.py');

// Typeset math output (features.mathOutput, surfaced as
// trinket.config.mathOutput). When off, nothing here is fetched, no Python is
// installed and every run path is byte-for-byte what it was before the
// feature — which is the point: this ships default-off.
var TRINKET_DISPLAY_URL = assetUrl('/js/embed/_trinket_display.py');

// Filename the run wrapper compiles under. Deliberately NOT <exec>, which
// formatPythonTraceback renames to the student's main file: this name is
// matched by TRACEBACK_INTERNAL instead, so the wrapper frame is dropped.
var TRINKET_RUNNER_FILENAME = '<trinket-runner>';

// Set only once the module is actually importable. The flag being on is not
// enough: if the fetch or the install failed, the module is not there, and
// running the wrapper anyway would make EVERY subsequent Run die with
// ModuleNotFoundError attributed to the student's line 1 — turning "no typeset
// output" into "your trinket is broken".
var displayHookReady = false;

function mathOutputEnabled() {
  return !!(window.trinket && window.trinket.config && window.trinket.config.mathOutput);
}

// The main-thread sink. Python hands us one JSON string per displayed object
// (see _trinket_display.install); the worker posts a `rich` message to the same
// effect. Queued through the output buffer rather than written directly, so
// ordering against print() and the line cap both hold.
window.__trinket_rich = function(json) {
  var payload;
  try {
    payload = JSON.parse(json);
  } catch (e) {
    return;
  }
  queueMathCard(payload);
};

var katexLoading = null;
var katexAnnounced = false;

// Load the vendored KaTeX bundle on first use. Memoized like ensureGlow().
//
// Lazy because most trinkets never typeset anything, and the bundle is ~300 KB
// with its fonts. The URLs come from window.__TRINKET_KATEX__, which
// pyodide.html emits through the cachePrefix filter only when the flag is on —
// so a bare /components/ path (served no-store) is never used, and with the
// flag off there is nothing to load.
function ensureKatex() {
  if (katexLoading) return katexLoading;
  var cfg = window.__TRINKET_KATEX__;
  if (!cfg || !cfg.js) {
    katexLoading = Promise.reject(new Error('KaTeX assets are not configured.'));
    // Swallow the rejection here so this memo never surfaces as an unhandled
    // rejection; every consumer already has its own .catch.
    katexLoading.catch(function() {});
    return katexLoading;
  }
  if (!katexAnnounced) {
    katexAnnounced = true;
    // A complete line, not the openRuntimeLine()/closeRuntimeLine() pair: that
    // flag has exactly one slot and a documented history of being broken by a
    // second caller. The student's first typeset expression is already waiting
    // on SymPy's ~3.3 s import, so saying so is worth a line.
    writeOut('Loading math…\n');
  }
  katexLoading = new Promise(function(resolve, reject) {
    if (window.katex) { resolve(window.katex); return; }
    if (cfg.css && !document.getElementById('trinket-katex-css')) {
      var link = document.createElement('link');
      link.id   = 'trinket-katex-css';
      link.rel  = 'stylesheet';
      link.href = cfg.css;
      document.head.appendChild(link);
    }
    var s = document.createElement('script');
    s.src = cfg.js;
    s.onload = function() {
      if (window.katex) resolve(window.katex);
      else reject(new Error('KaTeX loaded but did not define window.katex.'));
    };
    s.onerror = function() { reject(new Error('Failed to load KaTeX.')); };
    document.head.appendChild(s);
  }).catch(function(e) {
    // Don't cache a rejected load: one transient failure would otherwise mute
    // typesetting for the life of the page. Same reasoning as
    // ensureConsoleTransform().
    katexLoading = null;
    throw e;
  });
  return katexLoading;
}

var mathCardSeq = 0;

// Render one displayed result as a console card.
//
// Written immediately with the text fallback in place, then upgraded to typeset
// math when KaTeX resolves. That ordering is deliberate: the card's POSITION in
// the console is fixed the moment the program produced it, so a slow or failed
// renderer can never reorder output or lose it. If KaTeX never arrives, the
// text form — str(expr), the form that pastes back into Python — is what the
// student keeps.
//
// Nothing student-controlled is ever concatenated into this HTML: the echoed
// source and the text fallback go through escapeConsoleHtml(), and the LaTeX
// string only ever reaches katex.renderToString().
function renderMathCard(item) {
  if (!jqconsole || !item) return;
  var id = 'math-card-' + (++mathCardSeq);
  var echo = '';
  if (item.lineno || item.source) {
    echo = '<span class="math-echo">'
         + '<span class="math-ln">' + escapeConsoleHtml(item.lineno || '') + '</span>'
         + '<span class="math-src">' + escapeConsoleHtml(item.source || '') + '</span>'
         + '</span>';
  }
  var html = '<span class="math-card" id="' + id + '">'
           + echo
           + '<span class="math-body">' + escapeConsoleHtml(item.text || '') + '</span>'
           + '</span>';
  jqconsole.Write(html, 'math-card-wrap', false);

  if (!item.latex) return;
  ensureKatex().then(function(katex) {
    var card = document.getElementById(id);
    if (!card) return;                      // console was rebuilt under us
    var body = card.querySelector('.math-body');
    if (!body) return;
    var rendered;
    try {
      rendered = katex.renderToString(item.latex, {
        throwOnError: false,   // a printer quirk shows in the error colour, not as a dead run
        trust: false,          // no \href / \includegraphics from student-defined _repr_latex_
        maxExpand: 1000,       // a student macro cannot loop the expander
        displayMode: false,    // SymPy already emits \displaystyle; the card is the block
        output: 'htmlAndMathml' // the MathML is what a screen reader speaks
      });
    } catch (e) {
      return;                               // keep the text fallback
    }
    body.innerHTML = rendered;
    body.className = 'math-body math-typeset';
  }).catch(function() {
    // Degraded mode: the text fallback already on screen is the output.
  });
}

// Run the student's program with the display hook in place.
//
// `src` is what executes (already async-transformed where that applies).
// `echoSource` is what the source echo shows, which is the ORIGINAL program:
// the async transform inserts `await `/`async ` textually, and echoing that
// back would show the student a line they did not write. The transform never
// adds or removes lines, so the two agree on line numbers and the echo lands
// correctly.
//
// The hook returns its argument, so the value this resolves to is still the
// last-expression value and renderRichResult() below is unaffected.
function runProgram(src, echoSource) {
  if (!mathOutputEnabled() || !displayHookReady) return pyodide.runPythonAsync(src || '');
  pyodide.globals.set('__user_source__', src || '');
  pyodide.globals.set('__trinket_echo_source__',
    (echoSource === undefined || echoSource === null ? src : echoSource) || '');
  return pyodide.runPythonAsync([
    // __import__ rather than `import … as _d`: an import statement BINDS its
    // name in the program's globals, and _d would then be visible to dir(),
    // globals() and the REPL on every flag-on run — a difference from flag-off
    // behaviour for no reason. Looked up per run rather than cached, because
    // Clear memory restores the bootstrap globals and a name bound at first
    // load would not survive it. sys.modules does, so this is a dict hit.
    // Both sources: the echo shows what the student wrote, while any column
    // offset from the AST refers to the text actually parsed. On the console
    // path those differ, because the async transform inserts `await ` mid-line.
    "__import__('_trinket_display').set_source(__trinket_echo_source__, __user_source__)",
    // Deleted the moment set_source has consumed it, so the student's globals()
    // and dir() look the same with the flag on as off. __user_source__ stays:
    // run_program needs it, and it is pre-existing on the paths that set it
    // (runVpython, the console branch) rather than anything this feature added.
    // The _SKIP entry in VARS_HELPER/RECORD_HELPER is kept as the fallback for
    // the case where set_source raises and this del never runs.
    "del __trinket_echo_source__",
    "await __import__('_trinket_display').run_program(__user_source__, globals())"
  ].join('\n'), { filename: TRINKET_RUNNER_FILENAME });
}
var consoleTransformLoading = null;
// Fetch the pure-ast transform source and expose transform_source in a private
// module, WITHOUT importing the vpython package (heavy: glow/scene/etc.).
function ensureConsoleTransform() {
  if (consoleTransformLoading) return consoleTransformLoading;
  consoleTransformLoading = fetch(ASYNC_TRANSFORM_URL)
    .then(function(r) { return r.text(); })
    .then(function(src) {
      pyodide.FS.writeFile('_trinket_async_transform.py', src);
      return pyodide.runPythonAsync(
        'from _trinket_async_transform import transform_source');
    })
    .catch(function(e) {
      // Don't cache a rejected load. Otherwise a single transient fetch failure
      // poisons consoleTransformLoading for the life of the page, and EVERY
      // subsequent console-using run fails until reload. Clearing it lets the
      // next run retry the fetch.
      consoleTransformLoading = null;
      throw e;
    });
  return consoleTransformLoading;
}

// Run a VPython program: load glow + scene + bridge, comment out the version
// header line (keeping line numbers stable), rewrite blocking rate()/sleep()
// loops to async via the bridge's AST transformer, then execute.
//
// Deliberately NOT routed through runProgram(): typeset math output covers the
// plain run and worker paths in slice 1 only. See slice 2 in
// docs/superpowers/plans/2026-09-04-sympy-math-output.md.
function runVpython(prog) {
  // No trailing newline: completed with "ready" once the library and bridge are
  // loaded, so the ellipsis never lingers as if it were still working (#27).
  openRuntimeLine('Loading VPython (GlowScript)… ');
  return ensureGlow().then(function() {
    installRateCancellation();  // wrap rate() before the bridge imports it
    setupGlowScene();
    showGraphic();
    return ensureVpython();
  }).then(function() {
    // Library + bridge are up. Close the line BEFORE Pyodide narrates any
    // package installs below, so the two don't interleave (#27).
    closeRuntimeLine();
    // The bridge binds `scene` and `rate` to window.* at import time (once).
    // Re-point them ON THE MODULE before the user code imports anything:
    //  - scene: the canvas was rebuilt above, so target the fresh one.
    //  - rate:  bind to the cancellation-wrapped window.rate so a re-run (or
    //           Stop) can interrupt the loop.
    //
    // MODULE ATTRIBUTES ONLY — no bare `scene = …` / `rate = …` globals. Those
    // were removed with the star-imports above (known-gap 7): a python3 trinket
    // gets only what it imports. The re-pointing is unaffected, because
    // `import vpython as _vpy` binds THE module object in sys.modules — the very
    // same object a student's own `from vpython import *` then reads from, and it
    // reads at import time, i.e. after these two assignments. Both names are in
    // vpython's `__all__`, so a student who writes that import still receives the
    // WRAPPED rate and the CURRENT scene. Proven by poisoning it: setting
    // `_vpy.rate = None` makes her `rate(30)` raise TypeError, so this really is
    // the channel her namespace is filled from.
    //
    // `_vpy.scene` is load-bearing every run — setupGlowScene() destroyed the old
    // canvas, so without it a re-run draws into a dead one. `_vpy.rate` is
    // currently belt-and-braces: installRateCancellation() above wraps
    // window.rate BEFORE ensureVpython() is awaited, so core_funcs' import-time
    // `from js import rate` already captured the wrapped one, and removing this
    // line does not break Stop today (measured). Keep it anyway — it is what pins
    // the guarantee if that ordering is ever changed. Not dead code.
    return pyodide.runPythonAsync(
      'import vpython as _vpy\n' +
      'from js import scene as _js_scene\n' +
      'from js import rate as _wrapped_rate\n' +
      '_vpy.scene = _vpy.canvas(jsObj=_js_scene)\n' +
      '_vpy.rate = _wrapped_rate\n'
    );
  }).then(function() {
    // Load bundled packages the program imports (numpy, matplotlib, …).
    return pyodide.loadPackagesFromImports(prog);
  }).then(function() {
    // A VPython program can also plot. Without this, matplotlib falls back to
    // its default target and the figure floats loose in the page next to the
    // 3D scene; point its canvas backend at the graphic pane instead.
    if (usesMatplotlib(prog)) {
      window.document.pyodideMplTarget = document.getElementById('graphic');
      return pyodide.runPythonAsync(MATPLOTLIB_SETUP_CODE);
    }
  }).then(function() {
    // Everything in globals now is library/bootstrap, not the student's. Since
    // the star-imports went (known-gap 7) that is a much shorter list: the
    // `_vpy` module handle, the `_js_scene` / `_wrapped_rate` js handles, and
    // whatever `import vpython` / the matplotlib setup left behind (`matplotlib`
    // itself; MATPLOTLIB_SETUP_CODE dels its own `_plt`). Fold it into the
    // explorer baseline once so those names are hidden — but only once, so vars
    // created by earlier runs stay visible on re-runs. Still needed even though
    // the underscore trio is also in VARS_HELPER's _SKIP: _SKIP does not know
    // about the module-level names an import drags in.
    if (!vpythonBaselineCaptured) {
      try { pyodide.runPython('__trinket_baseline__ |= set(globals().keys())'); } catch (e) {}
      vpythonBaselineCaptured = true;
    }
    var lines = prog.split('\n');
    if (/^\s*(Web\s+VPython|GlowScript)\b/i.test(lines[0])) {
      lines[0] = '#' + lines[0];
    }
    pyodide.globals.set('__user_source__', lines.join('\n'));
    var asyncProg = pyodide.runPython(
      'from vpython._async_transform import transform_source\n' +
      'transform_source(__user_source__)'
    );
    return pyodide.runPythonAsync(asyncProg);
  });
}

// Jupyter-style rich display: if the value of the last top-level expression has
// a _repr_html_ (pandas DataFrame, Styler, …), render it as HTML in the graphic
// pane. `result` is whatever pyodide.runPythonAsync resolved to — a JS primitive
// for ints/strings/None, or a PyProxy for other objects.
function renderRichResult(result) {
  if (result === null || result === undefined) return;
  if (typeof result !== 'object') return; // primitives have no rich repr

  var html = null;
  try {
    if (typeof result._repr_html_ === 'function') {
      html = result._repr_html_();
    }
  } catch (e) { /* no rich repr */ }

  if (html) showRichHtml(html);

  // PyProxies must be released manually or they leak.
  if (typeof result.destroy === 'function') {
    try { result.destroy(); } catch (e) {}
  }
}

function showRichHtml(html) {
  var g = document.getElementById('graphic');
  if (!g) return;
  var style = '<style>'
    + '.pyodide-rich-output{padding:12px;overflow:auto;height:100%;'
    + 'font-family:Helvetica,Arial,sans-serif;font-size:13px;}'
    + '.pyodide-rich-output table{border-collapse:collapse;}'
    + '.pyodide-rich-output th,.pyodide-rich-output td{border:1px solid #ccc;'
    + 'padding:4px 8px;text-align:right;}'
    + '.pyodide-rich-output th{background:#f4f4f4;}'
    + '</style>';
  var box = document.createElement('div');
  box.className = 'pyodide-rich-output';
  box.innerHTML = style + html;
  g.appendChild(box);
  showGraphic();
}

// --- Variable explorer ------------------------------------------------------
//
// After each run we snapshot the user's top-level namespace and render it in a
// read-only "Variables" tab. Because Pyodide is real CPython, we introspect
// with Python itself (accurate type/repr/len) and hand back a JSON string, so
// the JS side does a single JSON.parse and never juggles PyProxy lifetimes.
//
// The helper iterates `user_ns` (a reference to the user globals passed in via
// a throwaway namespace) rather than globals(), so it injects nothing — not
// even `json`/`types` — into the user's own namespace. It also filters dunders,
// imported modules, and the non-user names the runner injects (__user_source__,
// _plt, _vpy, _js_scene, _wrapped_rate).
var VARS_HELPER = [
  'import json, types',
  // KEEP IN SYNC with RECORD_HELPER's _SKIP + _snap_ns filters (the step
  // debugger's per-step snapshots): a runner-injected name added here but not
  // there makes the debugger show internals the explorer hides, or vice versa.
  "_SKIP = {'__user_source__', '__trinket_echo_source__', '_plt', '_vpy', '_js_scene', '_wrapped_rate', 'transform_source'}",
  "_baseline = user_ns.get('__trinket_baseline__') or set()",
  '_out = []',
  'for _name, _val in list(user_ns.items()):',
  '    if _name in _SKIP: continue',
  '    if _name in _baseline: continue',
  "    if _name.startswith('__') and _name.endswith('__'): continue",
  '    if isinstance(_val, types.ModuleType): continue',
  "    _kind = 'value'",
  '    if isinstance(_val, (types.FunctionType, types.BuiltinFunctionType, types.LambdaType)):',
  "        _kind = 'function'",
  '    elif isinstance(_val, type):',
  "        _kind = 'class'",
  '    try:',
  '        _r = repr(_val)',
  '    except Exception as _e:',
  "        _r = '<unrepresentable: %r>' % (_e,)",
  "    if len(_r) > 300: _r = _r[:300] + '...'",
  '    try:',
  '        _n = len(_val)',
  '    except Exception:',
  '        _n = None',
  // Phase 3: flag whether the row can be drilled into (a container, or an object
  // with a non-empty instance __dict__). Only value-kind rows are expandable.
  '    _exp = False',
  "    if _kind == 'value':",
  '        if isinstance(_val, (dict, list, tuple, set, frozenset, range)):',
  '            _exp = True',
  '        else:',
  '            try:',
  '                _d = vars(_val)',
  '                _exp = isinstance(_d, dict) and len(_d) > 0',
  '            except TypeError:',
  '                _exp = False',
  "    _out.append({'name': _name, 'type': type(_val).__name__, 'kind': _kind, 'repr': _r, 'len': _n, 'expandable': _exp})",
  "_out.sort(key=lambda d: (d['kind'] != 'value', d['name']))",
  'json.dumps(_out)'
].join('\n');

// Phase 3 — lazily fetch ONE level of children for the node reached by walking
// `_path` (a list of positional child-indices) from top-level var `_root_name`
// in the live user globals. Positional navigation (i-th child) handles arbitrary
// dict keys and set members without serializing them. Returns first _MAX children
// plus the true total, each child's repr/type/len, whether it is itself
// expandable, and whether it is a cycle back to an ancestor (so the UI can stop).
var EXPAND_HELPER = [
  'import json, itertools',
  // Navigation step: return (found, i-th child value) WITHOUT building labels.
  // Sequences index in O(1); dict/set/attrs do a single unlabeled pass. repr is
  // deliberately absent here — labeling every key of every ancestor container
  // on each expand made a click O(path_len x container_size) repr calls, a
  // visible freeze on e.g. 100k-key dicts. Iteration order matches
  // _child_pairs below (same unmutated object), so indices stay consistent.
  'def _child_at(_obj, _i):',
  '    if _i < 0:',
  '        return False, None',
  '    if isinstance(_obj, (list, tuple, range)):',
  '        if _i < len(_obj):',
  '            return True, _obj[_i]',
  '        return False, None',
  '    if isinstance(_obj, dict):',
  '        _it = _obj.values()',
  '    elif isinstance(_obj, (set, frozenset)):',
  '        _it = _obj',
  '    else:',
  '        try:',
  '            _d = vars(_obj)',
  '        except TypeError:',
  '            return False, None',
  '        if not isinstance(_d, dict):',
  '            return False, None',
  '        _it = _d.values()',
  '    try:',
  '        for _j, _v in enumerate(_it):',
  '            if _j == _i:',
  '                return True, _v',
  '    except Exception:',
  '        pass',
  '    return False, None',
  // Labeled children for the FINAL node only: (total, first _max pairs).
  // islice caps the labeling work — a 100k-key dict reprs only _max keys.
  'def _child_pairs(_obj, _max):',
  '    if isinstance(_obj, dict):',
  '        _out = []',
  '        try:',
  '            for _k, _v in itertools.islice(_obj.items(), _max):',
  '                try:',
  '                    _lab = repr(_k)',
  '                except Exception:',
  "                    _lab = '<key>'",
  '                _out.append((_lab, _v))',
  '        except Exception:',
  '            return 0, []',
  '        return len(_obj), _out',
  '    if isinstance(_obj, (list, tuple, range)):',
  "        return len(_obj), [('[%d]' % _i, _obj[_i]) for _i in range(min(len(_obj), _max))]",
  '    if isinstance(_obj, (set, frozenset)):',
  "        return len(_obj), [('{%d}' % _i, _v) for _i, _v in enumerate(itertools.islice(_obj, _max))]",
  '    try:',
  '        _d = vars(_obj)',
  '    except TypeError:',
  '        return 0, []',
  '    if isinstance(_d, dict):',
  '        return len(_d), list(itertools.islice(_d.items(), _max))',
  '    return 0, []',
  'def _is_container(_obj):',
  '    if isinstance(_obj, (dict, list, tuple, set, frozenset, range)):',
  '        return True',
  '    try:',
  '        _d = vars(_obj)',
  '        return isinstance(_d, dict) and len(_d) > 0',
  '    except TypeError:',
  '        return False',
  '_node = user_ns.get(_root_name)',
  '_ok = _root_name in user_ns',
  '_anc = [id(_node)]',
  'for _i in _path:',
  '    _found, _node = _child_at(_node, _i)',
  '    if not _found:',
  '        _ok = False',
  '        break',
  '    _anc.append(id(_node))',
  'if not _ok:',
  "    _result = {'ok': False, 'total': 0, 'children': []}",
  'else:',
  '    _total, _pairs = _child_pairs(_node, _MAX)',
  '    _out = []',
  '    for _label, _v in _pairs:',
  '        try:',
  '            _r = repr(_v)',
  '        except Exception as _e:',
  "            _r = '<unrepresentable: %r>' % (_e,)",
  "        if len(_r) > 300: _r = _r[:300] + '...'",
  '        try:',
  '            _n = len(_v)',
  '        except Exception:',
  '            _n = None',
  '        _cyc = id(_v) in _anc',
  '        _out.append({',
  "            'label': _label,",
  "            'type': type(_v).__name__,",
  "            'repr': _r,",
  "            'len': _n,",
  "            'expandable': (not _cyc) and _is_container(_v),",
  "            'cyclic': _cyc,",
  '        })',
  "    _result = {'ok': True, 'total': _total, 'children': _out}",
  'json.dumps(_result)'
].join('\n');

// True when the Variables explorer is enabled via config
// (features.variableExplorer, surfaced on the client as
// trinket.config.variableExplorer). When off, the template omits the tab/panel,
// and we skip the per-run snapshot and the tab wiring entirely.
function variableExplorerEnabled() {
  return !!(window.trinket && window.trinket.config && window.trinket.config.variableExplorer);
}

function snapshotVariables() {
  if (!pyodide || !pyodideReady) return [];
  var ns = null;
  try {
    // user_ns is a live reference to the user globals; nothing is written back.
    ns = pyodide.toPy({ user_ns: pyodide.globals });
    var json = pyodide.runPython(VARS_HELPER, { globals: ns });
    return JSON.parse(json);
  } catch (e) {
    return [];
  } finally {
    if (ns && typeof ns.destroy === 'function') {
      try { ns.destroy(); } catch (e) {}
    }
  }
}

// Phase 3 guards. MAX_CHILDREN caps how many children we serialize/render per
// node (the rest are summarized as "… N more"); MAX_DEPTH caps how deep the tree
// can be expanded so pathological structures can't be walked forever.
var MAX_CHILDREN = 200;
var MAX_DEPTH = 12;

// Fetch one level of children for the node at `path` under top-level var `root`.
// Returns { ok, total, children:[{label,type,repr,len,expandable,cyclic}] } or
// null on failure. Navigates the live globals fresh each call, so it always
// reflects current state.
function expandNode(root, path) {
  if (!pyodide || !pyodideReady) return null;
  var ns = null;
  try {
    ns = pyodide.toPy({
      user_ns: pyodide.globals,
      _root_name: root,
      _path: path || [],
      _MAX: MAX_CHILDREN
    });
    var json = pyodide.runPython(EXPAND_HELPER, { globals: ns });
    return JSON.parse(json);
  } catch (e) {
    return null;
  } finally {
    if (ns && typeof ns.destroy === 'function') {
      try { ns.destroy(); } catch (e) {}
    }
  }
}

// --- Step-through debugger (record & replay) --------------------------------
//
// Design: docs/design/pyodide-debugger-mvp.md. Clicking "Step through" re-runs the
// program under a sys.settrace recorder that captures, per user-code line
// event: line number, function, call depth, a compact variable snapshot of the
// executing frame, and the stdout offset. Replay then steps forward/backward
// through the recording. Requires features.stepDebugger (and the explorer,
// whose tab/table it reuses).

function stepDebuggerEnabled() {
  return variableExplorerEnabled()
    && !!(window.trinket && window.trinket.config && window.trinket.config.stepDebugger);
}

// The floating panel (public/js/plugins/debug-panel.js) is a view over the
// state below and owns none of it. Requires stepDebugger, because it drives
// that debugger's own functions.
function debugPanelEnabled() {
  return stepDebuggerEnabled()
    && !!(window.trinket && window.trinket.config && window.trinket.config.debugPanel);
}

// Tell the panel the debugger's state moved. Called from every place that
// already repaints the in-tab controls, so the two views cannot disagree.
// A no-op when the flag is off, and guarded so a panel bug can never break
// stepping -- the in-tab controls stay authoritative.
function debugPanelSync() {
  if (!window.trinketDebugPanel) return;
  try { trinketDebugPanel.sync(); } catch (e) {}
}

// Recorder caps (see the MVP doc). The step/size caps abort the traced exec
// from INSIDE the tracer — that's what bounds `while True:` on the main
// thread, where JS cannot interrupt synchronous Python.
var DEBUG_MAX_STEPS = 5000;
var DEBUG_MAX_VARS = 50;
var DEBUG_MAX_REPR = 120;
var DEBUG_MAX_DEPTH = 20;
var DEBUG_MAX_BYTES = 2 * 1024 * 1024;
// Output shares DEBUG_MAX_BYTES with steps and snapshots rather than getting a
// second full allowance. This is the floor it keeps even when they spent the
// lot: a program whose recording filled the budget should still show what it
// printed, because that is the half the student can read.
var DEBUG_MIN_OUTPUT_BYTES = 64 * 1024;
// OPT-IN deferred recording (see debugRunDeferred). Only reachable from the
// button the panel offers after a recording truncated before reaching the
// student's breakpoint -- never automatic, which is the whole difference from
// the version deleted in 21488d9.
//
// DEBUG_MAX_DORMANT bounds the coast: without it a `while True:` ABOVE the
// breakpoint spins forever, because nothing accumulates in _steps to trip the
// step cap. Restored at its original value.
var DEBUG_MAX_DORMANT = 200000;
// How many steps before the breakpoint the coast keeps, so replay opens with
// context rather than cold on the marked line. A ring buffer, so the cost is
// bounded no matter how long the coast is; fewer than this simply keeps what
// exists. 100 is ~14 turns of a six-line loop body -- enough to see the
// rhythm and the variable trend leading in.
var DEBUG_LOOKBACK_STEPS = 100;

// The user program is compiled with filename '<debug>' and exec'd in a fresh
// namespace: user frames are exactly the '<debug>' frames (functions defined in
// the main file included), library/site-packages frames are never traced, and
// the real pyodide.globals namespace is untouched. stdout/stderr are captured
// into a buffer so replay can reveal output step-by-step. A synthetic '<end>'
// step (full output, final globals) is appended so students can step past the
// last line to the terminal state.
var RECORD_HELPER = [
  'import sys, json, types, io, traceback, reprlib, collections',
  // KEEP IN SYNC with VARS_HELPER's _SKIP + filters (the live explorer): both
  // must hide the same runner-injected names. They live in separate helper
  // strings/namespaces, so a shared definition would add more machinery than
  // it removes — this cross-reference is the guard.
  "_SKIP = {'__user_source__', '__trinket_echo_source__', '_plt', '_vpy', '_js_scene', '_wrapped_rate', 'transform_source'}",
  // BaseException, not Exception, and this is the guard that bounds a runaway
  // program. A trace function's exception propagates into the frame being
  // traced, so it meets that frame's own handlers -- and `try: ... except
  // Exception:` inside a student's loop SWALLOWED the cap abort. Verified in a
  // real interpreter: tracing then dies and the loop runs on untraced, so a
  // `while True:` hangs the tab with no recording and nothing JS can interrupt,
  // while _buf keeps growing with both size counters frozen. The `except
  // _TrinketStopRecording` clause below still precedes `except BaseException`,
  // so nothing else changes. A bare `except:` still swallows it; there is no
  // defence against that and it is much rarer student code.
  'class _TrinketStopRecording(BaseException): pass',
  '_steps = []',
  '_snaps = []',
  // Encoded cost, split in two because they are budgeted differently.
  // _nsize is what the RECORDING (steps + snaps) will occupy once
  // json.dumps has escaped it; _osize is stdout/stderr growth. Keeping them
  // apart is what stops the output allowance below from subtracting output
  // from its own budget -- the double-subtract in #274, which cost a
  // mid-program print 60% of its bytes while a final-line print kept 100%.
  // Seeded with the envelope -- the payload's own keys and braces, which are
  // emitted whatever the program does. Measured: the empty payload
  // `{"error": null, ... "steps": [], "snaps": []}` encodes to 135 bytes, and
  // every varying field in it (_err, the flags, the two arrays) is charged
  // separately below. Without this the bound is short by the wrapper, which is
  // the difference between a bound and an estimate -- the complaint in #274.
  '_nsize = [135]',
  '_osize = [0]',
  // Charged as `len(json.dumps(x)) + 2` -- the encoded object plus its
  // separator in the enclosing array. TWO, not one: json.dumps defaults to
  // `', '` WITH the space, so for N elements the array is
  // 2 + sum(len(dumps(e))) + 2*(N-1) and charging len(dumps(e)) + 2 per
  // element accounts for it exactly, brackets included. Charging +1 leaves the
  // bound ~0.1% short, which is enough to exceed the cap -- verified, and it
  // is the mistake that made this the fourth wrong version of this bound.
  // The constants this replaces (+24 per variable, +40 per step) under-counted
  // far worse: an empty variable entry encodes to 36 bytes, an empty step dict
  // to 100.
  'def _cost(_x):',
  '    try:',
  '        return len(json.dumps(_x)) + 2',
  '    except Exception:',
  '        return 2',
  '_truncated = [False]',
  // Deferred-recording state. _ring holds up to _lookback (step, snap, cost)
  // triples while coasting; _coasted counts every coasted line event; _kept
  // and _skipped are what the ring retained and dropped when the breakpoint
  // finally fired, so the UI can say both numbers honestly.
  '_ring = collections.deque()',
  '_coasted = [0]',
  '_kept = [0]',
  '_skipped = [0]',
  '_buf = io.StringIO()',
  '_last_out = [0]',
  // Names a library put in the namespace, tracked as execution goes so that
  // _snap_ns can drop them BEFORE the per-step cap applies. That ordering is
  // the whole point: _ns.items() runs in insertion order and _snap_ns stops at
  // _max_vars, so `from sympy import *` fills all fifty slots with sympy
  // before the student's own two variables are ever reached -- filtering
  // afterwards, in JS, then leaves nothing at all.
  //
  // A `line` event fires BEFORE its line runs, so anything that appeared since
  // the last event was bound by the PREVIOUS line. If that line was an import,
  // the new names are library furniture. No blocklist, and it covers
  // `import x`, `from x import y` and `from x import *` alike.
  '_src_lines = _user_source.split(chr(10))',
  // name -> id() of the object the import bound. A bare SET of names hid any
  // later variable that reused the name: `from math import pi` then `pi = 3.14`
  // at top level, or a function-local `e = sum(data)` after `from math import
  // *`, vanished from the panel entirely. Identity distinguishes the imported
  // object from a rebinding; the depth gate below covers the rest.
  '_imported = {}',
  '_seen = set()',
  '_prev_line = [0]',
  '_ns_len = [-1]',
  'def _is_import_line(_n):',
  '    if _n <= 0 or _n > len(_src_lines): return False',
  '    _t = _src_lines[_n - 1].lstrip()',
  "    if _t.startswith('import '): return True",
  "    return _t.startswith('from ') and ' import' in _t",
  'def _note_new(_ns):',
  '    if len(_ns) == _ns_len[0]: return',
  '    _ns_len[0] = len(_ns)',
  '    _new = set(_ns.keys()) - _seen',
  '    if _new:',
  '        if _is_import_line(_prev_line[0]):',
  '            for _n in _new: _imported[_n] = id(_ns[_n])',
  '        _seen.update(_new)',
  // A PRECONFIGURED reprlib.Repr for the containers it specialises, and the
  // builtin repr() for everything else. This is the single biggest cost in the
  // recorder, because it runs for every variable on every line event.
  //
  // builtins.repr() builds the ENTIRE string and the clamp below then throws
  // all but 120 characters away -- so a list the student appends to in a loop
  // costs more on every iteration and per-event cost climbs without bound.
  // reprlib recurses into at most maxlist elements, so cost is FLAT. Measured
  // in this embed on one list:
  //        500 elements   builtin  175 us   reprlib  43 us
  //      5 000 elements   builtin 1375 us   reprlib  35 us
  //     20 000 elements   builtin 4305 us   reprlib  24 us
  // and 14x end to end over 2000 appends of a growing list.
  //
  // maxlist 30 is chosen so nothing that used to fit in 120 characters stops
  // fitting: ~30 short ints is the most that ever did. Verified against the
  // old output on a 30-tuple, a 25-int list, 12 floats and a string list --
  // byte-identical. Where it does differ it is BETTER: it closes the bracket
  // instead of cutting a float in half, and it keeps a string's closing quote.
  //
  // GATED ON TYPE, and that matters. reprlib's repr_instance fallback calls
  // builtins.repr() anyway, so it buys no speed off the container types -- and
  // it elides the MIDDLE of the result, which mangles a repr that already
  // summarises itself. numpy is the case: it self-summarises above
  // threshold=1000, so it was never the expensive one, and routing it through
  // reprlib turned a clean array([...]) into 'array([0.0, 2.0e-04, ......e-01'
  // and cut across its row breaks. With the gate, numpy output is unchanged.
  // EXACT TYPE, not isinstance, and no dict. Two separate corrections.
  //
  // isinstance let SUBCLASSES through, but reprlib.repr1 dispatches on
  // type(x).__name__ -- so a namedtuple ('State') or a defaultdict found no
  // repr_State/repr_defaultdict and landed in repr_instance, which builds the
  // whole repr anyway and then elides its MIDDLE. That is the same mid-token
  // cut across a value's own structure that numpy is gated out to avoid, with
  // none of the speed. `State = namedtuple('State', 'x y vx vy')` is ordinary
  // code in this audience. type() in (...) sends every subclass back to plain
  // repr() plus the head clamp, i.e. byte-identical to before.
  //
  // dict is out because reprlib.repr_dict SORTS the keys before slicing them,
  // so display order flipped from insertion to alphabetical AND the survivors
  // were the alphabetically-first maxdict rather than the first the student
  // wrote. print() and the live variable explorer both still use plain repr,
  // so the same dict would have read one way in the Variables tab and another
  // while stepping. Dicts were never the case this was chasing either -- that
  // was the bare accumulator list. (A dict NESTED inside a gated list still
  // takes repr_dict via recursion; at that depth the 120-char clamp was
  // already cutting it, so the difference is marginal.)
  "_RL_TYPES = (list, tuple, set, frozenset, str)",
  '_rl = reprlib.Repr()',
  '_rl.maxlevel = 4',
  '_rl.maxlist = _rl.maxtuple = _rl.maxset = _rl.maxfrozenset = _rl.maxdeque = 30',
  '_rl.maxstring = _max_repr',
  '_rl.maxother = _max_repr',
  // `_top` is whether this namespace IS the module frame. _imported is built
  // from module-level import lines only, so applying it to a function's
  // f_locals hid any local sharing a name with an import -- and identity
  // alone would not catch `def f(): pi = math.pi`, where the local is bound
  // to the very object the import named.
  'def _snap_ns(_ns, _top=True):',
  '    _out = []',
  '    for _name, _val in list(_ns.items()):',
  '        if _name in _SKIP: continue',
  '        if _top and _imported.get(_name, -1) == id(_val): continue',
  "        if _name.startswith('__') and _name.endswith('__'): continue",
  '        if isinstance(_val, types.ModuleType): continue',
  '        if isinstance(_val, (types.FunctionType, types.BuiltinFunctionType, types.LambdaType)): continue',
  '        if isinstance(_val, type): continue',
  '        try:',
  '            _r = _rl.repr(_val) if type(_val) in _RL_TYPES else repr(_val)',
  '        except Exception:',
  "            _r = '<unrepresentable>'",
  "        if len(_r) > _max_repr: _r = _r[:_max_repr] + '...'",
  // The type name was written into every entry, charged nothing, and left
  // unclamped -- a class with a pathological __name__ was unbounded. Same
  // clamp as the repr.
  '        _tn = type(_val).__name__',
  '        if len(_tn) > _max_repr: _tn = _tn[:_max_repr] + \'...\'',
  "        _out.append({'name': _name, 'type': _tn, 'repr': _r})",
  '        if len(_out) >= _max_vars: break',
  '    return _out',
  // Phase 2: trace the main file AND user modules imported from the Pyodide FS
  // (relative names or paths under _user_prefix) — never library frames.
  'def _is_user(_fname):',
  "    if _fname == '<debug>': return True",
  "    if not _fname.endswith('.py'): return False",
  "    return _fname.startswith(_user_prefix) or not _fname.startswith('/')",
  // Display label: None for the main file, basename for user modules.
  'def _file_label(_fname):',
  "    if _fname == '<debug>': return None",
  "    return _fname.rsplit('/', 1)[-1]",
  'def _depth_of(_frame):',
  '    _d = 0',
  '    _f = _frame.f_back',
  '    while _f is not None:',
  '        if _is_user(_f.f_code.co_filename): _d += 1',
  '        _f = _f.f_back',
  '    return _d',
  // Nearest user frame above: the call site shown as "called from line N".
  'def _call_site(_frame):',
  '    _f = _frame.f_back',
  '    while _f is not None:',
  '        if _is_user(_f.f_code.co_filename):',
  '            return _f.f_lineno, _file_label(_f.f_code.co_filename)',
  '        _f = _f.f_back',
  '    return None, None',
  // Breakpoints do NOT gate recording. They used to: with any breakpoint set
  // the tracer stayed dormant -- no snapshots at all -- until execution first
  // touched a breakpoint line, so the steps before it did not exist and the
  // replay opened AT the breakpoint. That is the opposite of what a breakpoint
  // means everywhere else, and it also made a whole class of failure: an
  // orphaned breakpoint (a file renamed or deleted, or a dot on a line that
  // never runs) could never be hit, so every recording for the rest of the
  // page session came back empty. The recording now always starts at the
  // program's first line and _bp_set only reports whether a breakpoint was
  // ever reached; auto mode is what stops there.
  //
  // The one deleted `return _tracer` in the old else-arm WAS the whole bug.
  //
  // Losing the dormant cap loses no protection: it bounded a hazard the
  // dormant branch itself created (a loop spinning while no steps accumulate,
  // so the step cap could never trip). With every line event recorded, the
  // cap check below is reached from the first event of every run, and
  // the bound is strictly tighter than before -- 5000 steps or 2 MB, rather
  // than 200,000 dormant events PLUS 5000 recorded ones.
  '_bp_set = set()',
  'for _k in _bp:',
  '    for _l in _bp[_k]:',
  '        _bp_set.add((_k, _l))',
  // "has a breakpoint line actually executed", not "has recording started".
  // The initializer is already right for that meaning: True (nothing to
  // report) when no breakpoints are set, False until one is hit when there are.
  '_hit = [not _bp_set]',
  'def _tracer(_frame, _event, _arg):',
  '    if not _is_user(_frame.f_code.co_filename):',
  '        return None',
  "    if _event == 'call':",
  '        if _depth_of(_frame) >= _max_depth: return None',
  '        return _tracer',
  "    if _event != 'line':",
  '        return _tracer',
  // The byte cap must bound the WHOLE payload, not just snapshot reprs: count
  // stdout growth since the last event (a single huge print would otherwise
  // sail past the cap into a multi-MB JSON). Unconditional: every line event
  // is recorded now, so every byte of stdout lands in the accounting.
  // Raw character growth, not encoded: json.dumps on the whole buffer at
  // every line event would be O(n^2) in the hot path. This is a tripwire for
  // runaway output, and the exact encoded bound is enforced by the clamp at
  // the end, which does measure json.dumps.
  '    _osize[0] += _buf.tell() - _last_out[0]',
  '    _last_out[0] = _buf.tell()',
  // Import attribution and the depth are needed by BOTH paths below, so they
  // run before either. _note_new only updates _seen/_imported, so running it
  // once more on an event that then aborts is harmless.
  '    _d = _depth_of(_frame)',
  '    if _d == 0:',
  '        _note_new(_frame.f_locals)',
  // Has a marked line executed yet? On the event where it first does, the
  // deferred run ARMS: the lookback window is flushed into the recording and
  // this same event then falls through and is recorded normally. So replay
  // opens _lookback steps BEFORE the marked line, not on it.
  '    if not _hit[0]:',
  "        _lbl = _file_label(_frame.f_code.co_filename) or '<main>'",
  '        if (_lbl, _frame.f_lineno) in _bp_set:',
  '            _hit[0] = True',
  '            _kept[0] = len(_ring)',
  '            _skipped[0] = _coasted[0] - _kept[0]',
  '            while _ring:',
  '                _e = _ring.popleft()',
  '                _steps.append(_e[0])',
  '                _snaps.append(_e[1])',
  // THE COAST. Only ever entered when the student asked for it by pressing
  // the panel's "record from the breakpoint instead" button; _defer is false
  // for every ordinary recording, so this whole branch is dead weight on the
  // normal path (one boolean test).
  //
  // The window is a ring, so the work is bounded: build the step and its
  // snapshot as usual, then drop the oldest once the window is full. The byte
  // cap MUST be credited back on eviction -- charge without crediting and a
  // long coast trips the 2 MB cap before the breakpoint ever fires, which is
  // precisely the failure this feature exists to prevent. _cost is exactly
  // what this step added to _size, and stdout growth is charged above _pre so
  // it is never credited back: the output is kept whole either way.
  '    if _defer and not _hit[0]:',
  '        _fl, _ff = _call_site(_frame) if _d > 0 else (None, None)',
  "        _st = {'line': _frame.f_lineno, 'func': _frame.f_code.co_name, 'depth': _d, 'out': _buf.tell(), 'file': _file_label(_frame.f_code.co_filename), 'from_line': _fl, 'from_file': _ff}",
  '        _sn = _snap_ns(_frame.f_locals, _d == 0)',
  '        _c = _cost(_st) + _cost(_sn)',
  '        _nsize[0] += _c',
  '        _ring.append((_st, _sn, _c))',
  '        while len(_ring) > _lookback:',
  '            _nsize[0] -= _ring.popleft()[2]',
  '        _coasted[0] += 1',
  '        _prev_line[0] = _frame.f_lineno if _d == 0 else _prev_line[0]',
  // Give up rather than coast forever. Reaching either bound leaves _hit
  // false, which the host reports as "that line never ran".
  '        if _coasted[0] > _max_dormant or _nsize[0] + _osize[0] > _max_bytes:',
  '            _truncated[0] = True',
  '            raise _TrinketStopRecording()',
  '        return _tracer',
  // Build the step and its snapshot BEFORE the cap check, so the charge is
  // what this step actually encodes to -- and so the step that trips the cap
  // is not appended. Charging a flat estimate first and appending afterwards
  // is how the bound drifted from the payload.
  '    if len(_steps) >= _max_steps:',
  '        _truncated[0] = True',
  '        raise _TrinketStopRecording()',
  '    _fl, _ff = _call_site(_frame) if _d > 0 else (None, None)',
  "    _st = {'line': _frame.f_lineno, 'func': _frame.f_code.co_name, 'depth': _d, 'out': _buf.tell(), 'file': _file_label(_frame.f_code.co_filename), 'from_line': _fl, 'from_file': _ff}",
  '    _sn = _snap_ns(_frame.f_locals, _d == 0)',
  '    _nsize[0] += _cost(_st) + _cost(_sn)',
  '    if _nsize[0] + _osize[0] > _max_bytes:',
  '        _truncated[0] = True',
  '        raise _TrinketStopRecording()',
  '    _steps.append(_st)',
  '    _snaps.append(_sn)',
  '    _prev_line[0] = _frame.f_lineno if _d == 0 else _prev_line[0]',
  '    return _tracer',
  "_g = {'__name__': '__main__'}",
  '_err = None',
  '_old_out, _old_err = sys.stdout, sys.stderr',
  'sys.stdout = _buf',
  'sys.stderr = _buf',
  'try:',
  "    _code = compile(_user_source, '<debug>', 'exec')",
  '    sys.settrace(_tracer)',
  '    try:',
  '        exec(_code, _g)',
  '    finally:',
  '        sys.settrace(None)',
  'except _TrinketStopRecording:',
  '    pass',
  'except BaseException as _e:',
  "    _err = ''.join(traceback.format_exception_only(type(_e), _e)).strip()",
  // format_exception_only embeds the exception's full str(), and NOTHING
  // charges _err against the byte estimate -- so the cap cannot engage at all
  // here. `xs = list(range(300000)); assert len(xs) == 0, xs` measured a
  // 2.18 MiB payload from THREE recorded steps, essentially all of it this
  // string; `float('x' * 3_000_000)` measured 2.86 MiB. Both are things a
  // student writes to "see" their data. 2000 characters is generous even in
  // CJK, where it is still only ~12 KB encoded.
  '    if len(_err) > 2000:',
  "        _err = _err[:2000] + ' ... (error message truncated)'",
  // Charged for the same reason as the envelope: it is in the payload. The
  // clamp above bounds it to 2000 chars, but escaping can take that past 2 KB.
  '    _nsize[0] += _cost(_err)',
  'finally:',
  '    sys.stdout, sys.stderr = _old_out, _old_err',
  // The synthetic <end> step and the final globals snapshot go into the
  // payload like any other, so they are charged like any other -- otherwise
  // the output allowance below is computed against a _nsize that is short by
  // a whole snapshot, which on a 50-variable program is not a rounding error.
  // Unconditional, unlike the steps above: students can always step to the end.
  "_end_st = {'line': None, 'func': '<end>', 'depth': 0, 'out': _buf.tell(), 'file': None, 'from_line': None, 'from_file': None}",
  '_steps.append(_end_st)',
  '_note_new(_g)',
  '_end_sn = _snap_ns(_g)',
  '_snaps.append(_end_sn)',
  '_nsize[0] += _cost(_end_st) + _cost(_end_sn)',
  // The tracer stops AT the cap, then <end> is appended on top of it -- so on
  // a program that filled the budget the recording lands slightly over. Drop
  // steps from just before <end> until it fits. Off the hot path: this runs
  // once, and only when the cap actually engaged. <end> and the first step are
  // never dropped, so a student can always reach both ends of the recording.
  'while _nsize[0] > _max_bytes and len(_steps) > 2:',
  '    _nsize[0] -= _cost(_steps.pop(-2)) + _cost(_snaps.pop(-2))',
  '    _truncated[0] = True',
  // The per-event accounting above charges stdout GROWTH at the next line
  // event, which bounds a print in the middle of a program but not the last
  // one -- there is no next event to charge it at -- and does not shrink _buf
  // after a cap abort either. So `print('x' * 10_000_000)` on the final line
  // reached json.dumps in full. Truncate here, where the payload is actually
  // built. The marker is left in the text on purpose: it lands in the console
  // the student reads, which is the only place the loss is visible.
  //
  // Two things that clamp got wrong, and both let a multi-megabyte payload
  // through even though the cap "held":
  //
  //  1. It measured CHARACTERS, and json.dumps escapes. Measured ratios for
  //     the encoded form: a quote or a newline 2x, an accented letter 6x, and
  //     a non-BMP emoji 12x -- one Python character becomes a \uXXXX surrogate
  //     PAIR. So 2 Mi characters of emoji serialize to about 24 MiB. A
  //     character count is not a byte bound.
  //  2. It gave output the WHOLE 2 MB even when steps and snapshots had
  //     already spent most of it, so the real ceiling was ~4 MB of payload
  //     before escaping, not the 2 MB the cap advertises.
  //
  // So budget against what is LEFT, and bound the ENCODED length. The floor
  // keeps a program that filled the budget with steps from losing its output
  // entirely -- the output is the half the student can actually read.
  '_out = _buf.getvalue()',
  // _nsize only -- NOT the output, which used to be inside the same counter
  // and so was subtracted from its own allowance (#274). The <end> step and
  // final snapshot appended just above are charged too, so the allowance is
  // what is genuinely left after the whole recording.
  '_left = _max_bytes - _nsize[0]',
  'if _left < _min_out:',
  '    _left = _min_out',
  '_cut = len(_out) > _left',
  'if _cut:',
  '    _out = _out[:_left]',
  // Geometric, so it terminates: at most ~12 halvings from a 2 MB buffer, and
  // the loop body does not run at all for output that does not escape.
  "while len(_out) > 512 and len(json.dumps(_out)) - 2 > _left:",
  '    _out = _out[:len(_out) // 2]',
  '    _cut = True',
  // _truncated[0] is deliberately NOT set: it drives the copy about the
  // RECORDING being cut short, which is a different claim from the program
  // having printed more than we can store. The marker in the text is the
  // report, and it lands in the console the student is already reading.
  'if _cut:',
  "    _out = _out + '\\n... output truncated: the program printed more than the debugger can store ...\\n'",
  "json.dumps({'error': _err, 'truncated': _truncated[0], 'bpHit': _hit[0], 'deferred': bool(_defer), 'kept': _kept[0], 'skipped': _skipped[0], 'output': _out, 'steps': _steps, 'snaps': _snaps})"
].join('\n');

var debugRec = null;       // active recording ({error, truncated, output, steps, snaps}) or null
var debugIdx = 0;          // current step index into debugRec.steps
var debugRecording = false;
var debugCancelled = false;
var debugDeferring = false;  // this recording was asked to start at a breakpoint
var debugMarkerId = null;      // ace marker id for the current-line highlight
var debugMarkerSession = null; // ace session the marker was added to

// Highlight the replay's current line in the (active) Ace editor with our own
// marker class — deliberately NOT editor.highlight(), which applies the red
// error styling and flags the file tab with an error icon.
function debugHighlightLine(line) {
  if (debugMarkerSession && debugMarkerId != null) {
    try { debugMarkerSession.removeMarker(debugMarkerId); } catch (e) {}
    debugMarkerId = null;
    debugMarkerSession = null;
  }
  if (line == null) return;
  try {
    var aceEd = editor && editor._editor && editor._editor.aceInstance;
    if (!aceEd || !window.ace) return; // e.g. plain-textarea mode: step without highlight
    var session = aceEd.getSession();
    var Range = window.ace.require('ace/range').Range;
    var lineText = session.getLine(line - 1) || '';
    debugMarkerId = session.addMarker(
      new Range(line - 1, 0, line - 1, Math.max(lineText.length, 1)),
      'debug-current-line', 'fullLine');
    debugMarkerSession = session;
    aceEd.scrollToLine(line - 1, true, true, function() {});
  } catch (e) { /* highlight is best-effort */ }
}

// Phase 2: highlight the step's line in the file it belongs to. Switches the
// editor tab (via the plugin's public selectFile) only when the step's file is
// actually open, and only when the file changes — repeated selectFile calls
// per step would flash/refocus the tab bar.
var debugShownFile = null; // file whose tab replay last selected
var debugSelectingFile = false; // true only while replay is switching the tab
function debugShowLine(st) {
  if (!st || st.line == null) {
    debugHighlightLine(null);
    return;
  }
  var file = st.file || mainFile;
  try {
    // getAllVisibleFiles() (NOT getAllFiles()) so an instructor-hidden file is
    // treated as "not shown": stepping into it suppresses the highlight instead
    // of selectFile()-ing its content pane and leaking its source to a student
    // whose tab is hidden. getAllFiles() only excludes binaries. See issue #46.
    var files = editor.getAllVisibleFiles();
    if (!files || !files.hasOwnProperty(file)) {
      debugHighlightLine(null);
      return;
    }
    if (file !== debugShownFile && typeof editor.selectFile === 'function') {
      // noFocus=true: switching tabs must not move keyboard focus into Ace —
      // that killed arrow-key stepping (arrows would start moving the editor
      // cursor instead of the replay).
      // The flag tells the tabChanged listener below that this switch is ours,
      // so it does not treat it as the student navigating away.
      debugSelectingFile = true;
      try { editor.selectFile(file, true); }  // safe: only called for files that exist
      finally { debugSelectingFile = false; }
      debugShownFile = file;
    }
  } catch (e) { /* tab switching is best-effort */ }
  debugHighlightLine(st.line);
}

// --- Phase 3: gutter breakpoints ---------------------------------------------
//
// A breakpoint does two things over the finished recording. It is a navigation
// filter (next/prev-breakpoint jumps debugIdx to the nearest matching step),
// and it STOPS AUTO MODE: autoplay advances one step and pauses if it lands on
// a marked line. It no longer gates the recorder in any way -- see the tracer.
// Fully dynamic: the predicate reads this table live, so toggling a breakpoint
// mid-replay updates both the jump targets and where autoplay will stop, with
// no re-record.

// file name -> { line(1-based): true }. Null-prototype at BOTH levels, because
// the outer key is a student-chosen file name and the failures differ by name:
//
//   'constructor'  `debugBreakpoints[file] || (... = {})` short-circuits to
//                  Object.prototype.constructor, so the line is written as a
//                  property ON THE GLOBAL Function object. It still fires --
//                  but the state is shared with the whole page, and every file
//                  so named collides on one map.
//   '__proto__'    the assignment sets the prototype instead of storing
//                  anything, so `Object.keys` sees no entry at all and the
//                  breakpoint silently vanishes.
//
// Both were checked by running them, not reasoned about.
var debugBreakpoints = Object.create(null);

function debugToggleBreakpoint(file, line) {
  var bp = debugBreakpoints[file] || (debugBreakpoints[file] = Object.create(null));
  if (bp[line]) delete bp[line]; else bp[line] = true;
  // "your breakpoint was not reached" describes the table AS IT WAS when the
  // recording ran. The student has just changed it, so drop the claim rather
  // than leave it contradicting the pause the very next play press produces.
  // Cleared on any toggle, not only on the marked line: the sentence names no
  // line, so any edit to the table makes it a statement about a table that no
  // longer exists.
  debugBpNote = '';
  // debugRepaintNote() ends in debugPanelSync(), which is also what tells the
  // panel that the table changed. The panel reads hasBreakpoints live at click
  // time and asks for bpAhead once per play press, so nothing here is painted
  // from a cached value -- but the sync also repaints the note above, which is.
  debugRepaintNote();
  return !!bp[line];
}

// Is the step at i on a line the student has marked? One definition, read live
// so a breakpoint toggled mid-replay takes effect immediately. The synthetic
// '<end>' step has a null line, so it can never be mistaken for a breakpoint.
function debugIsBpStep(i) {
  if (!debugRec) return false;
  var st = debugRec.steps[i];
  if (!st || st.line == null) return false;
  var f = st.file || mainFile;
  return !!(debugBreakpoints[f] && debugBreakpoints[f][st.line]);
}

// --- Slice 2: when the pill is allowed to appear -------------------------------
//
// Not "whenever the debugger is enabled". An affordance that is always there
// is furniture; one that appears when it becomes useful is an offer. Three
// conditions, all from the scoping doc's trigger rule.
var debugHasRunOnce = false;   // set by finishRun, cleared by nothing

// "At least two lines worth stepping". A line-based heuristic on purpose: this
// decides whether an affordance appears, not what the program means, and the
// ast transform that could answer properly is not loaded when the question is
// first asked. Covers the three cases the design called out -- parenthesized
// multi-line imports, module docstrings, and `from __future__` -- and stops
// counting at two, because nobody needs the exact number.
function debugRunnableLineCount(src) {
  var lines = String(src || '').split('\n');
  var count = 0, fence = null, importParen = false;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i], t = line.trim();
    if (fence) {                                   // inside a triple-quoted block
      if (line.indexOf(fence) !== -1) fence = null;
      continue;
    }
    if (!t || t.charAt(0) === '#') continue;
    if (importParen) {                             // inside from x import ( ... )
      if (t.indexOf(')') !== -1) importParen = false;
      continue;
    }
    var q = t.match(/^[rubfRUBF]{0,2}("""|''')/);  // a bare string statement
    if (q) {
      if (t.slice(t.indexOf(q[1]) + 3).indexOf(q[1]) === -1) fence = q[1];
      continue;                                    // module/section docstring
    }
    if (/^(import\s|from\s+\S+\s+import\b)/.test(t)) {
      if (t.indexOf('(') !== -1 && t.indexOf(')') === -1) importParen = true;
      continue;
    }
    if (++count >= 2) return count;
  }
  return count;
}

function debugPanelAvailable() {
  if (!stepDebuggerEnabled()) return false;
  // Never yank it away from a student who is using it. Whatever the source
  // says now, a recording in flight or a replay on screen is the panel's
  // whole reason to be there -- and an edit mid-replay would otherwise make
  // the controls vanish rather than explain themselves.
  if (debugRecording || debugRec) return true;
  // "On first Run": before that there is no evidence the program even runs,
  // and step-through re-runs it from scratch anyway.
  if (!debugHasRunOnce) return false;
  var prog = '';
  try { prog = (editor.getAllFiles() || {})[mainFile] || ''; } catch (e) { return false; }
  // Refusing before the click beats runStepThrough's refuse-after-the-click
  // note: the recorder execs raw source under sys.settrace, and VPython needs
  // the transform, so this is a permanent no rather than a not-yet.
  if (usesVPython(prog)) return false;
  return debugRunnableLineCount(prog) >= 2;
}

// Is any step strictly AFTER i on a marked line? Auto mode advances before it
// tests, so the step the playhead departs from can never stop it -- that
// asymmetry is the deadlock defence, and it is right. Its cost is that a
// breakpoint whose ONLY recorded execution is the current step stops nothing,
// while the panel's help promises it will: the student presses play, watches it
// run to the end, and concludes breakpoints are broken. The panel asks this
// once per play press so it can say what is happening instead of going quiet.
//
// A linear scan on purpose. It is bounded by DEBUG_MAX_STEPS (5 000) and runs
// once per press, and an index of marked steps would have to be invalidated on
// every gutter click -- the live read is what makes breakpoints dynamic.
function debugBpAhead(i) {
  if (!debugRec) return false;
  for (var k = (i | 0) + 1; k < debugRec.steps.length; k++) {
    if (debugIsBpStep(k)) return true;
  }
  return false;
}

// Auto mode's single primitive: advance one step, then report why it stopped.
// ADVANCE FIRST, then test where it landed -- the step it departed from is
// never tested. That asymmetry is what stops the play button being dead on the
// very breakpoint the student is parked on: pressing play always moves off it
// and continues to the NEXT one.
//
// It lives here rather than in the panel because breakpoints live here, and it
// is an action rather than a getState flag so that a paint function never
// decides control flow -- and so any future in-tab play button inherits the
// pause for nothing. Deliberately NOT inside debugStepTo: every control routes
// through that (fwd, back, first, last, both jumps, the slider, the arrow
// keys), and a refusal there would trap the playhead.
function debugAutoStep() {
  if (!debugRec) return 'end';
  var end = debugRec.steps.length - 1;
  if (debugIdx >= end) return 'end';
  debugStepTo(debugIdx + 1);
  if (debugIdx >= end) return 'end';
  if (!debugIsBpStep(debugIdx)) return 'moved';
  return 'breakpoint';
}

// The line a failed recording died on, for the panel's error banner. Two
// sources, because the two failure kinds leave different evidence: a RUNTIME
// error has real steps, so the last one the tracer reached carries the line; a
// SYNTAX error never ran at all, so the only record of it is the traceback
// text, where Pyodide writes `File "<debug>", line N`. Last match rather than
// first, so a multi-frame traceback reports the innermost frame.
function debugErrorLine() {
  if (!debugRec || !debugRec.error) return null;
  var steps = debugRec.steps || [];
  for (var i = steps.length - 1; i >= 0; i--) {
    if (steps[i] && steps[i].func !== '<end>' && steps[i].line != null) {
      return steps[i].line;
    }
  }
  // No steps: a SyntaxError, which never ran, so the only record of the line
  // is the traceback text. ANCHORED on the `File "<debug>", line N` header,
  // and taking the FIRST match rather than the last.
  //
  // This used to scan for the last /line (\d+)/ anywhere in the string, with a
  // comment about reporting the innermost frame of a multi-frame traceback --
  // but the payload is format_exception_only (see RECORD_HELPER), which
  // contains no frames at all, so there was never an innermost one to find.
  // What the last match actually picked up was whatever came later in the
  // text, and on CPython 3.13 (pinned via pyodide 0.28.1) that is the
  // message's own suffix: "IndentationError: expected an indented block after
  // 'for' statement on line 1" made the banner say line 1 for an error on
  // line 2 -- on the single most common beginner mistake. It also let the
  // student's own source set the number, because the offending line is echoed
  // into the payload: `print('see line 99')` produced "Error on line 99".
  var m = /^\s*File "[^"]*", line (\d+)/.exec(debugRec.error);
  return m ? parseInt(m[1], 10) : null;
}

// The one line of a traceback worth putting in front of a student: the
// trailing `SomeError: what went wrong`. The frames above it are noise when the
// program is eight lines long, and the whole traceback is still in the console.
// Anchored on the LAST `SomeError:` header and joined from there, rather than
// simply taking the last non-blank line. The old rule was right about the
// common shape -- a SyntaxError's final line is the message, and the two above
// it are the offending source and a caret -- but wrong whenever the message
// itself spans lines: `raise ValueError('line one\nline two')` showed only
// "line two", losing both the error type and half of what the student wrote.
// Falls back to the old behaviour when there is no header to anchor on.
function debugErrorMessage() {
  if (!debugRec || !debugRec.error) return null;
  var lines = String(debugRec.error).replace(/\s+$/, '').split('\n');
  var head = -1;
  // The suffix group is REQUIRED. It was optional, which reduced the whole
  // pattern to /^\w[\w.]*\s*:/ -- "any word followed by a colon" -- and since
  // the loop keeps the LAST match, a colon inside the student's own message
  // won: `raise ValueError('a\nfoo:')` produced a banner reading just "foo:",
  // with the error type gone. Found by an ultrareview of #266, 2026-09-11.
  for (var i = 0; i < lines.length; i++) {
    if (/^\w[\w.]*(Error|Exception|Warning|Exit|Interrupt|StopIteration)\s*:/.test(lines[i])) head = i;
  }
  // Nothing matched, so the exception's class name ends in none of those --
  // `class MyProblem(Exception)`, which students do write. Simply dropping the
  // `?` above would send those to the last-line fallback below, i.e. back to
  // the bug this function exists to fix. So: loose shape, but the FIRST match,
  // because here the header is above the message rather than below it. The
  // "Traceback (most recent call last):" line cannot match (a space follows
  // the word) and the indented File lines cannot match (^\w fails).
  if (head < 0) {
    for (var k = 0; k < lines.length; k++) {
      if (/^\w[\w.]*\s*:/.test(lines[k])) { head = k; break; }
    }
  }
  if (head >= 0) {
    return lines.slice(head).join(' ').replace(/\s+/g, ' ').trim();
  }
  for (var j = lines.length - 1; j >= 0; j--) {
    if (lines[j].trim()) return lines[j].trim();
  }
  return null;
}

function debugHasBreakpoints() {
  for (var f in debugBreakpoints) {
    for (var l in debugBreakpoints[f]) return true;
  }
  return false;
}

// Every marked line, as { file, line }. Used to NAME the line in "your
// breakpoint on line 7 was not reached" -- a student with one dot set should
// not have to work out which sentence is about which line, and with several
// set the sentence stays plural rather than guessing.
function debugBreakpointList() {
  var out = [];
  for (var f in debugBreakpoints) {
    for (var l in debugBreakpoints[f]) {
      if (debugBreakpoints[f][l]) out.push({ file: f, line: parseInt(l, 10) });
    }
  }
  return out;
}

// Breakpoint payload for the recorder: file label -> [lines]. The main file is
// keyed '<main>' (its frames carry no file label).
function debugBreakpointPayload() {
  // Also file-keyed, and it is what crosses into Python.
  var out = Object.create(null);
  for (var f in debugBreakpoints) {
    var lines = [];
    for (var l in debugBreakpoints[f]) lines.push(parseInt(l, 10));
    if (lines.length) out[f === mainFile ? '<main>' : f] = lines;
  }
  return out;
}

// Wire a gutter-click handler on every file's Ace instance (idempotent — safe
// to call repeatedly; files added later get wired via codeeditor.tabChanged).
function ensureGutterBreakpointHandlers() {
  try {
    var files = editor && editor._files;
    if (!files) return;
    for (var i = 0; i < files.length; i++) {
      (function(f) {
        var aceEd = f.editor && f.editor.aceInstance;
        if (!aceEd || aceEd._trinketBpWired) return; // textarea mode / already wired
        aceEd._trinketBpWired = true;
        aceEd.on('guttermousedown', function(e) {
          // Only the line-number cell (not fold widgets), left button only.
          var t = e.domEvent.target;
          if (!t || String(t.className).indexOf('ace_gutter-cell') === -1) return;
          if (e.domEvent.button !== 0) return;
          var row = e.getDocumentPosition().row;
          var on = debugToggleBreakpoint(f.name, row + 1);
          var session = aceEd.getSession();
          if (on) session.setBreakpoint(row, 'ace_breakpoint');
          else session.clearBreakpoint(row);
          e.stop();
        });
      })(files[i]);
    }
  } catch (e) { /* breakpoints are best-effort */ }
}

// Everything the HOST has to say sits in two slots. Both are painted into the
// in-tab #debug-note and both are handed to the floating panel through
// getState().note, which renders them at the top of its variables window.
//
//   debugFlashNote the answer to a press that did nothing ("no breakpoint
//                  ahead"). Lives 2.5 s.
//   debugBpNote    what the recorder observed about the BREAKPOINTS. This is a
//                  record-time snapshot of a table the student can edit
//                  mid-replay, so it stops being true the moment they touch a
//                  gutter dot.
//   debugBaseNote  facts about the RECORDING (truncation, "ends with an
//                  error"). True for as long as that recording is loaded.
//
// Three slots rather than one string because they go stale for different
// reasons, and composing them here means the panel needs no new inlet: it
// already renders getState().note. Two bugs came out of not doing this.
// Keeping the breakpoint clause inside debugBaseNote left nothing to clear it
// on a toggle, so "your breakpoint was not reached" could sit directly above
// the panel's own "paused at the breakpoint on line N". And flashDebugNote
// used to write straight to the DOM without syncing, so with the panel on the
// two circled breakpoint arrows answered a press that could not move the
// playhead with complete silence -- verified live, not deduced.
var debugBaseNote = '';
var debugBpNote = '';
var debugFlashNote = '';
// The "ends with an error" clause, kept OUT of the panel's note channel. It
// used to ride in debugBaseNote, and the panel stripped it with a literal
// string match on a sentence defined here -- so rewording this file's copy
// would have broken the panel silently and in two ways: the error stated
// twice, once in the red banner and once beneath it, AND the note staying
// truthy, which displaced "About to execute line 1." on the one step the
// student is guaranteed to read. The panel now drops it by not reading a
// field, which cannot rot.
var debugErrorNote = '';
var debugNoteTimer = null;
// Order: the answer to what you just pressed, then what the recording did,
// then what that meant for your breakpoints -- cause before consequence, so a
// truncated run reads "recording stopped after 2873 steps · your breakpoint on
// line 11 was not reached before it stopped".
function debugNoteText() {
  var parts = [];
  if (debugFlashNote) parts.push(debugFlashNote);
  if (debugPersistentNote()) parts.push(debugPersistentNote());
  // The in-tab span has no red banner of its own, so it keeps the error
  // clause; the panel's channel below does not.
  if (debugErrorNote) parts.push(debugErrorNote);
  return parts.join(' ');
}
// The persistent half only. The panel needs these two apart, because they now
// appear at different times: the persistent notes explain the recording and
// are wanted on arrival, while a flash answers a press and has to show
// whenever it fires. The in-tab #debug-note span has no such distinction and
// keeps taking everything.
function debugPersistentNote() {
  var parts = [];
  if (debugBaseNote) parts.push(debugBaseNote);
  if (debugBpNote) parts.push(debugBpNote);
  return parts.join(' ');
}
// Paint both channels: the in-tab span, and the panel via getState().note.
function debugRepaintNote() {
  $('#debug-note').text(debugNoteText());
  debugPanelSync();
}
// Say something on BOTH channels at once, and this is the only correct way to
// say anything outside replay. #debug-note lives inside #variables-wrap, which
// the panel path deliberately never opens (the student is stepping precisely
// so they can watch the Result pane), so a bare $('#debug-note').text(...) is
// invisible for the whole life of the feature whenever features.debugPanel is
// on. Anything a student needs to read goes through here.
function setDebugNote(msg) {
  debugBaseNote = msg || '';
  debugRepaintNote();
}
// Retract a message only if it is still the one showing -- a bail's timer must
// not wipe the note of a recording the student started in the meantime.
function clearDebugNoteIf(msg) {
  if (debugBaseNote === msg) setDebugNote('');
}
function flashDebugNote(msg) {
  debugFlashNote = msg || '';
  debugRepaintNote();
  if (debugNoteTimer) clearTimeout(debugNoteTimer);
  debugNoteTimer = setTimeout(function() {
    debugNoteTimer = null;
    debugFlashNote = '';
    debugRepaintNote();
  }, 2500);
}

// Jump to the nearest recorded step (dir = +1/-1) whose (file, line) has a
// breakpoint.
function debugJumpBreakpoint(dir) {
  if (!debugRec) return;
  if (!debugHasBreakpoints()) {
    flashDebugNote('No breakpoints are set. Click the grey margin left of a line number to add one.');
    return;
  }
  for (var i = debugIdx + dir; i >= 0 && i < debugRec.steps.length; i += dir) {
    if (debugIsBpStep(i)) { debugStepTo(i); return; }
  }
  flashDebugNote(dir > 0 ? 'There is no breakpoint ahead of here.'
                         : 'There is no breakpoint behind here.');
}

// Render the variables table for a recorded step (flat, no expansion — the
// recording is a snapshot; live Phase 3 expansion would show FINAL state and
// lie about this step). prevSnap (the step before) drives changed-variable
// highlighting: rows whose value is new or different since the previous step
// get .var-changed so students can see what the line did.
function paintReplaySnap(snap, st, prevSnap) {
  var $body = $('#variables-table tbody');
  if (!$body.length) return;
  var html = '';

  // Breadcrumb: where execution is (file for user modules, frame, call site).
  var crumbs = [];
  if (st && st.file) crumbs.push('in ' + st.file);
  if (st && st.func && st.func !== '<module>' && st.func !== '<end>') {
    var c = 'inside ' + st.func + '()';
    if (st.from_line != null) {
      c += ' — called from ' + (st.from_file ? st.from_file + ' line ' : 'line ') + st.from_line;
    }
    crumbs.push(c);
  }
  if (crumbs.length) {
    html += varNoteRowHtml(0, crumbs.join(' · '));
  }

  // Prototype-less map: a variable legitimately named "toString"/"constructor"
  // etc. would otherwise resolve through Object.prototype and read as always
  // changed. Object.create(null) has no inherited keys.
  var prev = Object.create(null);
  var hasPrev = false;
  if (prevSnap) {
    hasPrev = true;
    for (var p = 0; p < prevSnap.length; p++) prev[prevSnap[p].name] = prevSnap[p].repr;
  }

  if (!snap || !snap.length) {
    html += '<tr class="vars-empty"><td colspan="3">No variables at this step.</td></tr>';
  } else {
    for (var i = 0; i < snap.length; i++) {
      var v = snap[i];
      var changed = hasPrev && (!(v.name in prev) || prev[v.name] !== v.repr);
      html += varRowHtml({
        displayName: v.name, type: v.type, repr: v.repr, len: null,
        expandable: false, cyclic: false, kind: 'value'
      }, { root: v.name, path: [], depth: 0, isChild: false,
           rowClass: changed ? 'var-changed' : '' });
    }
  }
  $body.html(html);
}

// Console sync state: the output offset (and whether the error line is shown)
// currently rendered in the console. Most steps print nothing, so tracking
// this lets stepping skip the console entirely instead of Reset+rewriting the
// whole output on every keypress (flicker + O(total output) DOM work per step).
var debugLastOut = -1;      // -1 = console not synced yet (forces full paint)
var debugErrShown = false;

function renderDebugStep() {
  if (!debugRec) return;
  var st = debugRec.steps[debugIdx];
  var isEnd = st.func === '<end>';
  $('#debug-pos').text(isEnd ? 'end' : (debugIdx + 1) + ' / ' + (debugRec.steps.length - 1));
  var $slider = $('#debug-slider');
  if ($slider.length) {
    $slider.attr('max', debugRec.steps.length - 1);
    $slider.val(debugIdx);
  }
  paintReplaySnap(debugRec.snaps[debugIdx],
                  st,
                  debugIdx > 0 ? debugRec.snaps[debugIdx - 1] : null);
  debugShowLine(st);
  debugPanelSync();
  if (jqconsole) {
    var wantErr = isEnd && !!debugRec.error;
    if (debugLastOut === -1 || st.out < debugLastOut || wantErr !== debugErrShown) {
      // First paint, stepping backward past output, or the error line toggled:
      // rebuild from scratch. Drop any queued live output first — it belongs to
      // the console being torn down, and consoleWrite below would otherwise
      // flush it into the replay.
      outResetBuffer();
      jqconsole.Reset();
      jqconsole.Append(loadingHeader());
      consoleWrite(debugRec.output.slice(0, st.out));
      if (wantErr) {
        consoleWrite('\n' + escapeConsoleHtml(debugRec.error) + '\n', 'jqconsole-error', false);
      }
    } else if (st.out > debugLastOut) {
      // Forward over new output: append just the delta.
      consoleWrite(debugRec.output.slice(debugLastOut, st.out));
    }
    // st.out === debugLastOut with no error change: console untouched.
    debugLastOut = st.out;
    debugErrShown = wantErr;
  }
}

// Which names the STUDENT introduced, in the order they came into existence.
//
// The snapshot filter already drops dunders, modules and injected names, and
// the recorder's snapshots carry no functions or classes -- but that is not
// enough. `from math import *` binds pi, e, tau, inf and nan as plain floats,
// and `from sympy import *` binds a great many more; all of them arrive as
// ordinary values and bury the two variables the student actually wrote.
//
// So attribute each name to the line that bound it. A `line` trace event fires
// BEFORE its line runs, so a name first visible at step k was bound by the line
// of step k-1; if that line is an import statement, the name is library
// furniture rather than the student's. This needs no blocklist and handles
// `import x`, `from x import y` and `from x import *` alike.
var debugVarModel = null;   // cached per recording; cleared on enter/exit

var DEBUG_IMPORT_RE = /^\s*(?:import\s|from\s+[.\w]+\s+import\b)/;

function debugBuildVarModel() {
  if (!debugRec) return null;
  if (debugVarModel) return debugVarModel;

  // Both file-keyed, so both take the same null-prototype treatment as
  // debugBreakpoints -- `lineCache['constructor']` is otherwise truthy and
  // returns a Function where a line array is expected.
  var files = Object.create(null);
  try { files = editor.getAllFiles() || files; } catch (e) { files = Object.create(null); }
  var lineCache = Object.create(null);
  function sourceLine(file, line) {
    var key = file || mainFile;
    if (!(key in lineCache)) {
      lineCache[key] = files[key] == null ? null : String(files[key]).split('\n');
    }
    var arr = lineCache[key];
    return arr && line > 0 && line <= arr.length ? arr[line - 1] : null;
  }

  // Null-prototype: these are keyed by STUDENT variable names, and a plain
  // object answers `'constructor' in firstStep` before anything is recorded --
  // so a variable so named would read as already-seen and vanish.
  var order = [], firstStep = Object.create(null), fromImport = Object.create(null);
  for (var k = 0; k < debugRec.snaps.length; k++) {
    // Main-file steps only. `from lots import *` executes lots.py, and the
    // tracer follows user modules -- so those steps snapshot THAT module's
    // globals, where the star-exported names are local and legitimate. They
    // are not the student's variables, and without this the list filled with
    // the first fifty of them. A variable defined in a second file the student
    // wrote is excluded too; that is the deliberate trade.
    var stp = debugRec.steps[k];
    if (stp && stp.file) continue;
    var snap = debugRec.snaps[k] || [];
    for (var j = 0; j < snap.length; j++) {
      var nm = snap[j].name;
      if (nm in firstStep) continue;
      firstStep[nm] = k;
      order.push(nm);
      var prev = k > 0 ? debugRec.steps[k - 1] : null;
      var src = prev && prev.line ? sourceLine(prev.file, prev.line) : null;
      if (src && DEBUG_IMPORT_RE.test(src)) fromImport[nm] = true;
    }
  }
  debugVarModel = { order: order, firstStep: firstStep, fromImport: fromImport };
  return debugVarModel;
}

function debugStepTo(idx) {
  if (!debugRec) return;
  // A flash answers a press that could NOT move the playhead ("no breakpoint
  // ahead"). The moment one does move, that answer is about a step the student
  // has left, so retract it rather than let it ride out its 2.5 s above the
  // new step's variables. Caught live: three jumps in a row all showed the
  // first one's answer, which only became visible once flashes reached the
  // panel at all.
  if (debugFlashNote) {
    debugFlashNote = '';
    if (debugNoteTimer) { clearTimeout(debugNoteTimer); debugNoteTimer = null; }
    $('#debug-note').text(debugNoteText());   // sync comes with renderDebugStep
  }
  debugIdx = Math.max(0, Math.min(idx, debugRec.steps.length - 1));
  renderDebugStep();
}

// 49906 -> "49,906". Deliberately not toLocaleString: its separator is
// locale-dependent, and a de-DE reader would get "49.906" -- a period in the
// middle of a sentence, in a panel whose messages are all sentences now.
function debugThousands(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Per-step "how many times has THIS line run by now", precomputed once so the
// slider's tooltip can say "about to execute line 8 for the 43rd time". One
// pass over at most DEBUG_MAX_STEPS entries; recomputing it per hover would be
// the same work repeated on every sync during autoplay.
var debugVisits = null;
// The step at which the program first repeats a line -- i.e. the first moment
// there is a loop to be in. Null if it never repeats one.
//
// Before it, "for the first time" is true of every line and therefore says
// nothing: a straight-line program would carry the clause on every single step
// and never once be informative. From it onwards the ordinal earns its place,
// INCLUDING on a line's first visit -- a branch inside a loop that finally
// fires on pass 40 saying "for the 1st time" is telling you something real.
//
// Keyed on the step INDEX, not on where the student has been, so the same step
// always reads the same however they got there. A sticky flag would make one
// step say two different things depending on history.
var debugRepeatFrom = null;
function debugBuildVisits(rec) {
  var seen = Object.create(null), out = new Array(rec.steps.length), i, st, k;
  debugRepeatFrom = null;
  for (i = 0; i < rec.steps.length; i++) {
    st = rec.steps[i];
    if (!st || st.line == null) { out[i] = 0; continue; }
    k = (st.file || '<main>') + ':' + st.line;
    seen[k] = (seen[k] || 0) + 1;
    out[i] = seen[k];
    if (out[i] >= 2 && debugRepeatFrom === null) debugRepeatFrom = i;
  }
  return out;
}

// How many COMPLETE passes through the busiest loop the recording holds, or
// null if there is no loop worth naming.
//
// The counting rule matters, because the obvious one is off by one. A `for`
// header fires once per pass PLUS once more when the iterator is exhausted (or
// when the recording is cut mid-body), so the maximum count belongs to the
// header and overstates completed passes. Within one truncated final pass the
// loop's own lines differ by at most one, so: take the lines whose count is
// within 2 of the maximum -- that is the loop, header included -- and report
// the MINIMUM of them, which is the last body line to have run. On the
// dt=0.001 projectile that gives 873, matching the `i = 873` the variables
// window shows at the final step. Taking the maximum would have said 875.
function debugLoopIterations(rec) {
  var counts = Object.create(null), i, st, k, max = 0;
  for (i = 0; i < rec.steps.length; i++) {
    st = rec.steps[i];
    if (!st || st.line == null) continue;
    k = (st.file || '<main>') + ':' + st.line;
    counts[k] = (counts[k] || 0) + 1;
    if (counts[k] > max) max = counts[k];
  }
  // Nothing ran more than a couple of times: a straight-line program, or
  // recursion without a loop. Claiming "iterations of your loop" here would be
  // a plain falsehood, so say nothing about loops.
  if (max < 3) return null;
  // ONE LOOP, OR DECLINE. The within-2 rule assumes a single loop, where the
  // header fires at most one more time than the body. Under NESTING the counts
  // differ multiplicatively: measured on `for i in range(2000)` around
  // `for j in range(2)`, the inner header fired 2,500 times, the inner body
  // 1,666 and the outer header 834 -- so the filter admitted only the inner
  // header and reported 2,500 as "iterations of your loop", 50% above the
  // inner count and 3x the outer. Stating a wrong number as fact is worse
  // than not naming one.
  //
  // The discriminator is the gap to the next DISTINCT count: ~1.00 for a
  // single loop (875 vs 874), 1.50 for the nested case above. Past 1.25 the
  // shape is not a simple loop and the caller falls back to a sentence that is
  // true of any program. This also declines on recursion deep enough to
  // truncate, which `max < 3` does not catch.
  var distinct = [];
  for (k in counts) if (distinct.indexOf(counts[k]) === -1) distinct.push(counts[k]);
  distinct.sort(function(a, b) { return b - a; });
  if (distinct.length > 1 && max / distinct[1] > 1.25) return null;
  var min = max;
  for (k in counts) {
    if (counts[k] >= max - 2 && counts[k] < min) min = counts[k];
  }
  return min;
}

function enterReplay(rec) {
  debugRec = rec;
  debugVisits = debugBuildVisits(rec);
  debugVarModel = null;
  debugIdx = 0;
  debugLastOut = -1;
  debugErrShown = false;
  $('#debug-recording').addClass('hide');
  $('#debug-launch').addClass('hide');
  $('#debug-controls').removeClass('hide');
  var notes = [];
  // bpHit is false whenever breakpoints were set and the recorder never saw
  // one execute. Say only that, because that is all the flag carries. It used
  // to say "that line never ran", which asserts knowledge the recorder does
  // not have: the flag is equally false when the recording simply STOPPED
  // first (5 000 steps / 2 MB), when the line lives deeper than
  // DEBUG_MAX_DEPTH frames, and when the dot belongs to a file the student has
  // since renamed or deleted. A student told "that line never ran" about a
  // line that ran 40 000 times will believe the debugger over their own
  // program, and go looking for a bug that is not there.
  //
  // The truncated case gets its own sentence because it has a remedy the
  // student can act on -- shorten the loop -- and because "not reached" and
  // "never ran" are different claims.
  // A deferred recording is not a recording of the program -- it is a window
  // around the student's breakpoint -- so say so first, before the caps and
  // the breakpoint status. Both numbers are real: `kept` is what the ring
  // actually held (fewer than the full window if the breakpoint came early),
  // and `skipped` is what it dropped to get there.
  if (rec.deferred && rec.bpHit && debugBreakpointList().length) {
    var kept = rec.kept || 0, skipped = rec.skipped || 0;
    var bl0 = debugBreakpointList();
    var where = bl0.length === 1 ? 'your breakpoint on line ' + bl0[0].line
                                 : 'your breakpoint';
    notes.push(kept
      ? 'Playback starts ' + debugThousands(kept) + (kept === 1 ? ' step' : ' steps') + ' before ' + where + '.'
      : 'Playback starts at ' + where + '.');
    if (skipped) {
      // "The 49,906 lines before that..." rather than "49906 earlier lines..."
      // -- a sentence should not open with a digit.
      notes.push('The ' + debugThousands(skipped)
        + ' lines before that were not recorded.');
    }
  }
  debugBpNote = '';
  var bps = debugBreakpointList();
  // bps can be empty here even with bpHit false, if every dot was cleared
  // between the run and the replay -- then there is nothing to report.
  if (rec.bpHit === false && bps.length) {
    var one   = bps.length === 1;
    var which = one ? 'your breakpoint on line ' + bps[0].line : 'your breakpoints';
    var verb  = one ? 'was' : 'were';
    // Capitalised here rather than at the join, because this clause can also
    // stand alone as the only note.
    debugBpNote = which.charAt(0).toUpperCase() + which.slice(1)
                + ' ' + verb + ' not reached'
                + (rec.truncated ? ' before the recording stopped.' : '.');
  }
  // Says what you HAVE, and what to do to see more. The old text --
  // "recording stopped after 4371 steps" -- read as a failure report for what
  // is usually not a failure (4371 steps is more than anyone hand-steps), gave
  // a number with no referent, and named no action. "steps" is the debugger's
  // unit too; iterations are the student's.
  //
  // No code example on the end, deliberately. `range(50) instead of
  // range(10000)` is only literally true of `for i in range(10000)`: it is
  // misleading when the bound is a variable (there is no range(10000) in the
  // file to find), wrong when the bound is computed, and meaningless for a
  // `while` loop, which is the projectile idiom. The advice generalises;
  // the example did not.
  if (rec.truncated) {
    var iters = debugLoopIterations(rec);
    notes.push(iters
      ? 'The first ' + debugThousands(iters) + ' iterations of your loop are'
        + ' stored to play in the debugger. If you want to see the whole'
        + ' program, loop through fewer iterations while debugging.'
      : 'The first ' + debugThousands(rec.steps.length - 1) + ' lines your'
        + ' program ran are stored to play in the debugger.');
  }
  // Unconditional. This used to be gated on !debugPanelEnabled(), on the
  // reasoning that the panel shows a bold red banner instead -- but
  // debugPanelEnabled() is a pure CONFIG read and says nothing about whether
  // the panel is rendering anything right now. The banner lives past the
  // panel's `if (!expanded) return` guard, and a collapsed pill mid-replay is
  // reachable: the in-tab controls are still emitted with the flag on
  // (pyodide.html gates them on stepDebugger alone), so a student can start
  // step-through from the Variables tab with the pill shut. In that state the
  // note was suppressed, the banner was unreachable, and showVariables() had
  // hidden the console -- so nothing anywhere said the run ends badly.
  // The panel drops this clause itself when its red banner IS showing.
  debugErrorNote = rec.error ? 'This run ends with an error.' : '';
  // A SPACE, not ' · '. Every note is now a full sentence starting with a
  // capital and ending with a period, so a middle dot between them read as
  // punctuation inside one sentence -- "...while debugging. · Your breakpoint
  // on line 11..." Ordinary prose spacing is what sentences want.
  debugBaseNote = notes.join(' ');
  $('#debug-note').text(debugNoteText());
  // Without the floating panel the controls only exist inside the Variables
  // tab, so entering replay has to open it. With the panel, opening it would
  // defeat the point of the feature: the student is stepping precisely so they
  // can watch the Result pane change. paintReplaySnap keeps writing the table
  // either way, so switching to Variables by hand still shows the right step.
  if (!debugPanelEnabled()) showVariables();
  renderDebugStep();   // ends in debugPanelSync()
}

// Leave replay mode. `quiet` skips the console restore — used by callers that
// are about to reset or rewrite the console themselves (a fresh run, the
// Reset Output button), where restoring the recording's output first would be
// wasted or actively wrong. The ✕ button uses the default (restore), so
// exiting by hand leaves the full recorded output visible.
// `why` says what to do with the console, because the three exits want three
// different things and a boolean could only express two:
//
//   undefined / 'restore'  the X button. A deliberate exit, so restore the
//                          full recorded output AND its traceback -- nothing
//                          about the program has changed.
//   true / 'quiet'         a fresh run or a replaced program is about to
//                          rewrite the console anyway; touching it here would
//                          be wasted or actively wrong.
//   'stale'                the student EDITED the code. The output still
//                          belongs to a run that happened, but the traceback
//                          describes source that no longer exists -- and
//                          re-posting it at the moment they fix the error is
//                          how the debugger came to announce a bug they had
//                          just repaired. Larry found this by using it.
//
// `true` is still accepted so the two fresh-run callers read unchanged.
function exitReplay(why) {
  var quiet = (why === true || why === 'quiet');
  var stale = (why === 'stale');
  if (!debugRec) return;
  var rec = debugRec;
  debugRec = null;
  // THE PLAYHEAD RESETS TOO. Everything else about the recording was cleared
  // here and debugIdx was not, so getState() went on reporting idx: 5 next to
  // replaying: false -- and the panel gates the recorder's note on
  // `s.idx === 0` meaning "just arrived at a recording". Read in a state with
  // no recording, that test sent every bail message (VPython, console input,
  // "The recording failed.", and both deferred give-ups) into a branch that
  // renders nothing, so they landed nowhere at all. The in-tab span still got
  // them, which is exactly the pane the panel path never opens.
  debugIdx = 0;
  debugVisits = null;
  debugRepeatFrom = null;
  debugVarModel = null;
  debugLastOut = -1;
  debugErrShown = false;
  debugShownFile = null;
  debugHighlightLine(null);
  $('#debug-controls').addClass('hide');
  debugBaseNote = '';
  debugBpNote = '';
  debugFlashNote = '';
  debugErrorNote = '';
  if (debugNoteTimer) { clearTimeout(debugNoteTimer); debugNoteTimer = null; }
  $('#debug-note').text('');
  $('#debug-launch').removeClass('hide');
  $('#debug-recording').addClass('hide');
  // Restore the console to the full recorded output and the table to the live
  // post-run explorer view.
  if (!quiet && jqconsole) {
    outResetBuffer();
    jqconsole.Reset();
    jqconsole.Append(loadingHeader());
    consoleWrite(rec.output);
    if (rec.error) {
      if (stale) {
        // PAST TENSE, and more than that: it names the edit that superseded
        // the error, which is the fact the student can check, and it ends with
        // something to do. Tense alone does not carry it -- a red traceback
        // below has no tense and reads as current whatever sits above it --
        // so the traceback is demoted out of the error class here too. The
        // panel's own red banner is untouched; this is the console copy only.
        consoleWrite('\nThis ran before your last edit \u2014 the error below may'
          + ' already be fixed. Press Run to check.\n', 'jqconsole-output', false);
        consoleWrite(escapeConsoleHtml(rec.error) + '\n', 'jqconsole-output', false);
      } else {
        consoleWrite('\n' + escapeConsoleHtml(rec.error) + '\n', 'jqconsole-error', false);
      }
    }
  }
  paintVariables();
  debugPanelSync();
}

// Run the program under the recorder, then enter replay. Mirrors startRun's
// pre-steps (FS sync, package auto-load, matplotlib target) but execs in a
// fresh namespace under trace. Normal Run is untouched.
// `defer` is the OPT-IN deferred recording: coast without recording until a
// marked line executes, keeping only the last DEBUG_LOOKBACK_STEPS steps
// before it. Every pre-existing caller passes nothing, so it is false and the
// recorder behaves exactly as before. The only thing that passes true is the
// panel's "record from the breakpoint instead" button, which is only offered
// after a recording truncated before reaching the student's breakpoint.
function runStepThrough(defer) {
  if (running || debugRecording) return;
  if (debugRec) exitReplay();

  debugRecording = true;
  debugDeferring = !!defer;
  debugCancelled = false;
  $('#debug-launch').addClass('hide');
  $('#debug-recording').removeClass('hide');
  debugPanelSync();

  // `ran` says whether the recorder actually executed the program. The bails
  // above it (debugCancelled, a normal run got in first, VPython, console) resolve
  // the chain with null and still land in the .then below, so an unconditional
  // hook fired on paths where nothing ran at all -- and on a worker-runtime
  // trinket that flipped the panel from "no backend" onto THIS thread's
  // Pyodide, which never ran the program and holds no figure.
  function recordingDone(ran) {
    debugDeferring = false;   // never inherited by the next recording
    debugRecording = false;
    $('#debug-recording').addClass('hide');
    if (!debugRec) $('#debug-launch').removeClass('hide');
    // Step-through does not go through finishRun(), but a real recording
    // re-runs the program on the page's Pyodide and can leave a different
    // figure behind. Always 'main': the recorder never uses the worker.
    if (ran && window.trinketPlotpolish) {
      try { trinketPlotpolish.afterRun('main'); } catch (e) {}
    }
    debugPanelSync();
  }

  ensurePyodide().then(function() {
    if (debugCancelled || running) return null; // cancelled, or a normal run got in first
    // Deliberately NOT routed through runProgram(): typeset math output covers
    // the plain run and worker paths in slice 1 only. See slice 2 in
    // docs/superpowers/plans/2026-09-04-sympy-math-output.md.
    var prog = syncFilesToFS(editor.getAllFiles(), mainFile);
    if (usesVPython(prog)) {
      // setDebugNote, not $('#debug-note').text: with features.debugPanel on
      // the in-tab note lives in a pane the panel never opens, so writing
      // there alone means the pill flashes "Recording..." and returns to
      // "step through" with no explanation anywhere on screen.
      var vpyMsg = 'Step through is not available for VPython programs.';
      setDebugNote(vpyMsg);
      setTimeout(function() { clearDebugNoteIf(vpyMsg); }, 4000);
      return null;
    }
    if (usesConsole(prog) && !userShadowsConsole()) {
      // The recorder (RECORD_HELPER) execs the RAW user source under
      // sys.settrace — it never routes through ensureConsoleTransform/
      // transform_source, so a `console.input()` call would run un-awaited
      // (a silently-wrong coroutine, and the input field would never open).
      // Bail with the same mechanism/style as the VPython guard above rather
      // than teaching the recorder about the transform.
      var inputMsg = 'Step through is not available for programs that read console input.';
      setDebugNote(inputMsg);
      setTimeout(function() { clearDebugNoteIf(inputMsg); }, 4000);
      return null;
    }
    return pyodide.loadPackagesFromImports(prog).then(function() {
      if (debugCancelled || running) return null; // cancelled, or a normal run got in first
      var setup = Promise.resolve();
      if (usesMatplotlib(prog)) {
        window.document.pyodideMplTarget = document.getElementById('graphic');
        showGraphic();
        setup = pyodide.runPythonAsync(MATPLOTLIB_SETUP_CODE);
      }
      return setup.then(function() {
        if (debugCancelled || running) return null; // cancelled, or a normal run got in first
        var ns = null;
        try {
          ns = pyodide.toPy({
            _user_source: prog,
            // Secondary .py files sync to the Pyodide FS home dir; frames from
            // there are user code the tracer should step through (Phase 2).
            _user_prefix: '/home/pyodide/',
            // Breakpoints are passed in so the recorder can report whether one
            // was ever REACHED (_hit). They do not gate recording unless
            // _defer is set, which only the panel's explicit "record from the
            // breakpoint instead" button does.
            _bp: debugBreakpointPayload(),
            // Opt-in only; see runStepThrough's `defer`.
            _defer: debugDeferring,
            _lookback: DEBUG_LOOKBACK_STEPS,
            _max_dormant: DEBUG_MAX_DORMANT,
            _max_steps: DEBUG_MAX_STEPS,
            _max_vars: DEBUG_MAX_VARS,
            _max_repr: DEBUG_MAX_REPR,
            _max_depth: DEBUG_MAX_DEPTH,
            _max_bytes: DEBUG_MAX_BYTES,
            _min_out: DEBUG_MIN_OUTPUT_BYTES
          });
          return JSON.parse(pyodide.runPython(RECORD_HELPER, { globals: ns }));
        } finally {
          if (ns && typeof ns.destroy === 'function') {
            try { ns.destroy(); } catch (e) {}
          }
        }
      });
    });
  }).then(function(rec) {
    recordingDone(!!rec && !debugCancelled);
    if (rec && !debugCancelled) {
      // A deferred recording that never armed holds nothing but the synthetic
      // <end> step: the marked line did not execute at all, so there was
      // nothing to start from. Report it instead of opening a replay of one
      // empty step -- and report it plainly, because this run ANSWERS the
      // question the ordinary one could not. A truncated recording cannot
      // tell "that line is unreachable" from "that line is past the cap";
      // this one just did, and the answer is unreachable.
      if (rec.deferred && rec.bpHit === false) {
        var bl = debugBreakpointList();
        var one = bl.length === 1;
        // TWO different causes, and bpHit alone cannot tell them apart --
        // rec.truncated can. Saying "never ran" on the give-up path would be
        // the same lie this whole branch exists to stop telling: with dt one
        // decade smaller the coast trips the 200,000-event cap and the line
        // runs 10,000 times. The second run's whole justification is that it
        // CAN separate "unreachable" from "past the cap", so it has to.
        if (rec.truncated) {
          setDebugNote(one
            ? 'Gave up before reaching line ' + bl[0].line
              + '. The program runs too long above it.'
            : 'Gave up before reaching any of the lines you marked.');
        } else {
          setDebugNote(one
            ? 'Line ' + bl[0].line + ' never ran, so there was nothing to record from it.'
            : 'None of the lines you marked ran, so there was nothing to record from.');
        }
        return;
      }
      initConsoleOutput();
      enterReplay(rec);
    }
  }).catch(function(err) {
    recordingDone(false);
    setDebugNote('The recording failed.');
    setTimeout(function() { clearDebugNoteIf('The recording failed.'); }, 4000);
  });
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

var lastVars = [];          // most recent full snapshot (all kinds)
var showCallables = false;  // toggle: also list functions & classes

// A repr length is meaningful only for sized containers; show it for these so
// users see "list (1000)" without the repr having to spell it out.
var SIZED_TYPES = { list:1, tuple:1, dict:1, set:1, frozenset:1, str:1, bytes:1, bytearray:1, range:1 };

function kindIcon(kind) {
  if (kind === 'function') return '<i class="fa fa-superscript var-kind-icon" title="function"></i> ';
  if (kind === 'class') return '<i class="fa fa-cube var-kind-icon" title="class"></i> ';
  return '';
}

function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return;
    }
  } catch (e) { /* fall through */ }
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
}

// Store the latest snapshot, then paint. Painting is split out so the
// functions/classes toggle can re-render without re-running the program.
function renderVariables(vars) {
  lastVars = vars || [];
  paintVariables();
}

function varLenBadge(type, len) {
  if (len != null && SIZED_TYPES[type]) {
    return ' <span class="var-len">(' + len + ')</span>';
  }
  return '';
}

// Build one <tr>. `node` fields: displayName, type, repr, len, expandable,
// cyclic, kind. `meta`: root (top-level var name), path (positional path to THIS
// node), depth, isChild. The path + root are stashed on the row so the expand
// handler can lazily fetch this node's children.
function varRowHtml(node, meta) {
  var depth = meta.depth;
  var canExpand = node.expandable && depth < MAX_DEPTH;
  var toggle = canExpand
    ? '<span class="var-toggle" role="button" tabindex="0" aria-expanded="false" title="Expand"><i class="fa fa-caret-right"></i></span>'
    : '<span class="var-toggle-spacer"></span>';
  var cyc = node.cyclic ? '<span class="var-cyclic" title="circular reference">↻</span> ' : '';
  var indent = 'padding-left:' + (8 + depth * 16) + 'px';
  var kind = node.kind || 'value';
  return '<tr class="var-row var-kind-' + kind + (meta.isChild ? ' var-child' : '')
    + (meta.rowClass ? ' ' + meta.rowClass : '') + '"'
    + ' data-root="' + escHtml(meta.root) + '"'
    + " data-path='" + JSON.stringify(meta.path) + "'"
    + ' data-depth="' + depth + '" data-expanded="0">'
    // title = full name: the cell ellipsizes at max-width 220px (deep indents
    // eat into it), so hover must be able to reveal what got clipped.
    + '<td class="var-name" style="' + indent + '" title="' + escHtml(node.displayName) + '">' + toggle + kindIcon(kind) + cyc + escHtml(node.displayName) + '</td>'
    + '<td class="var-type">' + escHtml(node.type) + varLenBadge(node.type, node.len) + '</td>'
    + '<td class="var-value"><span class="var-value-text">' + escHtml(node.repr) + '</span>'
    + '<button type="button" class="var-copy" title="Copy value" aria-label="Copy value" tabindex="-1">'
    + '<i class="fa fa-clone"></i></button></td>'
    + '</tr>';
}

// Row shown when a node has more children than MAX_CHILDREN, or is empty.
function varNoteRowHtml(depth, text) {
  return '<tr class="var-more" data-depth="' + depth + '">'
    + '<td colspan="3" style="padding-left:' + (8 + depth * 16) + 'px">' + escHtml(text) + '</td></tr>';
}

// Remove every row that follows $row while it is deeper than $row — i.e. the
// whole lazily-rendered subtree beneath it.
function collapseSubtree($row) {
  var depth = parseInt($row.attr('data-depth'), 10);
  var $next = $row.next();
  while ($next.length && parseInt($next.attr('data-depth'), 10) > depth) {
    var $remove = $next;
    $next = $next.next();
    $remove.remove();
  }
}

function paintVariables() {
  if (debugRec) return; // replay owns the table; exitReplay repaints on the way out
  var $body = $('#variables-table tbody');
  if (!$body.length) return; // no Variables panel (e.g. outputOnly embed)

  // Count badge tracks plain values (the primary signal); callables are secondary.
  var valueCount = 0;
  for (var k = 0; k < lastVars.length; k++) {
    if (lastVars[k].kind === 'value') valueCount++;
  }
  $('#variablesCount').text(valueCount ? '(' + valueCount + ')' : '');

  var shown = [];
  for (var i = 0; i < lastVars.length; i++) {
    if (lastVars[i].kind === 'value' || showCallables) shown.push(lastVars[i]);
  }

  if (!shown.length) {
    var msg = lastVars.length ? 'No variables to show.' : 'No variables yet — run your code.';
    $body.html('<tr class="vars-empty"><td colspan="3">' + msg + '</td></tr>');
    return;
  }

  // Repaint drops any expanded subtrees (they can be re-opened) — the snapshot
  // this reflects is fresh, so stale expansions shouldn't linger.
  var html = '';
  for (var j = 0; j < shown.length; j++) {
    var v = shown[j];
    html += varRowHtml({
      displayName: v.name, type: v.type, repr: v.repr, len: v.len,
      expandable: v.expandable, cyclic: false, kind: v.kind
    }, { root: v.name, path: [], depth: 0, isChild: false });
  }
  $body.html(html);
}

// Expand/collapse a container row: on first expand, lazily fetch one level of
// children and insert them as indented rows beneath; on collapse, drop them.
function toggleVarRow($row) {
  var $btn = $row.children('.var-name').find('.var-toggle');
  if ($row.attr('data-expanded') === '1') {
    collapseSubtree($row);
    $row.attr('data-expanded', '0');
    $btn.attr('aria-expanded', 'false').find('i').removeClass('fa-caret-down').addClass('fa-caret-right');
    return;
  }

  var root = $row.attr('data-root');
  var path = JSON.parse($row.attr('data-path'));
  var depth = parseInt($row.attr('data-depth'), 10);
  var res = expandNode(root, path);
  if (!res || !res.ok) {
    $row.after(varNoteRowHtml(depth + 1, '(could not read children)'));
    $row.attr('data-expanded', '1');
    $btn.attr('aria-expanded', 'true').find('i').removeClass('fa-caret-right').addClass('fa-caret-down');
    return;
  }

  var childDepth = depth + 1;
  var html = '';
  for (var i = 0; i < res.children.length; i++) {
    var c = res.children[i];
    html += varRowHtml({
      displayName: c.label, type: c.type, repr: c.repr, len: c.len,
      expandable: c.expandable, cyclic: c.cyclic, kind: 'value'
    }, { root: root, path: path.concat(i), depth: childDepth, isChild: true });
  }
  if (res.total > res.children.length) {
    html += varNoteRowHtml(childDepth,
      '… ' + (res.total - res.children.length) + ' more not shown (' + res.total + ' total)');
  }
  if (!html) {
    html = varNoteRowHtml(childDepth, '(empty)');
  }
  $row.after(html);
  $row.attr('data-expanded', '1');
  $btn.attr('aria-expanded', 'true').find('i').removeClass('fa-caret-right').addClass('fa-caret-down');
}

function showVariables() {
  $('#outputContainer').addClass('hide');
  $('#instructionsContainer').addClass('hide');
  $('#variables-wrap').removeClass('hide');
  $('#codeOutputTab, #instructionsTab').removeClass('active');
  $('#variablesTab').addClass('active');
}

function hideVariables() {
  $('#variables-wrap').addClass('hide');
  $('#variablesTab').removeClass('active');
}

// #108: run this program in the Web Worker.
//
// Output and tracebacks go through the SAME helpers the main-thread path uses,
// so #107's frame filtering and the console escaping apply unchanged and the two
// runtimes cannot drift apart in what a student sees.
//
// Completion goes through finishRun() for the same reason: it owns the `running`
// flag, the "complete" postMessage the embedding page listens for, and the
// queued-rerun handling. Duplicating a subset of that here is how the two paths
// would quietly diverge.
function ensureWorkerClient() {
  if (workerClient) return workerClient;

  workerClient = workerClientApi.createWorkerClient({
    workerUrl  : assetUrl('/js/embed/pyodide-worker.js'),
    pyodideUrl : PYODIDE_INDEX_URL + 'pyodide.mjs',   // module build (#215)
    indexURL   : PYODIDE_INDEX_URL,
    transformUrl : ASYNC_TRANSFORM_URL,
    varsHelper   : VARS_HELPER,
    // features.mathOutput: empty when the flag is off, and the worker then
    // fetches nothing and installs nothing. The URL is cache-prefixed here for
    // the same reason every other asset is.
    displayUrl   : mathOutputEnabled() ? TRINKET_DISPLAY_URL : '',
    // Completes the "Loading Python (Pyodide)… " line once the worker's Pyodide
    // has booted (#27). closeRuntimeLine() is a no-op unless a line is actually
    // open, so a boot nobody announced cannot print a stray "ready".
    onReady    : function() { closeRuntimeLine(); },
    onStdout   : function(text) { writeStream(text); },
    // Straight into the main thread's own sink, so a worker card and a
    // main-thread card go through exactly one code path from here on: same
    // payload parsing, same queue, same renderer, same line cap.
    onRich     : function(json) { window.__trinket_rich(json); },
    onFigure : function(msg) { handleWorkerFigure(msg); },
    onSceneOps : function(msg) { handleWorkerSceneOps(msg); },
    onInputRequest : function(prompt) {
      // The same jq-console widget console.input() uses, so a prompt looks
      // identical whichever runtime is executing.
      return new Promise(function(resolve) {
        // Write the prompt here, synchronously, rather than printing it from
        // Python: batched stdout holds a newline-less prompt until the next
        // newline, which lands after the answer.
        // consoleWrite (not writeOut) so the queue is flushed first: the prompt
        // must appear after everything the program already printed, and before
        // the input widget.
        flushConsoleNow();
        if (prompt) { consoleWrite(String(prompt)); }
        $('#console-output').addClass('console-active');
        jqconsole.Input(function(line) {
          $('#console-output').removeClass('console-active');
          resolve(line);
        });
        jqconsole.Focus();
      });
    },
    onStderr   : function(text) { writeStream(text); },
    onError    : function(traceback) {
      workerRunError = new Error(traceback);
      // At the prompt the frame is the console, not a file — CPython names it
      // <stdin>, and calling it main.py would point a student at a line of a
      // file they never wrote.
      var frameName = replActive ? '<stdin>' : mainFile;
      consoleWrite('\n' + escapeConsoleHtml(formatPythonTraceback(traceback, frameName)) + '\n',
                      'jqconsole-error', false);
    }
  });
  return workerClient;
}

var workerRunError = null;   // set by onError so finishRun() can report it

// `program` is the main file's source; `files` is the whole editor file map, so
// the worker can write the secondary .py modules into its own FS exactly as
// syncFilesToFS() does for the main thread. `serialized` is what finishRun()
// reports to analytics, matching the main path.
// #108: matplotlib figures coming from the worker.
//
// Two shapes arrive on the same `figure` message:
//   kind 'png'                  — the static fallback
//   kind 'assets'/'new'/'json'/'text' — matplotlib's own webagg protocol
//
// The interactive path drives matplotlib's real mpl.js, so the figure keeps its
// toolbar (home / back / forward / pan / zoom / save / format). mpl.js talks to
// a WebSocket; we hand it an object with the same shape whose send() is a
// postMessage to the worker. That is exactly what ipympl does with a Jupyter
// comm, and what JupyterLite therefore does from a worker kernel.
var mplLoaded  = false;   // mpl.js evaluated into the page
var mplFigures = {};      // figureId -> { fig, socket }
// Bumped whenever that set is torn down. A resize debounced before the bump
// must not fire after it: worker figure ids are REUSED (`fig1` every run), so a
// request left over from the last run would be applied to the NEW run's
// manager, resizing a figure the student never touched. Checking the
// generation rather than the id is what makes that safe on every teardown path,
// including ones added later -- which is why both sites go through
// resetMplFigures() instead of assigning mplFigures directly.
var mplGeneration = 0;
function resetMplFigures() {
  mplFigures = {};
  mplGeneration++;
}

function ensureMplAssets(msg) {
  if (mplLoaded) return true;
  try {
    if (msg.css) {
      var style = document.createElement('style');
      style.textContent = msg.css;
      document.head.appendChild(style);
    }
    // mpl.js is a classic script that defines a global `mpl`.
    (0, eval)(msg.js);
    mplLoaded = (typeof window.mpl !== 'undefined' && typeof window.mpl.figure === 'function');

    // mpl.js asks the embedder to resolve toolbar icon URLs. Upstream webagg
    // has a Tornado server for that; here the icons arrive as data URIs from
    // the worker's own matplotlib, so they can never mismatch the toolbar.
    if (mplLoaded) {
      var images = {};
      try { images = JSON.parse(msg.images || '{}'); } catch (e) { images = {}; }
      // Pyodide's mpl.js does:
      //   mpl.toolbar_image_callback(image).toJs({create_pyproxies:false})
      //   new Blob([bytes], {type:'image/png'})
      // i.e. it expects a PyProxy of raw bytes, because upstream the callback is
      // a Python function. Hand it a plain object with the same .toJs() shape —
      // no Pyodide on this side of the channel, and none needed.
      window.mpl.toolbar_image_callback = function(name) {
        var key = String(name || '').replace(/\.png$/, '');
        var b64 = images[key] || '';
        var binary = window.atob(b64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
        return { toJs: function() { return bytes; } };
      };
    }
  } catch (e) {
    mplLoaded = false;
  }
  return mplLoaded;
}

// A WebSocket-shaped object over the worker channel. mpl.js only ever uses
// binaryType, onopen, onmessage, close and send.
// Coalesce resize requests to the last size seen in a 150 ms window. With
// readyState set, mpl.js's ResizeObserver fires once per animation frame during
// a drag, and each request costs the worker a full Agg render plus a PNG encode
// -- measured at hundreds of milliseconds each. Undebounced, one drag queues
// dozens of renders the student then waits out. Trailing, not leading: the size
// that matters is the one the pointer stopped at.
function debounceMplResize() {
  if (!window.mpl || !window.mpl.figure || window.mpl.figure.prototype.__trinketResizeDebounced) return;
  var orig = window.mpl.figure.prototype.request_resize;
  window.mpl.figure.prototype.request_resize = function(w, h) {
    var fig = this;
    var gen = mplGeneration;
    clearTimeout(fig.__trinketResizeTimer);
    fig.__trinketResizeTimer = setTimeout(function() {
      fig.__trinketResizeTimer = null;
      // Torn down while we waited. Drop it rather than send it: see
      // mplGeneration. 150 ms is short, but "drag the corner, then hit Run"
      // is an ordinary thing to do and lands inside it.
      if (gen !== mplGeneration) return;
      orig.call(fig, w, h);
    }, 150);
  };
  window.mpl.figure.prototype.__trinketResizeDebounced = true;
}

function makeMplSocket(figureId) {
  return {
    binaryType : 'arraybuffer',
    // mpl.js gates the resize on this and NOTHING else does: its ResizeObserver
    // ends in `if (fig.ws.readyState == 1 && width != 0 && height != 0)` before
    // calling request_resize. `undefined == 1` is false, so dragging the
    // figure's corner never told Python anything -- the container grew, the
    // canvas grew, and the figure kept rendering at its old size.
    //
    // Nothing else in mpl.js checks it, which is exactly why every OTHER event
    // worked: send_message has no such gate, so clicks, motion and draws all
    // arrived while resize alone was dropped. Pyodide's own main-thread
    // MockJsWebSocket sets readyState = 1 in its onopen setter, which is why
    // the main thread never had this bug.
    readyState : 1,
    onopen     : null,
    onmessage  : null,
    close      : function() {},
    send       : function(payload) {
      // Pyodide's mpl.js hands the socket an OBJECT, not a JSON string —
      // upstream that socket is a Python object, so no serialisation happens on
      // the JS side. Normalise here so the worker always parses a string.
      var content = (typeof payload === 'string') ? payload : JSON.stringify(payload);
      if (workerClient && workerClient.sendMplEvent) {
        workerClient.sendMplEvent(figureId, content);
      }
    }
  };
}

// Pyodide's matplotlib wheel ships web_backend/js and /css but NO images
// directory, so every mpl.toolbar_image_callback lookup returns zero bytes and
// each toolbar button renders as a broken image with its alt text. Trinket
// already loads Font Awesome for its own toolbar, so use that: same icons the
// rest of the UI uses, nothing extra to ship, and no dependency on assets the
// wheel does not contain.
var MPL_TOOLBAR_ICONS = {
  home         : 'fa-home',
  back         : 'fa-arrow-left',
  forward      : 'fa-arrow-right',
  move         : 'fa-arrows',
  zoom_to_rect : 'fa-search-plus',
  filesave     : 'fa-floppy-o',
  download     : 'fa-download'
};

function applyMplToolbarIcons(fig) {
  if (!fig || !fig.buttons || !window.mpl || !window.mpl.toolbar_items) return;
  window.mpl.toolbar_items.forEach(function(item) {
    var name  = item[0];          // 'Home', 'Pan', …  keys of fig.buttons
    var image = item[2];          // 'home', 'move', … the missing icon name
    if (!name || !image) return;
    var button = fig.buttons[name];
    if (!button) return;

    var cls = MPL_TOOLBAR_ICONS[image];
    if (!cls) return;

    var img = button.querySelector('img');
    var icon = document.createElement('i');
    icon.className = 'fa ' + cls;
    icon.setAttribute('aria-hidden', 'true');
    if (img) {
      button.title = button.title || img.alt || name;   // keep the tooltip
      button.replaceChild(icon, img);
    } else {
      button.appendChild(icon);
    }
  });
}

// --- Worker VPython: page host for the vpython-jupyter front-end -----------
//
// The page half of the `scene-ops` stream (spec 2026-08-10). vpython's
// trinket_worker transport, running in the worker, emits glowcomm-format
// packages; createGlowFrontend — the port that LIVES IN vpython-jupyter and
// knows nothing about trinket — turns them into GlowScript objects. This shim
// owns the three things the front-end deliberately does not: the DOM the scene
// lives in, the pacing clock the transport is built around, and the generation
// counter that tells a live scene from a torn-down one.
var GLOWCOMM_HOST_SRC = '/components/vpython-worker/glowcomm_host.js';
var SCENE_PACE_MS     = 33;    // glowcomm.js's canvas_update rate
var SCENE_DRAIN_MS    = 500;   // how long the clock keeps running past the run's end

var vpythonFrontend        = null;  // the front-end for the CURRENT generation
var vpythonFrontendLoading = null;  // memoized glow + glowcomm_host.js load
var vpythonGeneration      = 0;     // bumped by resetVPythonScene, every run
var vpythonPacer           = null;  // the trigger loop
var vpythonDrainTimer      = null;  // its post-run wind-down
var vpythonSceneFailed     = false; // report a broken scene once, not 30×/second
var vpythonUnsolicited     = 0;     // packages the program pushed since the last tick

// Read by the browser specs, like window.__trinketRuntime: the live generation,
// how many packages were rendered vs. dropped as stale, and the front-end itself
// (whose _objs() is how a test sees whether a package actually landed). Nothing
// on the page consumes it — it is the only observable the generation contract
// and the render path have.
window.__vpythonScene = { generation: 0, handled: 0, dropped: 0, frontend: null };

// The transport is request/reply: it flushes buffered updates only when the host
// pings it (or when rate() flushes from inside the program), exactly as
// glowcomm.js drives the Jupyter kernel from the browser's canvas_update timer.
// Without this clock a program that never calls rate() — any static scene —
// would build its objects in Python and never draw a single one.
//
// The clock belongs to the RUN, not to the scene. It is a polling loop against
// another thread, so leaving it on for a finished program costs 30 worker round
// trips a second for as long as the tab is open, and buys nothing: orbiting the
// camera is glow's own work on this thread, and trinket_worker._dispatch answers
// every event we send with a flush — so a live scene needs a ping only when there
// is actually something to say, which is exactly when we are already sending.
// TWO CLOCKS. There are two things that can make the worker flush: this pacer,
// and rate() inside the student's own loop (trinket_worker._async_rate triggers
// a render up to rate_control.MAX_RENDERS=60 times a second). While an animation
// is running the second one is doing the whole job, and the handshake this timer
// sends is pure packet overhead on the hottest path in the system — measured at
// 91 host messages against 254 packages over three seconds, i.e. ~36% of the
// traffic buying nothing.
//
// It is NOT redundant the rest of the time: a static scene, and every event
// after a program has ended, arrive only because this clock asked. So the pacer
// asks only while nothing is flushing on its own, and while the program IS
// flushing it does the half of a tick that is still needed — send the browser's
// queued events and any camera/mouse change, and otherwise stay quiet.
//
// "Flushing on its own" is not guessed from message rates: the kernel marks
// every package `solicited`, false when the send did not happen inside a
// scene-event dispatch (pyodide-worker.js). Without that flag the signal would
// be circular — the transport answers EVERY trigger we send with a flush, so
// inbound traffic alone can never distinguish a busy program from our own echo.
function startVPythonPacer() {
  if (vpythonPacer) return;
  vpythonUnsolicited = 0;
  vpythonPacer = setInterval(function() {
    if (!workerClient) { stopVPythonPacer(); return; }
    var selfFlushing = vpythonUnsolicited > 0;
    vpythonUnsolicited = 0;
    // The page owns WHEN a tick happens; the front-end owns WHAT is in it —
    // mouse position, camera state the student orbited to, and any events
    // queued since the last tick (Task 9). fe.tick() sends through the same
    // `send` this shim gave it, so the wire is unchanged for a still scene: a
    // bare {event:'update_canvas', trigger:1}. Before the front-end exists (the
    // first ticks of a cold run, while glow is still loading) the page sends
    // that handshake itself so the transport's request/reply rhythm never stops.
    if (vpythonFrontend) {
      if (selfFlushing) vpythonFrontend.poll();
      else vpythonFrontend.tick();
    } else if (!selfFlushing) {
      workerClient.sendSceneEvent('[{"trigger":1}]');
    }
  }, SCENE_PACE_MS);
}

function stopVPythonPacer() {
  if (vpythonPacer) { clearInterval(vpythonPacer); vpythonPacer = null; }
  if (vpythonDrainTimer) { clearTimeout(vpythonDrainTimer); vpythonDrainTimer = null; }
  // TELL the front-end, rather than leaving it to infer from how long ago the
  // last tick was. The inference has a window: an event arriving in the ~100 ms
  // after the final tick still looks like it has a tick coming, so it waits for
  // one that will never happen. Only the page knows the clock is gone.
  if (vpythonFrontend) { try { vpythonFrontend.pacingStopped(); } catch (e) {} }
}

// The run has settled (finished, or failed). Wind the clock down: keep ticking
// briefly, because the objects a program created in its final moments are still
// sitting in the transport's buffer, and only a ping gets them out. Then stop
// for good.
//
// The drain is unconditional, deliberately. An earlier version skipped it when
// nothing had come back yet, to avoid pinging a worker whose wheel install had
// failed — but "nothing back yet" is not a reliable sign of a broken run, and
// getting it wrong deadlocks the scene rather than the reverse. Draining
// regardless costs a failed run ~15 no-op messages and orphans nothing.
function finishVPythonPacing() {
  if (!vpythonPacer || vpythonDrainTimer) return;
  vpythonDrainTimer = setTimeout(function() {
    vpythonDrainTimer = null;
    stopVPythonPacer();
  }, SCENE_DRAIN_MS);
}

// Say, once, what this page is actually serving.
//
// `public/components/vpython-worker/` holds build artifacts of ANOTHER
// repository (vpython-jupyter), fetched from a sha256-pinned upstream release
// (Dockerfile ARG block; scripts/sync-vpython-worker.sh for local dev). The
// front-end JS and the Python wheel are two halves of one protocol, and
// nothing at run time checks that they match. The spec's two-repo mitigation
// was "wheel filename carries the version; host shim logs both at boot"; this
// is that line. It turns "is my stack serving what I just built?" into
// something answerable from devtools instead of by unzipping a wheel. Once
// per page: it fires from the memoized loader, not per run.
var vpythonVersionsLogged = false;
function logVPythonVersions() {
  if (vpythonVersionsLogged) return;
  vpythonVersionsLogged = true;
  var fe = window.createGlowFrontend;
  var feVersion = (fe && fe.version) || 'unknown';
  try {
    console.log('[vpython] worker path: front-end ' + feVersion +
                ' (' + GLOWCOMM_HOST_SRC + '), wheel ' + VPYTHON_WHEEL_NAME);
  } catch (e) { /* no console: nothing to do, and nothing to break */ }
}

// Load glow (the main path's loader — same library, same build, one copy) and
// the front-end factory. Memoized; a failure is not cached, so a transient fetch
// error does not poison every later run (see ensureConsoleTransform).
function ensureVPythonFrontendLib() {
  if (vpythonFrontendLoading) return vpythonFrontendLoading;
  vpythonFrontendLoading = ensureGlow().then(function() {
    if (typeof window.createGlowFrontend === 'function') { logVPythonVersions(); return; }
    return new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = GLOWCOMM_HOST_SRC;
      s.onload = function() { logVPythonVersions(); resolve(); };
      s.onerror = function() { reject(new Error('Failed to load the VPython scene renderer.')); };
      document.head.appendChild(s);
    });
  }).catch(function(e) {
    vpythonFrontendLoading = null;
    throw e;
  });
  return vpythonFrontendLoading;
}

// The front-end for the current generation, creating it (and its DOM) on first
// use. The scene gets its own child of #graphic — the same pane matplotlib
// figures use — because resetOutput() empties #graphic on every run, which is
// precisely the "the scene does not survive a run" behaviour we want.
function ensureVPythonFrontend() {
  if (vpythonFrontend) return Promise.resolve(vpythonFrontend);
  var gen = vpythonGeneration;
  return ensureVPythonFrontendLib().then(function() {
    if (vpythonFrontend) return vpythonFrontend;   // a concurrent call got there first

    // A reset raced the one-off glow load — which takes long enough for a student
    // to hit Run again. The caller checks this too, but too late: by then this
    // function has already built the scene's DOM and split the output pane, so a
    // console-only run would open a graphic pane it never uses. Nothing to build.
    if (gen !== vpythonGeneration) return null;

    var holder = document.getElementById('vpython-scene');
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'vpython-scene';
      // Load-bearing: the plot-style adapter's hasFigure() excludes VPython
      // scenes with closest('.glowscript'), matching this CLASS rather than
      // either container's id -- there are two of them and an id check caught
      // only one (#251). A new scene container must carry this class or the
      // matplotlib pill will mount over it.
      holder.className = 'glowscript';
      (document.getElementById('graphic') || document.body).appendChild(holder);
    }
    showGraphic();

    // GlowScript reads its mount point off window.__context. The factory merges
    // into that object when the canvas cmd arrives, but glow's own scratch space
    // (canvas_selected, canvas_all, print_container) has to exist first, and the
    // container has to be the jQuery object glow expects — never a raw element.
    var ctx = window.__context || (window.__context = {});
    ctx.glowscript_container = $(holder);

    vpythonFrontend = window.createGlowFrontend({
      container: holder,
      // Outbound events — mouse and key events, camera state, picks, compound
      // geometry — ride the same channel the pacing trigger does.
      send: function(events) {
        if (workerClient) { workerClient.sendSceneEvent(JSON.stringify(events)); }
      }
    });
    window.__vpythonScene.frontend = vpythonFrontend;
    return vpythonFrontend;
  });
}

// One update package from the worker's vpython transport.
function handleWorkerSceneOps(msg) {
  // Ops from a scene this page has already torn down. A vpython re-run discards
  // the whole interpreter, but terminate() does not un-post what the dying
  // worker already put on the page's message queue, so packages belonging to the
  // previous scene can still arrive after the new one starts; the generation tag
  // is the only thing that distinguishes them. Drop them — drawing them into the
  // new scene would mix two runs' objects.
  if ((msg.generation | 0) !== vpythonGeneration) {
    window.__vpythonScene.dropped++;
    return;
  }

  // The program flushed this one itself (rate()), rather than it being the reply
  // to a trigger we sent. That is what tells the pacer to get out of the way —
  // see startVPythonPacer. `=== false` and not `!msg.solicited`: an absent flag
  // must mean "keep pacing", the behaviour that was here before the flag was.
  if (msg.solicited === false) { vpythonUnsolicited++; }

  var gen = vpythonGeneration;
  ensureVPythonFrontend().then(function(fe) {
    // A reset raced the library load. (`fe` is null for the same reason — see
    // ensureVPythonFrontend — but check the generation too: a package can also
    // arrive against a front-end built for a scene that has since been replaced.)
    if (!fe || gen !== vpythonGeneration) return;

    // The FIRST package after the transport boots is the bare string "trigger",
    // not an ops object (the eager boot flushes an empty buffer). handle()
    // treats it as the no-op handshake it is.
    var ops = null;
    try { ops = JSON.parse(msg.ops); } catch (e) { return; }
    window.__vpythonScene.handled++;
    fe.handle(ops);
  }).catch(function(e) {
    if (vpythonSceneFailed) return;             // the pacer would repeat this 30×/second
    vpythonSceneFailed = true;
    writeOut('[vpython] the 3D scene could not be drawn: ' +
             ((e && e.message) || e) + '\n');
  });
}

// A scene belongs to ONE run. Called at the start of EVERY run — including
// python3 and ?runtime=main runs, which is the point: a scene must not outlive
// the program that drew it whatever the next program turns out to be. Runs
// before the run message is posted, so the generation the kernel is told is
// already the new one.
function resetVPythonScene() {
  vpythonGeneration++;
  window.__vpythonScene.generation = vpythonGeneration;
  vpythonSceneFailed = false;
  // Drop the reference BEFORE stopping the clock. stopVPythonPacer() flushes the
  // front-end's queue on the way out, which is right when a live scene loses its
  // clock — but not here: these events name idxs from the scene being torn down,
  // and Python's registry (which survives the run) would resolve them against
  // whatever the next generation puts at those idxs.
  var dying = vpythonFrontend;
  vpythonFrontend = null;
  stopVPythonPacer();
  if (dying) {
    try { dying.destroy(); } catch (e) {}
  }
  window.__vpythonScene.frontend = null;
  // Usually already gone — resetOutput() empties #graphic just before this.
  var holder = document.getElementById('vpython-scene');
  if (holder) { holder.innerHTML = ''; }
}

// Restore the interpreter's user-visible namespace to the snapshot captured
// immediately after Pyodide's runner bootstrap. This deliberately keeps the
// loaded interpreter and its cached packages: Clear memory should be quick and
// reliable, not trigger another multi-megabyte Python download.
//
// The function uses default arguments so it retains both dictionaries after
// clearing globals(). A temporary global would disappear halfway through the
// reset along with the student's variables.
function clearMainThreadMemory() {
  if (!pyodide || !pyodideReady) return;
  try {
    pyodide.runPython([
      'def _trinket_restore_namespace(_namespace=globals(), _baseline=__trinket_reset_baseline__):',
      '    _namespace.clear()',
      '    _namespace.update(_baseline)',
      '_trinket_restore_namespace()'
    ].join('\n'));
  } catch (e) {
    // A broken reset must not leave the UI claiming success. The next normal
    // Run still has the existing behavior, and the console gives a useful hint.
    writeOut('[Could not clear Python memory; reload the page to start fresh.]\n');
    return false;
  }

  // A PyodideConsole is a proxy around the same globals dict. Recreate it next
  // time Console is opened so a cleared session cannot retain its old execution
  // state. The jqconsole prompt itself is reset and re-armed by clearMemory():
  // that also covers a worker-backed REPL, where no page-thread Pyodide exists.
  if (pyodideConsole && typeof pyodideConsole.destroy === 'function') {
    try { pyodideConsole.destroy(); } catch (e) {}
  }
  pyodideConsole = null;

  // These globals are established by VPython setup and must be captured again
  // on the next VPython run, now that the ordinary namespace is pristine.
  vpythonBaselineCaptured = false;
  return true;
}

function handleWorkerFigure(msg) {
  var wrap = document.getElementById('graphic');
  if (!wrap) return;

  if (msg.kind === 'assets') { ensureMplAssets(msg); return; }

  if (msg.kind === 'new') {
    // If mpl.js could not be loaded, do nothing here — the worker also emits a
    // static PNG for this figure, so a plot still appears.
    if (!mplLoaded || mplFigures[msg.figureId]) return;

    var host = document.createElement('div');
    host.className = 'worker-figure mpl-figure';
    wrap.appendChild(host);
    showGraphic();

    var socket = makeMplSocket(msg.figureId);
    var fig = new window.mpl.figure(msg.figureId, socket, function(figure, format) {
      // The toolbar's Save button, for the day this mpl.js calls ondownload
      // again. Pyodide 0.28.1's patched build does not: its handle_save posts
      // {type:'save'} over the socket, which is the route the worker now
      // swallows and answers with savefig bytes. So this callback is dead
      // against the build we ship today.
      //
      // It is kept, and made to agree, because the patch is Pyodide's and not
      // ours: a future Pyodide that drops it would silently restore this call.
      // Send the same message the patched build sends, so both routes end at
      // the same savefig. The alternative -- the canvas grab this used to do --
      // silently changes what Save means, since toDataURL ignores savefig.dpi,
      // .transparent and .bbox_inches and returns on-screen pixels at screen
      // dpi. A student who set dpi=300 for a lab report would get 96.
      socket.send({ type: 'save', figure_id: msg.figureId, format: format || 'png' });
    }, host);

    mplFigures[msg.figureId] = { fig: fig, socket: socket };
    applyMplToolbarIcons(fig);
    debounceMplResize();
    if (typeof socket.onopen === 'function') { socket.onopen(); }

    return;
  }

  // The toolbar Save button, rendered in the worker and delivered here (#252).
  // The worker cannot do the delivery itself: Pyodide's patched handle_save
  // builds an <a download> from `document`, which in a worker is the inert stub
  // installed by pyodide-worker.js, so the anchor goes nowhere and the button
  // is a silent no-op. The worker now swallows the save message, renders the
  // bytes, and sends them across for this side to download -- same <a download>
  // shape embed.js already uses, and no form, so the embed CSP contract holds.
  if (msg.kind === 'save') {
    var saved = null;
    try { saved = JSON.parse(msg.data); } catch (e) { saved = null; }
    // Do not fail the way this button used to. A reply this side cannot read is
    // the same experience for the student as the bug being fixed here -- click,
    // nothing -- so it has to say something rather than return quietly.
    if (!saved || !saved.b64) {
      writeOut('[Could not save the figure: the worker sent a reply this page could not read.]\n');
      return;
    }
    // Blob + object URL, not a data: URL -- mirroring the download at
    // embed.js:795. raw and tif run to ~1.2 MB, so a base64 data: URL would be
    // ~1.6 MB of URL, which browsers treat inconsistently, and the embed CSP
    // permits `data:` for img-src only. An object URL has no such length, and
    // the anchor goes into the DOM before the click because a detached one is
    // not reliable everywhere either.
    var bytes;
    try {
      var raw = atob(saved.b64);
      bytes = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) { bytes[i] = raw.charCodeAt(i); }
    } catch (e) {
      writeOut('[Could not save the figure: the image data did not decode.]\n');
      return;
    }

    // octet-stream, not the format's own MIME: a Save button should download
    // every format, not preview the ones the browser happens to render.
    // Constrain the extension rather than trusting the reply. MPL_SETUP and the
    // student's own program are both run with no `globals` option, so they share
    // pyodide.globals -- which means student Python can call _trinket_mpl_send
    // itself and choose this string. Nothing dangerous follows from that (the
    // file lands on their own machine), but `download` should not take an
    // arbitrary value, and every format the toolbar offers is four characters
    // of lowercase alphanumerics or fewer.
    var fmt = String(saved.format || 'png').toLowerCase();
    if (!/^[a-z0-9]{1,5}$/.test(fmt)) { fmt = 'png'; }

    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    var dl  = document.createElement('a');
    dl.href = url;
    dl.download = 'plot.' + fmt;
    document.body.appendChild(dl);
    dl.click();
    document.body.removeChild(dl);
    setTimeout(function() { URL.revokeObjectURL(url); }, 0);
    return;
  }

  // A save that raised in the worker. Say so rather than failing the way this
  // button used to -- silently.
  if (msg.kind === 'save-error') {
    writeOut('[Could not save the figure: ' + msg.data + ']\n');
    return;
  }

  if (msg.kind === 'json' || msg.kind === 'text') {
    var entry = mplFigures[msg.figureId];
    if (entry && typeof entry.socket.onmessage === 'function') {
      entry.socket.onmessage({ data: msg.data });
    }
    return;
  }

  if (msg.kind === 'png') {
    // Fallback: only paint the static image if the interactive frontend never
    // came up, so a working toolbar is not replaced by a flat picture.
    if (mplLoaded && Object.keys(mplFigures).length) return;
    var img = document.createElement('img');
    img.className = 'worker-figure';
    img.style.maxWidth = '100%';
    img.src = 'data:image/png;base64,' + msg.data;
    wrap.appendChild(img);
    showGraphic();
  }
}

// `decision` is the runtime-router result for this program; `decision.vpython`
// marks the opt-in worker VPython path so the kernel can install the wheel.
function runInWorker(program, files, serialized, decision) {
  workerRunError = null;
  resetMplFigures();            // figures belong to a run; mpl.js itself persists
  ensureWorkerClient();

  // A VPython run starts from a FRESH INTERPRETER (spec V7a).
  //
  // This is the HOST'S semantics, not a workaround: Jupyter, Colab and VS Code
  // keep a kernel alive between cell runs, and Web VPython and trinket do not —
  // pressing Run here means "run this program from the top", and there is no
  // persistent namespace for a student to reason about. vpython's
  // `scene = canvas()` at import time only makes that unavoidable: on a warm
  // worker the import is already done, so run 2's objects attach to run 1's
  // canvas, which the page tore down when it bumped the generation, and run 2
  // draws nothing at all (measured before this line existed: generation 2, 53
  // packages handled by the page across both runs, zero objects in the scene).
  //
  // The cost is a cold start per run: a Pyodide boot, loadPackage('numpy',
  // 'micropip'), and unpacking/installing the wheel. ~4 s on the dev stack.
  // MEASURED, because the obvious guess is wrong: Pyodide's own artifacts (2.4 MB
  // stdlib, 2.7 MB wasm, 3.1 MB numpy) come from jsdelivr and are served from the
  // browser cache on run 2, but OUR wheel is refetched in full — all 3,516,355
  // bytes — because app.js:65 puts `no-store` on every response trinket sends.
  // It carries an etag, so exempting /components/ from that blanket policy would
  // make it a 304. See the spec (V7a) for that and the standby-worker lever.
  // python3 runs never take this branch.
  if (decision && decision.vpython) {
    runningIsWorkerVPython = true;   // Run-while-running restarts this; see runCode()
    var hadInterpreter = workerClient.discardWorker();
    // ...and if the student had a console session in that interpreter, its
    // variables have just gone. stopCode() says so when Stop discards the
    // interpreter; a Run that discards it owes the same explanation, or `x` is
    // simply undefined at the next prompt for no visible reason. resetOutput()
    // has already cleared the console, so this is the first line they see.
    //
    // replUsesWorker() is the third condition and it is not redundant:
    // `replActive` only means a prompt is up, and the REPL follows
    // `workerRuntime`, NOT `workerVPython` (see replUsesWorker). With
    // workerVPython on and workerRuntime off the console session lives in the
    // page's own pyodide.globals, which this discard does not touch — so the
    // message would tell the student their session was reset when it was not.
    // A false statement in the console is worse than no statement.
    if (hadInterpreter && replActive && replUsesWorker()) {
      writeOut('[console session reset — a VPython run starts a fresh interpreter]\n');
    }
  }

  // Completed by the client's onReady callback when the worker finishes booting
  // Pyodide (#27). This path never had the completion — it was added after the
  // original fix, so it inherited the dangling ellipsis rather than the fix.
  openRuntimeLine('Loading Python (Pyodide)… ');

  // The worker cannot see the page, so it cannot know how wide the graphic pane
  // is. Pyodide's patched FigureManagerWebAgg ignores mpl.js's `resize` message
  // (the same gap that makes it ignore `supports_binary`), so the size has to be
  // set in Python BEFORE the figure is created — hence sending it here.
  // #graphic is still HIDDEN at this point (showGraphic() runs when the first
  // figure arrives), so its clientWidth is 0. Measure a visible ancestor.
  var graphicWidth = 0;
  ['graphic', 'outputContainer', 'codeOutput'].forEach(function(id) {
    if (graphicWidth) return;
    var el = document.getElementById(id);
    if (el && el.clientWidth) { graphicWidth = el.clientWidth; }
  });
  if (!graphicWidth) { graphicWidth = Math.round(window.innerWidth / 2); }

  // Start the pacing clock BEFORE the run: the transport only flushes when the
  // host pings it, so the clock has to exist before there is anything to flush.
  //
  // Every vpython run now boots its own interpreter, so the transport's eager
  // boot handshake does arrive unprompted on every run and the clock could in
  // principle be started by it instead. It is not, for two reasons: the boot
  // flush is the only unprompted one — everything after it needs a ping, so a
  // handshake lost to a race would strand the whole scene — and a run whose
  // wheel install FAILS never sends anything at all, which would leave the page
  // waiting on a signal that is not coming. Pings that arrive before the
  // transport exists are dropped in the worker, by design (createSceneChannel).
  if (decision && decision.vpython) { startVPythonPacer(); }

  return workerClient.run(program, files, {
    graphicWidth: graphicWidth,
    vpython: !!(decision && decision.vpython),
    wheelUrl: '/components/vpython-worker/' + VPYTHON_WHEEL_NAME,
    // resetVPythonScene() bumped this in startRun, before we got here.
    sceneGeneration: vpythonGeneration
  }).then(function() {
    // Resolves on success AND on error (worker-client settles both), which is
    // what we want: a wheel that failed to install must not leave the clock
    // ticking at a worker that has no transport to answer it.
    finishVPythonPacing();
    // finishRun() consumes rerunQueued and may start the next run SYNCHRONOUSLY,
    // so read it first. A restart (Run clicked during a live animation) must not
    // then snapshot: by the time the reply came back it would be describing the
    // NEW run's half-built namespace, and it would be asking a worker that is
    // busy booting.
    var restarting = rerunQueued;
    finishRun(serialized, workerRunError);
    if (restarting) return;

    // finishRun() takes the MAIN-THREAD namespace snapshot, which is empty here
    // because this page's Pyodide never ran the program. Ask the worker instead
    // and render when it answers — it resolves after finishRun, so it wins.
    if (variableExplorerEnabled()) {
      workerClient.snapshot().then(function(vars) {
        try { renderVariables(vars); } catch (e) {}
      });
    }
  });
}

function finishRun(serializedCode, err) {
  $('.stop-it').addClass('hide');
  running = false;
  // The run's last output must be on screen before anything reads the console:
  // readyForSnapshot below invites a thumbnail capture, and a queued flush would
  // land after it.
  flushConsoleNow();
  window.readyForSnapshot = true;

  if (window.parent) {
    window.parent.postMessage("complete", "*");
  }

  if (typeof api.collectErrorData === 'function') {
    api.collectErrorData(serializedCode, err ? (err.message || err.toString()) : undefined);
  }

  // Refresh the Variables panel with the post-run namespace snapshot. Runs on
  // both success and error so partial state is still visible. Never let a
  // snapshot failure break run completion. Skipped when the explorer is off.
  if (variableExplorerEnabled()) {
    try { renderVariables(snapshotVariables()); } catch (e) {}
  }

  // Refresh the plot-style panel against the figure this run left behind.
  // Skipped when a rerun is queued: startRun() below runs synchronously and
  // sets running = true, which the panel's backend would then refuse.
  if (!rerunQueued && window.trinketPlotpolish) {
    try { trinketPlotpolish.afterRun(window.__trinketRuntime); } catch (e) {}
  }

  // The panel's "is there anything to step?" answer can change with a run --
  // and the FIRST run is half of the answer (slice 2's trigger rule).
  debugHasRunOnce = true;
  // The panel's "is there anything to step?" answer can change with a run.
  if (window.trinketDebugPanel) {
    try { trinketDebugPanel.afterRun(window.__trinketRuntime); } catch (e) {}
  }

  // A Run was clicked while the previous (VPython) run was being cancelled;
  // now that it has stopped, start the fresh run.
  if (rerunQueued) {
    rerunQueued = false;
    startRun();
  }
}

function runCode() {
  $('.reveal-modal').foundation('reveal', 'close');

  // A step-through recording is in flight (its async pre-exec phases —
  // Pyodide load, package fetch — leave `running` false). Starting a normal
  // run now would interleave the two pipelines: double FS sync, matplotlib
  // target contention, console writes mixed into the recorded output offsets.
  if (debugRecording) return;

  if (running) {
    // A run is already in flight. For a VPython program (which yields at rate())
    // request cancellation and queue a fresh run, so clicking Run restarts a
    // running animation. For anything else keep the old behavior (ignore).
    if (runningIsVpython) {
      setCancelRequested(true);
      rerunQueued = true;
      return;
    }

    // The same promise for the WORKER VPython path, by the mechanism that path
    // already uses. This is the shape the whole feature exists for: a VPython
    // program is `while True: rate(60)`, it never ends, and a student edits a
    // number and hits Run. Without this, Run does nothing until they think to
    // press Stop first — and on the main-thread bridge the same click restarts.
    //
    // Not cooperative cancellation: there is nothing to cancel cooperatively,
    // because a worker run is killed by terminate(). discardWorker() IS the
    // restart — it settles the in-flight run, whose completion handler sees
    // rerunQueued and starts the fresh one, and the next run was going to
    // discard the interpreter anyway (V7a). Deliberately vpython-only:
    // Run-while-running is ignored for python3 worker runs exactly as it is on
    // the main thread, and nothing here changes that.
    if (runningIsWorkerVPython && workerClient && workerClient.isRunning()) {
      rerunQueued = true;
      workerClient.discardWorker();
    }
    return;
  }

  startRun();
}

function startRun() {
  setCancelRequested(false);
  // Offer Stop while the program runs. Cancellation only lands at a yield point
  // (rate()/time.sleep()); stopCode() tells the student when there isn't one.
  $('.stop-it').removeClass('hide');
  rerunQueued = false;
  runningIsVpython = false;
  runningIsWorkerVPython = false;

  if (window.parent) {
    window.parent.postMessage("started", "*");
  }

  var serializedCode = api.getValue();

  initConsoleOutput();
  resetOutput();
  $('#console-output').removeClass('console-mode');

  // resetOutput() has just destroyed the graphic pane's contents, so any worker
  // VPython scene from the previous run is now a detached DOM node with a live
  // render loop. Tear it down and take the next generation — unconditionally,
  // because a stale scene must not survive a run that isn't VPython at all (or
  // that escaped to the main thread with ?runtime=main) either.
  resetVPythonScene();

  // Default to a console-only layout each run; showGraphic() re-splits the pane
  // when the code uses matplotlib.
  $('#graphic-wrap').addClass('hide');
  $('#output-dragbar').addClass('hide');
  $('#console-wrap').css('height', '100%');

  // #108: choose a runtime for THIS program. VPython and programs the async
  // transform cannot rewrite stay on the main thread; everything else runs in
  // the worker, where Stop is worker.terminate() and cannot be blocked.
  //
  // Route on the PROGRAM TEXT, not on serializedCode: api.getValue() returns the
  // serialized file list (a JSON string), so usesVPython() asked about it never
  // matches and every VPython program would be sent off-thread, where its
  // `from js import sphere, …` bridge cannot exist.
  var workerFiles   = editor.getAllFiles();
  var workerProgram = workerFiles[mainFile] || '';

  var queryRuntime = (api._queryString || {}).runtime;

  // #128: the trinket's own setting — see getStoredRuntime() above for why
  // api._trinket (not window.trinket) and why it's whitelisted client-side too.
  var decision = runtimeRouter.chooseRuntime(workerProgram, {
    usesVPython   : usesVPython(workerProgram),
    workerEnabled : !!(window.trinket && window.trinket.config && window.trinket.config.workerRuntime),
    workerVPython : !!(window.trinket && window.trinket.config && window.trinket.config.workerVPython),
    queryRuntime  : queryRuntime,
    storedRuntime : getStoredRuntime()
  });
  window.__trinketRuntime       = decision.runtime;   // read by the browser specs
  window.__trinketRuntimeReason = decision.reason;

  // Say which runtime this program got, before the loading line that looks the
  // same either way. Empty for the ordinary main-thread run — see runtimeNotice.
  var notice = runtimeRouter.runtimeNotice(decision, queryRuntime);
  if (notice) writeOut(notice);

  if (decision.runtime === 'worker') {
    running = true;
    return runInWorker(workerProgram, workerFiles, serializedCode, decision);
  }

  if (!pyodideReady) {
    openRuntimeLine('Loading Python (Pyodide)… ');
  }

  running = true;

  ensurePyodide().then(function() {
    closeRuntimeLine();   // "…" -> "… ready" (#27)
    var prog = syncFilesToFS(editor.getAllFiles(), mainFile);

    // Make time.sleep() a cancellation point so Stop can unwind a sleeping loop
    // (#108). Idempotent and installed once per interpreter; failure here must
    // never prevent the program from running.
    try { pyodide.runPython(SLEEP_CANCEL_CODE); } catch (e) {}

    // VPython/GlowScript programs take a separate path: glow library + the
    // vpython bridge + async rewriting, rendering 3D into the graphic pane.
    if (usesVPython(prog)) {
      runningIsVpython = true;  // mark cancellable so Run-while-running restarts
      return runVpython(prog);
    }

    // No "Loading packages…" line of our own: Pyodide narrates installs itself
    // with "Loading numpy…" then "Loaded numpy", which already reads as
    // complete. Ours added a second ellipsis that nothing ever closed (#27).

    // Auto-install any Pyodide-bundled packages the code imports (numpy,
    // matplotlib, pandas, …) from the CDN before running.
    return pyodide.loadPackagesFromImports(prog).then(function() {
      if (usesMatplotlib(prog)) {
        // Point matplotlib's canvas backend at the trinket graphic pane, then
        // select that backend before the user's code imports pyplot.
        window.document.pyodideMplTarget = document.getElementById('graphic');
        showGraphic();
        return pyodide.runPythonAsync(MATPLOTLIB_SETUP_CODE).then(function() {
          return runProgram(prog);
        }).then(function(result) {
          // Notebook-style auto-display: show any figure the program left
          // open. #254 — this used to ask the DOM "did anything render?" via
          // g.querySelector('canvas') and skip if so, which is a different
          // question from "has every open figure been shown". A program that
          // called show() and THEN created a second figure rendered only the
          // first, because the guard saw the first one's canvas and returned.
          // Measured: get_fignums() == [1, 2], one figure on the page.
          //
          // No guard is needed now. show() is idempotent per figure (see
          // MATPLOTLIB_SETUP_CODE), so figures already on the page redraw in
          // place instead of double-plotting, and this call is also what
          // picks up edits made after the student's own show().
          return pyodide.runPythonAsync(
            "import matplotlib.pyplot\n" +
            "if matplotlib.pyplot.get_fignums():\n" +
            "    matplotlib.pyplot.show()\n"
          ).then(function() { return result; });
        });
      }
      if (usesConsole(prog) && !userShadowsConsole()) {
        return ensureConsoleTransform().then(function() {
          pyodide.globals.set('__user_source__', prog || '');
          var asyncProg = pyodide.runPython(
            // Clear memory restores the bootstrap namespace, so this import is
            // intentionally repeated instead of depending on the one global
            // transform_source name created when the helper was first loaded.
            'from _trinket_async_transform import transform_source\n' +
            'transform_source(__user_source__)');
          return runProgram(asyncProg, prog);
        });
      }
      return runProgram(prog);
    });
  }).then(function(result) {
    renderRichResult(result);
    finishRun(serializedCode);
  }).catch(function(err) {
    // Intentional cancellation (Run clicked mid-run): unwind quietly, then
    // finishRun starts the queued re-run.
    if (isCancelError(err)) {
      finishRun(serializedCode);
      return;
    }
    // Python exceptions reject with a PythonError whose message is the traceback.
    // Show the student THEIR frames, not the runtime's (see formatPythonTraceback).
    var msg = (err && (err.message || err.toString())) || 'Error';
    if (jqconsole) {
      consoleWrite('\n' + escapeConsoleHtml(formatPythonTraceback(msg, mainFile)) + '\n', 'jqconsole-error', false);
    }
    // collectErrorData below still receives the RAW error: telemetry wants the
    // full stack, only the human-facing console is trimmed.
    finishRun(serializedCode, err);
  });

  if (typeof api.markCodeAsRun === 'function') {
    api.markCodeAsRun(serializedCode);
  }
  if (typeof api.updateMetric === 'function') {
    api.updateMetric('runs', serializedCode);
  }
}

function stopCode() {
  // `running` is set by startRun() for a program. A REPL statement never sets
  // it, but a worker-backed statement IS executing and must be stoppable — that
  // is the whole point of moving the REPL off-thread.
  if (!running && !(workerClient && workerClient.isRunning())) return;

  // A worker-routed run is stopped by terminating the worker. Unconditional, and
  // the only thing that can stop `while True: pass` — so none of the cooperative
  // machinery below applies, and there is no "cannot be stopped" case to warn
  // about.
  if (workerClient && workerClient.isRunning()) {
    rerunQueued = false;             // Stop means stop, not restart
    workerClient.stop();

    // The interpreter is gone, so there is nothing left to ping: stop the clock
    // but leave the scene on the page. A stopped VPython program freezes where
    // it stood rather than vanishing — the student can still look at it (and
    // orbit it: rotation is glow's, on this thread).
    stopVPythonPacer();

    // Terminating discards the interpreter, so there is no post-run namespace.
    // With the explorer on, an empty table would read as "your program defined
    // nothing" — say why instead, in the console the student is already reading.
    // (#debug-note belongs to the step debugger, which may not be enabled.)
    // The MESSAGE is gated on replUsesWorker(), not on `replActive` alone: a
    // prompt being up does NOT mean the session lives in the worker we just
    // killed. The REPL follows `workerRuntime`, while a VPython run reaches this
    // branch under `workerVPython` — so in the workerVPython-only config the
    // console session is in the page's own pyodide, untouched by terminate(),
    // and telling the student it was reset would be false.
    if (replActive && replUsesWorker()) {
      // Terminating discards the interpreter, so the console session's variables
      // are gone. Say so rather than letting a student wonder why `x` vanished.
      writeOut('\n[stopped — console session reset]\n');
    } else if (variableExplorerEnabled()) {
      writeOut('\n[stopped — variables unavailable, the interpreter was discarded]\n');
      try { renderVariables([]); } catch (e) {}
    } else {
      writeOut('\n[stopped]\n');
    }

    // The PROMPT comes back regardless of which of those was printed, and this
    // is deliberately NOT gated the way the message is. resetOutput() calls
    // jqconsole.Reset() at the start of every run, which kills the armed prompt,
    // and this is the only site that re-arms one afterwards (a normal completion
    // has no re-arm at all). Gating it would leave a page-hosted REPL — the case
    // where the session genuinely survived — with no prompt and no way back:
    // the Console menu entry is `if (!replActive) startRepl()` and `replActive`
    // is never cleared anywhere, so re-selecting Console is a no-op and only a
    // reload recovers. Re-arming is most honest exactly where the message is
    // wrong: the session really is still there.
    if (replActive) startReplPrompt();
    return;                          // the run promise settles and calls finishRun()
  }

  // Cooperative cancellation: request it, and the program unwinds at its next
  // yield point — rate() for VPython (installRateCancellation) or time.sleep()
  // (SLEEP_CANCEL_CODE). Nothing is torn down, so the editor keeps its content.
  setCancelRequested(true);
  rerunQueued = false;               // Stop means stop, not restart
  writeOut('\n[stopping…]\n');

  // A loop with NO yield point (while True: pass, or print-only) never returns
  // to the event loop, so this click could only have been delivered if the
  // program yields somewhere. If it doesn't, say so rather than leaving the
  // student staring at "stopping…" forever. See issue #108: interrupting that
  // case needs Pyodide in a Worker.
  setTimeout(function() {
    if (running && cancelRequested) {
      writeOut('[this program has no pause point (no sleep/rate), so it cannot be '
             + 'stopped — reload the page to recover]\n');
    }
  }, 3000);
}

(function() {
  // prevent backspace from going back in browser history
  var inputTypes = /^(input|text|password|file|email|search|date)$/i;
  $(document).bind('keydown', function (event) {
    var doPrevent = true, d;
    if (event.keyCode === 8) {
      d = event.srcElement || event.target;
      if (d.tagName.toLowerCase() === 'textarea' || (d.tagName.toLowerCase() === 'input' && d.type.match(inputTypes))) {
        doPrevent = d.readOnly || d.disabled;
      }
      if (doPrevent) {
        event.preventDefault();
      }
    }
  });
})();

window.TrinketAPI = {
  initialize : function(trinket) {
    api   = this;
    start = $('#start-value').val();
    runOption   = $('#runOption-value').val();
    api.runMode = $('#runMode-value').val();
    autoRun = (start === 'result') && !$('body').hasClass('has-status-bar');

    var assetsEnabled = window.trinket && window.trinket.config && window.trinket.config.assetsEnabled;
    var assets   = assetsEnabled ? (trinket.assets ? trinket.assets.slice() : []) : false;
    var uiType   = api.getUIType();

    editor = $('#editor').codeEditor({
        showTabs             : !this._queryString.outputOnly
      , noEditor             : !!this._queryString.outputOnly
      , disableAceEditor     : disableAceEditor
      , tabSize              : window.userSettings && window.userSettings.pythonTab || 2
      , lineWrapping         : window.userSettings && window.userSettings.lineWrapping || false
      , mainFileName         : mainFile
      , showInfo             : true
      , assets               : assets
      , addFiles             : true
      , guest                : uiType === 'guest'
      , owner                : uiType === 'owner'
      , canHideTabs          : api.hasPermission('hide-trinket-files')
      , canAddInlineComments : api.hasPermission('add-trinket-inline-comments') && (uiType === 'owner' || api.assignmentFeedback)
      , assignmentViewOnly   : api.assignmentViewOnly
      , userId               : api.getUserId()
      , lang                 : 'python'
    }).data('trinket-codeEditor');

    $('#console-output').click(function() {
      if (jqconsole && (jqconsole.GetState() === 'input' || jqconsole.GetState() === 'prompt')) {
        jqconsole.Focus();
      }
    });

    $(document).on('sk.system.clear', function() {
      resetOutput(true);
    });
    $('#reset-output').click(function() {
      resetOutput(true);
    });

    // Variables tab. Wired locally (not through the shared embed tab framework)
    // so the explorer stays Pyodide-only and other trinket types are untouched.
    // Switching to Result/Instructions hides the panel via their tab clicks.
    // Only wired when the explorer is enabled (the template omits the markup
    // otherwise, but skipping the bindings avoids dead handlers).
    if (variableExplorerEnabled()) {
      $('#variablesTab').on('click keydown', function(e) {
        if (e.type === 'keydown' && e.which !== 13 && e.which !== 32) return;
        e.preventDefault();
        showVariables();
      });
      $('#codeOutputTab, #instructionsTab').on('click', function() {
        hideVariables();
      });

      // Phase 2: re-render in place when the functions/classes toggle changes; no
      // re-run needed since the last snapshot is cached.
      $('#variables-show-callables').on('change', function() {
        showCallables = $(this).is(':checked');
        paintVariables();
      });

      // Copy a variable's repr; brief check-mark feedback.
      $('#variables-table').on('click', '.var-copy', function() {
        var $btn = $(this);
        copyToClipboard($btn.closest('td').find('.var-value-text').text());
        var $i = $btn.find('i');
        $i.removeClass('fa-clone').addClass('fa-check');
        setTimeout(function() { $i.removeClass('fa-check').addClass('fa-clone'); }, 900);
      });

      // Phase 3: expand/collapse a container row to inspect one level of its
      // children (lazily fetched from the live namespace on first expand).
      $('#variables-table').on('click keydown', '.var-toggle', function(e) {
        if (e.type === 'keydown' && e.which !== 13 && e.which !== 32) return;
        e.preventDefault();
        e.stopPropagation();
        toggleVarRow($(this).closest('tr'));
      });

      // Step-through debugger controls (record & replay). Markup only exists
      // when features.stepDebugger is on; handlers are harmless no-ops without it.
      if (stepDebuggerEnabled()) {
        var debugActivate = function(handler) {
          return function(e) {
            if (e.type === 'keydown' && e.which !== 13 && e.which !== 32) return;
            e.preventDefault();
            handler();
          };
        };
        $('#debug-start').on('click keydown', debugActivate(runStepThrough));
        // Same action from the output pane, where a student lands after Run —
        // show the Variables panel first so the step controls are on screen
        // rather than recording behind a tab they haven't opened.
        $('#debug-start-alt').on('click keydown', debugActivate(function() {
          showVariables();
          runStepThrough();
        }));
        $('#debug-cancel').on('click keydown', debugActivate(function() { debugCancelled = true; }));
        $('#debug-first').on('click keydown', debugActivate(function() { debugStepTo(0); }));
        $('#debug-back').on('click keydown', debugActivate(function() { debugStepTo(debugIdx - 1); }));
        $('#debug-fwd').on('click keydown', debugActivate(function() { debugStepTo(debugIdx + 1); }));
        $('#debug-last').on('click keydown', debugActivate(function() { debugStepTo(debugRec ? debugRec.steps.length - 1 : 0); }));
        $('#debug-exit').on('click keydown', debugActivate(exitReplay));

        // Phase 2: scrub through the recording. 'input' fires continuously
        // while dragging, so the line highlight / variables / console follow
        // the thumb live.
        $('#debug-slider').on('input change', function() {
          debugStepTo(parseInt(this.value, 10) || 0);
        });

        // Phase 3: gutter breakpoints. Wire existing files now; files opened
        // later get wired when their tab is first selected.
        ensureGutterBreakpointHandlers();
        $('#editor').on('codeeditor.tabChanged', ensureGutterBreakpointHandlers);
        // The STUDENT switched tabs mid-replay. debugShownFile still names the
        // file replay last selected, so the next step would skip selectFile and
        // debugHighlightLine would mark whichever session is now active -- the
        // highlight landing in the wrong file, on a line number that means
        // something else there. Forget it and let the next step re-select.
        $('#editor').on('codeeditor.tabChanged', function() {
          if (!debugSelectingFile) debugShownFile = null;
        });
        // debugBreakpoints is keyed by file NAME and outlives the file. A dot
        // left behind by a deleted or renamed file can never be hit, so every
        // later recording reports bpHit false and the panel says a breakpoint
        // was not reached -- naming a line in a file that is no longer there.
        // (Before this branch it was worse: the tracer stayed dormant waiting
        // for that breakpoint, so every recording came back EMPTY for the rest
        // of the page session.) Follow the file instead of orphaning the key.
        $('#editor').on('codeeditor.fileRemoved', function(e) {
          if (e.fileName && debugBreakpoints[e.fileName]) {
            delete debugBreakpoints[e.fileName];
            debugPanelSync();
          }
        });
        $('#editor').on('codeeditor.fileRenamed', function(e) {
          if (e.oldFileName && debugBreakpoints[e.oldFileName]) {
            if (e.newFileName) debugBreakpoints[e.newFileName] = debugBreakpoints[e.oldFileName];
            delete debugBreakpoints[e.oldFileName];
            debugPanelSync();
          }
        });
        $('#debug-prev-bp').on('click keydown', debugActivate(function() { debugJumpBreakpoint(-1); }));
        $('#debug-next-bp').on('click keydown', debugActivate(function() { debugJumpBreakpoint(1); }));

        // ARROW KEYS: who gets them during a replay. Three claimants, and the
        // rule is FOCUS DECIDES -- settled 2026-09-08 when the floating panel
        // started overlapping the editor, which is what made it a question.
        //
        //   1. Focus inside Ace, or in any input/textarea -> the TEXT gets
        //      them. Bailing here rather than anywhere else is deliberate:
        //      replay does not stop a student reading around their code, and
        //      silently turning ArrowRight into "step" while the caret is
        //      visibly blinking in the editor would be indefensible. Note that
        //      replay's own tab switches pass noFocus=true precisely so they
        //      cannot drop focus into Ace and take the arrows away.
        //   2. Focus on a drag grip -- the pill's or the variables window's --
        //      -> that WINDOW gets them, 8px per press. Both grips call
        //      stopPropagation, so this handler never sees those events. The
        //      variables grip was the broken one: its listener was bound to a
        //      node that paintVars() replaces, so before the window had been
        //      dragged with a mouse the arrows fell through to here and
        //      stepped the recording.
        //   3. Anywhere else -> the RECORDING gets them, one step per press,
        //      which is where focus sits after any panel button is pressed.
        //
        // Stepping by arrow also stops the panel's autoplay: it goes through
        // debugStepTo like every other control, and the panel's timer notices
        // an index it did not produce. So the keys never fight the timer.
        //
        // Shift+arrow jumps to the previous/next breakpoint (Phase 3).
        $(document).on('keydown.stepDebugger', function(e) {
          if (!debugRec) return;
          if (e.which !== 37 && e.which !== 39) return;
          var t = $(e.target);
          if (t.is('input, textarea') || t.closest('.ace_editor').length) return;
          e.preventDefault();
          var dir = e.which === 39 ? 1 : -1;
          if (e.shiftKey) debugJumpBreakpoint(dir);
          else debugStepTo(debugIdx + dir);
        });
      }
    }

    $(document).on('assets.change', function() {
      api.triggerChange();
    });

    $(document).on('open.fndtn.alert', function() { editor.resize(); });
    $(document).on('close.fndtn.alert', function() { editor.resize(); });

    editor.addCommand(
      'run',
      {win: "Ctrl-Enter", mac: "Command-Enter"},
      function() {
        $('#editor').trigger('trinket.code.run', { action : 'code.run' });
      }
    );

    $(document).on('trinket.code.edit',    $.proxy(this.showCode, this));
    $(document).on('trinket.code.run',     $.proxy(this.showResult, this));
    $(document).on('trinket.code.stop',    $.proxy(this.stopExecution, this));
    $(document).on('trinket.code.clear-memory', $.proxy(this.clearMemory, this));
    $(document).on('trinket.code.console', $.proxy(this.consoleResult, this));

    $(document).on('trinket.output.view',       $.proxy(api.showOutput, api));
    $(document).on('trinket.instructions.view', $.proxy(api.showInstructions, api));

    this.viewer = '#codeOutput';

    $('#honeypot').on('keydown', $.proxy(this.showCode, this));

    $('.menu-toolbar .menu-button[data-action="code.run"]').on('mousedown', function(event) {
      if (editor && editor.isFocused()) {
        event.preventDefault();
      }
    });

    api.reset(trinket, true);

    editor.change(function() {
      api.triggerChange();
      // A recording is a snapshot of the source that produced it, so an edit
      // invalidates it. This is not a new rule -- showResult and replaceMain
      // already exitReplay() for a fresh run and for a replaced program; a
      // keystroke is the same event class and was simply never wired up.
      //
      // Without it the student keeps stepping a recording of code that no
      // longer exists, and it fails SILENTLY rather than visibly: the Ace
      // marker is an unanchored Range, so the highlight band stays on its row
      // while the text on that row changes, and the variables window goes on
      // showing values -- even names -- from the old program. Verified in a
      // running embed: the panel reported `dt = 0.1` and a variable `x` that
      // appeared nowhere in the file on screen.
      //
      // Not quiet: the non-quiet path restores the console the way the panel's
      // exit already does, so nothing left behind becomes a lie either.
      var wasReplaying = !!debugRec;
      if (wasReplaying) exitReplay('stale');
      // The same rule, one state earlier. A recording in flight is also a
      // snapshot of source that no longer exists -- runStepThrough captured
      // `prog` before an await, so an edit during the async window (package
      // loading, matplotlib setup, the traced exec itself) produced a replay
      // of code the student can no longer see, with nothing saying so. That is
      // the exact silent failure this handler was added to prevent; it just
      // did not cover the window before enterReplay. debugCancelled is already
      // read by every stage of the chain.
      if (debugRecording) debugCancelled = true;
      // With the floating panel off, the panel's explanation does not exist,
      // so replay ended with the controls simply vanishing. Say it here
      // instead. After exitReplay(), which clears the note slots.
      if (wasReplaying && !debugPanelEnabled()) {
        setDebugNote('Step-through closed because you edited the code.');
      }
      // Guarded like the afterRun hooks: editor.change is single-owner, so a
      // throw from the optional plugin would take the change pipeline with it.
      if (window.trinketPlotpolish) {
        try { trinketPlotpolish.onEditorChange(); } catch (e) {}
      }
      if (window.trinketDebugPanel) {
        // The flag says WHY replay ended. That is what lets the panel put an
        // explanation where the values were instead of just emptying the
        // window and leaving the student to wonder where their variables went.
        try { trinketDebugPanel.onEditorChange(wasReplaying); } catch (e) {}
      }
    });

    // The plot-style panel lives in public/js/plugins/plotpolish-adapter.js.
    // This file is a closure, so api/editor/pyodide/running are not reachable
    // from out there; hand over the few it needs. window.trinketPlotpolish is
    // undefined unless features.plotStyle is on, so this is a no-op when off.
    // Guarded: this runs inside initialize(), so an exception here would take
    // out everything after it -- the dragbar below included.
    if (window.trinketPlotpolish) {
      try {
        trinketPlotpolish.init({
            api        : api
          , getPyodide : function() { return pyodideReady ? pyodide : null; }
          , isBusy     : function() {
              // replEvaluating, not replActive: see its declaration. clearMemory()
              // uses the same three-way test and then handles the REPL separately
              // (wasReplActive) -- this is the sibling that guard was missing.
              return running || debugRecording || replEvaluating
                  || (workerClient && workerClient.isRunning());
            }
        });
      } catch (e) {}
    }

    // The floating debugger panel lives in public/js/plugins/debug-panel.js.
    // Same handover reason as plotpolish above: this file is a closure, so the
    // replay state and its actions are not reachable from out there. The panel
    // is a VIEW -- it reads getState() and calls back into these functions;
    // it holds no debugger state of its own, and the in-tab controls keep
    // working whether it is present or not.
    if (debugPanelEnabled() && window.trinketDebugPanel) {
      try {
        trinketDebugPanel.init({
            // Slice 2: only after a Run, only with >= 2 non-import lines,
            // never for VPython. See debugPanelAvailable().
            isAvailable : debugPanelAvailable
          , getState : function() {
              var st = debugRec ? debugRec.steps[debugIdx] : null;
              return {
                  recording      : debugRecording
                , replaying      : !!debugRec
                , idx            : debugIdx
                , total          : debugRec ? debugRec.steps.length - 1 : 0
                , atEnd          : !!(st && st.func === '<end>')
                  // Whether the recorder ran out of budget. The panel needs it
                  // to keep quiet about reaching "the end": on a truncated run
                  // the <end> step carries no error, so the panel printed
                  // "Reached the end & stopped" directly above the recorder's
                  // accurate "recording stopped after N steps" -- two claims
                  // that cannot both be true, one of them ours.
                , truncated      : !!(debugRec && debugRec.truncated)
                  // Offer to re-record from the breakpoint only when the
                  // evidence is in: the recording ran out of budget AND the
                  // marked line never came up. Never on a recording that was
                  // itself deferred -- one attempt answers the question, and
                  // re-offering it would loop the student round a re-run that
                  // has already told them what they needed to know.
                , canDefer       : !!(debugRec && debugRec.truncated
                                      && debugRec.bpHit === false
                                      && !debugRec.deferred
                                      && debugHasBreakpoints())
                , deferLine      : (function() {
                    var bl = debugBreakpointList();
                    return bl.length === 1 ? bl[0].line : null;
                  })()
                  // The persistent notes only; the flash rides its own field
                  // because the panel shows the two at different times.
                , note           : debugPersistentNote()
                , flash          : debugFlashNote
                , hasBreakpoints : debugHasBreakpoints()
                  // For painting only. The pause itself is actions.autoStep, so
                  // that a paint value never becomes a control value.
                , line           : (function() {
                    var st = debugRec ? debugRec.steps[debugIdx] : null;
                    return st ? st.line : null;
                  })()
                , atBreakpoint   : debugIsBpStep(debugIdx)
                  // Whether pressing play can still stop at anything. Read
                  // once per play press, not painted.
                , bpAhead        : debugBpAhead(debugIdx)
                  // "about to execute line 8 for the 43rd time" -- a line
                  // event fires BEFORE its line runs, which is why the
                  // tooltip says "about to".
                , lineVisit      : (debugVisits && debugVisits[debugIdx]) || 0
                  // Whether the ordinal has earned its place yet: see
                  // debugRepeatFrom.
                , visitOrdinals  : !!(debugRepeatFrom !== null && debugIdx >= debugRepeatFrom)
                  // The panel is a VIEW, so parsing a traceback is this side's
                  // job, not its own.
                , hasError       : !!(debugRec && debugRec.error)
                , errorLine      : debugErrorLine()
                , errorMsg       : debugErrorMessage()
                  // The panel starts a recording on the same click that opens
                  // it, and runStepThrough() refuses while anything else is
                  // executing. Without knowing that, the panel would open and
                  // silently do nothing.
                , busy           : running || replEvaluating
                                     || !!(workerClient && workerClient.isRunning())
              };
            }
            // The panel builds its own list from these; presentation stays out
            // here, the data stays in there.
          , getVarModel : debugBuildVarModel
          , getVars : function(i) {
              return debugRec && debugRec.snaps ? (debugRec.snaps[i] || []) : [];
            }
          , actions : {
                start  : runStepThrough
                // Opt-in deferred recording; see runStepThrough's `defer`.
              , startDeferred : function() { runStepThrough(true); }
              , cancel : function() { debugCancelled = true; }
              , stepTo : debugStepTo
              , step   : function(d) { debugStepTo(debugIdx + d); }
              , first  : function() { debugStepTo(0); }
              , last   : function() { debugStepTo(debugRec ? debugRec.steps.length - 1 : 0); }
              , autoStep : debugAutoStep
              , jumpBp : debugJumpBreakpoint
              , exit   : function() { exitReplay(); }
            }
        });
      } catch (e) {}
    }

    if (typeof api.draggable === 'function') {
      api.draggable(function() {});
    }

    // Make the separator between the graphic/output pane and the console
    // draggable to resize them (matplotlib figures, VPython scene, stdout).
    $('#output-dragbar').css('touch-action', 'none'); // iPad: pointer drag, not scroll
    $('#output-dragbar').on('pointerdown', function(e) {
      e.preventDefault();

      var containerHeight = $('.trinket-content-wrapper').height();
      var containerTop    = $('.trinket-content-wrapper').offset().top;
      var dragbarHeight   = $('#output-dragbar').height();

      $(document).on('pointermove.output-dragbar', function(e) {
        var topHeight    = e.pageY - containerTop - dragbarHeight / 2;
        var bottomHeight = containerHeight - topHeight - dragbarHeight / 2;
        if (topHeight >= 20 && bottomHeight >= 20) {
          $('#graphic-wrap').css('height', topHeight);
          $('#console-wrap').css('height', bottomHeight);
        }
      });

      $(document).on('pointerup.output-dragbar', function() {
        $(document).off('pointermove.output-dragbar pointerup.output-dragbar');
        // Remember the split so the next Run keeps it instead of resetting.
        var gh = $('#graphic-wrap').height();
        var ch = $('#console-wrap').height();
        if (gh + ch > 0) {
          graphicSplit = gh / (gh + ch);
        }
      });

      if (typeof api.sendInterfaceAnalytics === 'function') {
        api.sendInterfaceAnalytics(this);
      }
    });

    api.activityLog = new ActivityLog(function(type, count) {
      var action = type.replace(
        /[a-zA-Z0-9](?:[^\s\-\._]*)/g
        , function(txt){return txt.charAt(0).toUpperCase() + txt.substr(1);}
      );
      api.sendAnalytics("Output", {
        action  : action
        , label : api.getTrinketIdentifier()
        , value : count
      });
    });

    if (window.parent) {
      window.parent.postMessage("initialised", "*");
    }

    if (api._queryString && api._trinket.description && api._queryString.showInstructions && api._trinket.description.length) {
      $(document).trigger('trinket.instructions.view');
    }
  },

  collectErrorData : function() {},

  highlightLine : function(file_name, line_num) {
    editor.highlight(file_name, line_num);
  },

  getTour : function() {
    return [];
  },
  getEditor : function() {
    return editor;
  },
  getType : function() {
    return 'pyodide';
  },
  getValue : function(opts) {
    return editor.serialize(opts);
  },
  getMainFile : function() {
    return mainFile;
  },
  isDirty : function() {
    if (!this._trinket) return false;

    if (this.getValue() !== (this._original.code || '')) {
      return true;
    }
    if (JSON.stringify(this._trinket.settings) !== JSON.stringify(this._original.settings)) {
      return true;
    }
    return false;
  },
  getAnalyticsCategory : function() {
    return 'Pyodide';
  },
  serialize : function(opts) {
    var serialized = {
      code     : this.getValue(opts),
      assets   : editor.assets().slice(),
      settings : this._trinket.settings
    };

    if (opts && opts.removeComments) {
      editor.removeComments();
    }

    return serialized;
  },
  showMessage : function(type, message) {
    var html = template('statusMessageTemplate', { type : type, message : message });
    var $msg = $(html);
    $('body').addClass('has-status-bar').append($msg);
    $msg.parent().foundation().trigger('open.fndtn.alert');
  },
  clearMemory : function() {
    // Do not clear the namespace underneath an async program: a completion or
    // exception handler could immediately put stale state back. Stop completes
    // synchronously for a worker, but the main-thread runner needs to unwind at
    // its next cancellation point, so require the student to stop it first.
    if (running || debugRecording || (workerClient && workerClient.isRunning())) {
      writeOut('[Stop the program before clearing Python memory.]\n');
      return;
    }

    // A live REPL owns a jqconsole Prompt that is bound to the old namespace.
    // Preserve ordinary program output, but replace a console session with a
    // fresh prompt after clearing — the same user-facing recovery that Stop
    // provides when it resets a console interpreter.
    var wasReplActive = replActive;
    var clearedMain = clearMainThreadMemory();
    var clearedWorker = workerClient ? workerClient.discardWorker() : false;

    // A scene belongs to the interpreter that created it. Without this, a
    // stopped VPython canvas or matplotlib figure could remain on screen after
    // the variables it depicts have been discarded.
    resetVPythonScene();
    $('#graphic').empty();
    $('#graphic-wrap').addClass('hide');
    $('#output-dragbar').addClass('hide');
    $('#console-wrap').css('height', '100%');
    resetMplFigures();

    // The plot-style panel is anchored to #graphic-wrap, which survives the
    // empty() above, and its backend points at the namespace clearMainThreadMemory()
    // has just reset. Tell it to come down: mount() is one-way, so a panel left
    // here would sit over whatever graphic appears next, still wired to a figure
    // that no longer exists.
    if (window.trinketPlotpolish) {
      try { trinketPlotpolish.onFigureGone(); } catch (e) {}
    }

    if (variableExplorerEnabled()) {
      try { renderVariables([]); } catch (e) {}
    }

    // Keep program output intact: output and memory are intentionally separate
    // controls. The one exception is an active REPL session: reset its prompt,
    // explain the reset, and immediately give the student a fresh >>> prompt.
    // The REPL branch must still report honestly. clearMainThreadMemory()
    // announces its own failure, but resetOutput() below discards the queued
    // console buffer (#142) — so that warning never reaches the student, and an
    // unconditional success line would be the only thing they see, over a
    // namespace that was NOT cleared.
    if (wasReplActive) {
      replActive = false;
      resetOutput(true);
      writeOut((clearedMain || clearedWorker)
        ? '[Python memory cleared — console session reset]\n'
        : '[Could not clear Python memory; reload the page to start fresh.]\n');
      startReplPrompt();
    } else if (clearedMain || clearedWorker) {
      writeOut('[Python memory cleared.]\n');
    } else {
      writeOut('[Python memory is already clear.]\n');
    }
  },
  showCode : function() {
    $('#codeOutput').addClass('hide');
    $('#editor').removeClass('hide');
    api.closeOverlay('#modules');
    api.focus();
  },
  // The Console entry in the run-options dropdown. Previously `trinket.code.console`
  // was bound straight to showResult, which RUNS the program — so the menu entry
  // (once it existed) would have silently done the wrong thing rather than opening
  // the REPL.
  //
  // Order matters: showResult() clears api.runMode, so runMode is set after it,
  // not before.
  consoleResult : function(event) {
    if (runOption !== 'console' && event && $(event.target).data('button') === 'console') {
      api.changeRunOption('console');
    }

    showOutputPane();
    api.runMode = 'console';
    api.triggerRunModeChange();

    // Re-selecting Console while a prompt is already armed would print a second
    // banner and arm a second prompt on top of the first.
    if (!replActive) { startRepl(); }
  },

  showResult : function(event) {
    if (runOption !== 'run' && event && $(event.target).data('button') === 'run') {
      api.changeRunOption('run');
    }
    api.runMode = '';
    api.triggerRunModeChange();
    api.hasRun = true;

    showOutputPane();
    exitReplay(true);    // a fresh run invalidates any step-through recording
                         // (quiet: runCode resets the console right after)

    runCode();

    if (event) {
      api.callAnalytics('Interaction', 'Click', 'Run');
    }
  },
  stopExecution : function() {
    stopCode();
  },
  showTestResult : function() {},
  toggleModules : function() {},
  hideAll : function() {},
  onOpenOverlay : function() {
    $('#codeOutput').addClass('hide');
    $('#editor').addClass('hide');
  },
  onCloseOverlay : function() {
    $('#codeOutput').removeClass('hide');
    $('#editor').removeClass('hide');
    api.focus();
  },
  reset : function(trinket, initial) {
    editor.reset(trinket.code);
    editor.assets(trinket.assets ? trinket.assets.slice() : []);

    // #109: open the interactive REPL instead of the run-a-program flow.
    //
    // Accept BOTH spellings, because the two entry points disagree:
    //   * runOption=console — what the Share/Embed dialog emits ("Interactive
    //     console only"); the server keeps it as runOption and leaves runMode
    //     empty, since its runMode fallback only fires when runOption is unset.
    //   * runMode=console  — what markdown ```python3.console``` blocks emit,
    //     and what a previously-shared console link carries.
    // Keying on only one of them would leave the dialog's option dead — the very
    // complaint this issue is about.
    //
    // Gated strictly on console mode, so every ordinary trinket takes the
    // unchanged path below.
    if (api.runMode === 'console' || runOption === 'console') {
      this.showResult();
      startRepl();
      return;
    }

    if (trinket.code && (start === 'result') && autoRun !== false) {
      this.showResult();
    }
    else if (this._queryString.outputOnly) {
      // #66: outputOnly hides the editor, and showCode() below hides the output
      // pane — so an outputOnly embed WITHOUT autorun hid both and rendered
      // completely blank. The console is otherwise created lazily on first Run,
      // which never happens here.
      //
      // Reveal the (empty) console instead. Deliberately not forcing a run: the
      // embed author left autorun off on purpose, and "only show output" still
      // means the output pane is the thing on screen — it just starts empty
      // until the viewer presses Run.
      $('#codeOutput').removeClass('hide');
      $('#editor').addClass('hide');
      initConsoleOutput();
    }
    else {
      this.showCode();
      resetOutput();
    }
  },
  replaceMain : function(trinket) {
    exitReplay(true); // the recording no longer matches the replaced code
    editor.setValue(trinket.code);
    editor.assets(trinket.assets ? trinket.assets.slice() : []);
  },
  onChangeChecks : function() {},
  focus : function() {
    if (!$('body').data('is-mobile') && $('body').data('autofocus')) {
      editor.focus();
    }
  },
  markCodeAsRun : function(code) {
    codeRuns[code] = true;
  },
  downloadable : function() {
    var owner = this.getUIType() === 'owner'
      , remix;

    if (this._trinket && this._trinket._origin_id) {
      remix = this._trinket._origin_id;
    }

    return {
        files  : owner && !remix ? editor.getAllFiles() : editor.getAllVisibleFiles()
      , assets : editor.assets()
    };
  },
  changeRunOption : function(option) {
    var icon_classes = { run : 'fa fa-play', stop : 'fa fa-stop', console : 'fa fa-terminal' };
    var titles = { run : 'View the result.', stop : 'Stop program.', console : 'Run code interactively.' };
    var labels = { run : 'Run', stop : 'Stop', console : 'Console' };
    $('.run-it').data('action', 'code.' + option);
    $('.run-it').attr('title', titles[option]);
    $('.run-it').find('label').text(labels[option]);
    $('.run-it').find('i').removeClass().addClass(icon_classes[option]);
    runOption = option;
  },
  saveClientSnapshot : function() {
    return this.getUIType() === 'owner' && this.hasRun;
  },
  setWrap: function(wrap) {
    editor.setWrap(wrap);
    this.setAPILineWrap(wrap);
  },
  setIndent: function(indent) {
    editor.setIndent(indent);
    this.setAPIIndent(indent, undefined, undefined, undefined);
  },
  captureAndSaveSnapshot : function(done) {
    try {
      var node = document.querySelector("#outputContainer");
      htmlToImage.toPng(node)
        .then(function (dataUrl) { done(dataUrl); })
        .catch(function (error) { console.error('snapshot error:', error); done(); });
    } catch(e) {
      done();
    }
  }
};

})(window, window.TrinketIO);
