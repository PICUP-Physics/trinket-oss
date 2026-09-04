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
var VPYTHON_ZIP_URL = '/js/embed/wvpython/vpython.zip';
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
var MATPLOTLIB_SETUP_CODE = [
  "import matplotlib",
  "matplotlib.use('webagg')",
  "matplotlib.rcParams['figure.autolayout'] = True",
  "import matplotlib.pyplot as _plt",
  "_plt.close('all')",
  "del _plt",
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
var outBuf   = consoleBuffer.createOutputBuffer({ maxLines: 5000 });
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

// One Write for everything queued — this is the whole point: N lines cost one
// reflow, not N.
function flushConsoleNow() {
  outCancelFlush();
  var text = outBuf.drain();
  if (text && jqconsole) jqconsole.Write(text);
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
    try {
      result = console_.push(input);
    } catch (e) {
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
      .then(function() { startReplPrompt(); });

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
    pyodideReady = true;
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
    return py;
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
var TRACEBACK_INTERNAL = /python\d*\.zip|[\\/]_pyodide[\\/]|pyodide\.asm|importlib\._bootstrap/;
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

var ASYNC_TRANSFORM_URL = '/js/embed/wvpython/vpython/_async_transform.py';
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
  "_SKIP = {'__user_source__', '_plt', '_vpy', '_js_scene', '_wrapped_rate', 'transform_source'}",
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

// Recorder caps (see the MVP doc). The step/size caps abort the traced exec
// from INSIDE the tracer — that's what bounds `while True:` on the main
// thread, where JS cannot interrupt synchronous Python.
var DEBUG_MAX_STEPS = 5000;
var DEBUG_MAX_VARS = 50;
var DEBUG_MAX_REPR = 120;
var DEBUG_MAX_DEPTH = 20;
var DEBUG_MAX_BYTES = 2 * 1024 * 1024;
// Phase 3: with breakpoints set the tracer idles (no snapshots) until one is
// hit — but an infinite loop BEFORE the first breakpoint would otherwise spin
// forever, so dormant line events are capped too (cheap: a set lookup each).
var DEBUG_MAX_DORMANT = 200000;

// The user program is compiled with filename '<debug>' and exec'd in a fresh
// namespace: user frames are exactly the '<debug>' frames (functions defined in
// the main file included), library/site-packages frames are never traced, and
// the real pyodide.globals namespace is untouched. stdout/stderr are captured
// into a buffer so replay can reveal output step-by-step. A synthetic '<end>'
// step (full output, final globals) is appended so students can step past the
// last line to the terminal state.
var RECORD_HELPER = [
  'import sys, json, types, io, traceback',
  // KEEP IN SYNC with VARS_HELPER's _SKIP + filters (the live explorer): both
  // must hide the same runner-injected names. They live in separate helper
  // strings/namespaces, so a shared definition would add more machinery than
  // it removes — this cross-reference is the guard.
  "_SKIP = {'__user_source__', '_plt', '_vpy', '_js_scene', '_wrapped_rate', 'transform_source'}",
  'class _TrinketStopRecording(Exception): pass',
  '_steps = []',
  '_snaps = []',
  '_size = [0]',
  '_truncated = [False]',
  '_buf = io.StringIO()',
  '_last_out = [0]',
  'def _snap_ns(_ns):',
  '    _out = []',
  '    for _name, _val in list(_ns.items()):',
  '        if _name in _SKIP: continue',
  "        if _name.startswith('__') and _name.endswith('__'): continue",
  '        if isinstance(_val, types.ModuleType): continue',
  '        if isinstance(_val, (types.FunctionType, types.BuiltinFunctionType, types.LambdaType)): continue',
  '        if isinstance(_val, type): continue',
  '        try:',
  '            _r = repr(_val)',
  '        except Exception:',
  "            _r = '<unrepresentable>'",
  "        if len(_r) > _max_repr: _r = _r[:_max_repr] + '...'",
  "        _out.append({'name': _name, 'type': type(_val).__name__, 'repr': _r})",
  '        _size[0] += len(_r) + len(_name) + 24',
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
  // Phase 3: deferred recording. With breakpoints set, stay dormant (no
  // snapshots, no step cap) until execution first touches a breakpoint line —
  // long preambles don't burn the cap. Dormant line events are still counted
  // and capped so an infinite loop BEFORE any breakpoint can't spin forever.
  '_bp_set = set()',
  'for _k in _bp:',
  '    for _l in _bp[_k]:',
  '        _bp_set.add((_k, _l))',
  '_armed = [not _bp_set]',
  '_dormant = [0]',
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
  // sail past the cap into a multi-MB JSON). Counted in the dormant phase too —
  // pre-breakpoint prints still ship in the recording's output.
  '    _size[0] += _buf.tell() - _last_out[0]',
  '    _last_out[0] = _buf.tell()',
  '    if not _armed[0]:',
  "        _lbl = _file_label(_frame.f_code.co_filename) or '<main>'",
  '        if (_lbl, _frame.f_lineno) in _bp_set:',
  '            _armed[0] = True',
  '        else:',
  '            _dormant[0] += 1',
  '            if _dormant[0] > _max_dormant or _size[0] > _max_bytes:',
  '                _truncated[0] = True',
  '                raise _TrinketStopRecording()',
  '            return _tracer',
  // Armed path: per-step dict overhead joins the accounting.
  '    _size[0] += 40',
  '    if len(_steps) >= _max_steps or _size[0] > _max_bytes:',
  '        _truncated[0] = True',
  '        raise _TrinketStopRecording()',
  '    _d = _depth_of(_frame)',
  '    _fl, _ff = _call_site(_frame) if _d > 0 else (None, None)',
  "    _steps.append({'line': _frame.f_lineno, 'func': _frame.f_code.co_name, 'depth': _d, 'out': _buf.tell(), 'file': _file_label(_frame.f_code.co_filename), 'from_line': _fl, 'from_file': _ff})",
  '    _snaps.append(_snap_ns(_frame.f_locals))',
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
  'finally:',
  '    sys.stdout, sys.stderr = _old_out, _old_err',
  "_steps.append({'line': None, 'func': '<end>', 'depth': 0, 'out': _buf.tell(), 'file': None, 'from_line': None, 'from_file': None})",
  '_snaps.append(_snap_ns(_g))',
  "json.dumps({'error': _err, 'truncated': _truncated[0], 'armed': _armed[0], 'skipped': _dormant[0], 'output': _buf.getvalue(), 'steps': _steps, 'snaps': _snaps})"
].join('\n');

var debugRec = null;       // active recording ({error, truncated, output, steps, snaps}) or null
var debugIdx = 0;          // current step index into debugRec.steps
var debugRecording = false;
var debugCancelled = false;
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
      editor.selectFile(file, true); // safe: only called for files that exist
      debugShownFile = file;
    }
  } catch (e) { /* tab switching is best-effort */ }
  debugHighlightLine(st.line);
}

// --- Phase 3: gutter breakpoints ---------------------------------------------
//
// A breakpoint in the record & replay model pauses nothing — it is a
// navigation filter over the finished recording (next/prev-breakpoint jumps
// debugIdx to the nearest matching step), plus a recorder hint: when
// breakpoints are set, the tracer stays dormant until execution first touches
// one, so long preambles don't burn the step cap ("deferred recording").
// Fully dynamic: toggling breakpoints mid-replay updates jump targets
// instantly.

var debugBreakpoints = {}; // file name -> { line(1-based): true }

function debugToggleBreakpoint(file, line) {
  var bp = debugBreakpoints[file] || (debugBreakpoints[file] = {});
  if (bp[line]) delete bp[line]; else bp[line] = true;
  return !!bp[line];
}

function debugHasBreakpoints() {
  for (var f in debugBreakpoints) {
    for (var l in debugBreakpoints[f]) return true;
  }
  return false;
}

// Breakpoint payload for the recorder: file label -> [lines]. The main file is
// keyed '<main>' (its frames carry no file label).
function debugBreakpointPayload() {
  var out = {};
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

// The persistent replay note (truncated/error/deferred-start) that transient
// flashes must restore rather than clobber.
var debugBaseNote = '';
var debugNoteTimer = null;
function flashDebugNote(msg) {
  $('#debug-note').text(msg);
  if (debugNoteTimer) clearTimeout(debugNoteTimer);
  debugNoteTimer = setTimeout(function() {
    debugNoteTimer = null;
    $('#debug-note').text(debugBaseNote);
  }, 2500);
}

// Jump to the nearest recorded step (dir = +1/-1) whose (file, line) has a
// breakpoint.
function debugJumpBreakpoint(dir) {
  if (!debugRec) return;
  if (!debugHasBreakpoints()) {
    flashDebugNote('no breakpoints — click left of a line number to add one');
    return;
  }
  for (var i = debugIdx + dir; i >= 0 && i < debugRec.steps.length; i += dir) {
    var st = debugRec.steps[i];
    if (st.line == null) continue;
    var f = st.file || mainFile;
    if (debugBreakpoints[f] && debugBreakpoints[f][st.line]) {
      debugStepTo(i);
      return;
    }
  }
  flashDebugNote(dir > 0 ? 'no breakpoint ahead' : 'no breakpoint behind');
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

function debugStepTo(idx) {
  if (!debugRec) return;
  debugIdx = Math.max(0, Math.min(idx, debugRec.steps.length - 1));
  renderDebugStep();
}

function enterReplay(rec) {
  debugRec = rec;
  debugIdx = 0;
  debugLastOut = -1;
  debugErrShown = false;
  $('#debug-recording').addClass('hide');
  $('#debug-launch').addClass('hide');
  $('#debug-controls').removeClass('hide');
  var notes = [];
  // rec.armed is false only when breakpoints were set but never hit;
  // rec.skipped counts dormant line events before the first breakpoint fired.
  if (rec.armed === false) notes.push('no breakpoint was reached — nothing recorded');
  else if (rec.skipped) notes.push('recording started at the first breakpoint');
  if (rec.truncated) notes.push('recording stopped after ' + (rec.steps.length - 1) + ' steps');
  if (rec.error) notes.push('ends with an error');
  debugBaseNote = notes.join(' · ');
  $('#debug-note').text(debugBaseNote);
  showVariables();
  renderDebugStep();
}

// Leave replay mode. `quiet` skips the console restore — used by callers that
// are about to reset or rewrite the console themselves (a fresh run, the
// Reset Output button), where restoring the recording's output first would be
// wasted or actively wrong. The ✕ button uses the default (restore), so
// exiting by hand leaves the full recorded output visible.
function exitReplay(quiet) {
  if (!debugRec) return;
  var rec = debugRec;
  debugRec = null;
  debugLastOut = -1;
  debugErrShown = false;
  debugShownFile = null;
  debugHighlightLine(null);
  $('#debug-controls').addClass('hide');
  debugBaseNote = '';
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
    if (rec.error) consoleWrite('\n' + escapeConsoleHtml(rec.error) + '\n', 'jqconsole-error', false);
  }
  paintVariables();
}

// Run the program under the recorder, then enter replay. Mirrors startRun's
// pre-steps (FS sync, package auto-load, matplotlib target) but execs in a
// fresh namespace under trace. Normal Run is untouched.
function runStepThrough() {
  if (running || debugRecording) return;
  if (debugRec) exitReplay();

  debugRecording = true;
  debugCancelled = false;
  $('#debug-launch').addClass('hide');
  $('#debug-recording').removeClass('hide');

  function recordingDone() {
    debugRecording = false;
    $('#debug-recording').addClass('hide');
    if (!debugRec) $('#debug-launch').removeClass('hide');
  }

  ensurePyodide().then(function() {
    if (debugCancelled || running) return null; // cancelled, or a normal run got in first
    var prog = syncFilesToFS(editor.getAllFiles(), mainFile);
    if (usesVPython(prog)) {
      $('#debug-note').text('Step through is not available for VPython programs');
      setTimeout(function() { $('#debug-note').text(''); }, 4000);
      return null;
    }
    if (usesConsole(prog) && !userShadowsConsole()) {
      // The recorder (RECORD_HELPER) execs the RAW user source under
      // sys.settrace — it never routes through ensureConsoleTransform/
      // transform_source, so a `console.input()` call would run un-awaited
      // (a silently-wrong coroutine, and the input field would never open).
      // Bail with the same mechanism/style as the VPython guard above rather
      // than teaching the recorder about the transform.
      $('#debug-note').text('Step through is not available for programs that read console input');
      setTimeout(function() { $('#debug-note').text(''); }, 4000);
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
            // Phase 3: with breakpoints set, the tracer stays dormant until
            // one is hit (deferred recording).
            _bp: debugBreakpointPayload(),
            _max_steps: DEBUG_MAX_STEPS,
            _max_vars: DEBUG_MAX_VARS,
            _max_repr: DEBUG_MAX_REPR,
            _max_depth: DEBUG_MAX_DEPTH,
            _max_bytes: DEBUG_MAX_BYTES,
            _max_dormant: DEBUG_MAX_DORMANT
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
    recordingDone();
    if (rec && !debugCancelled) {
      initConsoleOutput();
      enterReplay(rec);
    }
  }).catch(function(err) {
    recordingDone();
    $('#debug-note').text('recording failed');
    setTimeout(function() { $('#debug-note').text(''); }, 4000);
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
    workerUrl  : '/js/embed/pyodide-worker.js',
    pyodideUrl : PYODIDE_INDEX_URL + 'pyodide.mjs',   // module build (#215)
    indexURL   : PYODIDE_INDEX_URL,
    transformUrl : ASYNC_TRANSFORM_URL,
    varsHelper   : VARS_HELPER,
    // Completes the "Loading Python (Pyodide)… " line once the worker's Pyodide
    // has booted (#27). closeRuntimeLine() is a no-op unless a line is actually
    // open, so a boot nobody announced cannot print a stray "ready".
    onReady    : function() { closeRuntimeLine(); },
    onStdout   : function(text) { writeStream(text); },
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
function makeMplSocket(figureId) {
  return {
    binaryType : 'arraybuffer',
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
      // The toolbar's save button: matplotlib hands back a download URL.
      var link = document.createElement('a');
      link.href = figure.canvas.toDataURL('image/' + (format || 'png'));
      link.download = 'plot.' + (format || 'png');
      link.click();
    }, host);

    mplFigures[msg.figureId] = { fig: fig, socket: socket };
    applyMplToolbarIcons(fig);
    if (typeof socket.onopen === 'function') { socket.onopen(); }

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
  mplFigures = {};              // figures belong to a run; mpl.js itself persists
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
          return pyodide.runPythonAsync(prog || '');
        }).then(function(result) {
          // Notebook-style auto-display: if the program created figures but
          // never called plt.show(), show them. If a canvas already rendered
          // (the user called show()), skip — so we never double-plot.
          var g = document.getElementById('graphic');
          if (g && g.querySelector('canvas')) {
            return result;
          }
          return pyodide.runPythonAsync(
            "import matplotlib.pyplot as _plt\n" +
            "if _plt.get_fignums():\n" +
            "    _plt.show()\n"
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
          return pyodide.runPythonAsync(asyncProg);
        });
      }
      return pyodide.runPythonAsync(prog || '');
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
        $('#debug-prev-bp').on('click keydown', debugActivate(function() { debugJumpBreakpoint(-1); }));
        $('#debug-next-bp').on('click keydown', debugActivate(function() { debugJumpBreakpoint(1); }));

        // Arrow-key stepping while replaying (ignored while typing in the
        // editor or any input, so it never hijacks code editing).
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
    });

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
    mplFigures = {};

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
