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
var GLOW_SRC = '/components/vpython-glowscript/package/glow.3.2.2.min.js';
var VPYTHON_ZIP_URL = '/js/embed/wvpython/vpython.zip';

// Python code injected before user code runs each time a matplotlib program
// executes.  Pyodide 0.28+ ships a Pyodide-patched WebAgg backend that reads
// document.pyodideMplTarget (set by JS below) so figures land in #graphic,
// and wires the full interactive toolbar + 3D mouse-orbit automatically.
// plt.close('all') ensures stale figures from a previous run don't resurface.
var MATPLOTLIB_SETUP_CODE = [
  "import matplotlib",
  "matplotlib.use('webagg')",
  "import matplotlib.pyplot as _plt",
  "_plt.close('all')",
  "del _plt",
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
var disableAceEditor = window.userSettings && window.userSettings.disableAceEditor || false;

// Pyodide is loaded lazily on the first run so the ~10MB download doesn't block
// page load. pyodideLoading memoizes the in-flight / completed load promise.
var pyodide = null;
var pyodideReady = false;
var pyodideLoading = null;
var running = false;

function loadingHeader() {
  var src = (window.trinketConfig && trinketConfig.prefix)
    ? trinketConfig.prefix('/img/trinket-logo.png')
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
  jqconsole.Write("\x1b[0m");
  jqconsole.Reset();
  jqconsole.Append(loadingHeader());
}

function resetOutput(consoleOnly) {
  if (editor) {
    editor.clearTabMarkers();
  }

  if (jqconsole) {
    jqconsole.Write("\x1b[0m");
    jqconsole.Reset();
    jqconsole.Append(loadingHeader());
  }

  if (!consoleOnly) {
    $('#graphic').empty();
    $('#graphic').removeData("graphicMode");
  }
}

function writeOut(text) {
  initConsoleOutput();
  if (jqconsole) {
    jqconsole.Write(text);
  }
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
    py.setStdout({ batched: function(s) { writeOut(s + '\n'); } });
    py.setStderr({ batched: function(s) { writeOut(s + '\n'); } });
    // Record the pristine namespace so the variable explorer can show only the
    // names the user's program introduces, not Python built-ins / library imports.
    try { py.runPython('__trinket_baseline__ = set(globals().keys())'); } catch (e) {}
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
function importsPackages(code) {
  return importsMatch(code, 'numpy|matplotlib|pandas|scipy|sympy|PIL|sklearn|micropip');
}
function usesMatplotlib(code) {
  return importsMatch(code, 'matplotlib');
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
var cancelRequested = false;  // set true to make the next rate() reject
var rerunQueued = false;      // a Run was clicked mid-run; re-run once it stops
var runningIsVpython = false; // the in-flight run is a VPython program (cancellable)
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

function isCancelError(err) {
  var msg = (err && (err.message || err.toString())) || '';
  return msg.indexOf(CANCEL_MARKER) >= 0;
}

// True when the program is a VPython/GlowScript program: either the classic
// first-line version header ("Web VPython 3.2" / "GlowScript 3.2 VPython") or
// an explicit vpython import.
function usesVPython(code) {
  return /^\s*(Web\s+VPython|GlowScript)\b/i.test(code)
      || /(^|\n)\s*(import\s+vpython|from\s+vpython\b)/.test(code);
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

// Fetch + unpack the vpython package into Pyodide's FS and import it (plus the
// math/random star-imports VPython programs assume). Memoized; assumes Pyodide
// is ready and GlowScript globals exist. Mirrors wmWVPRunner's run sequence.
function ensureVpython() {
  if (vpythonLoading) return vpythonLoading;
  vpythonLoading = fetch(VPYTHON_ZIP_URL)
    .then(function(r) { return r.arrayBuffer(); })
    .then(function(buf) {
      pyodide.unpackArchive(buf, 'zip');
      return pyodide.runPythonAsync('from math import *');
    })
    .then(function() { return pyodide.runPythonAsync('from random import *'); })
    .then(function() { return pyodide.runPythonAsync('from vpython import *'); });
  return vpythonLoading;
}

// Run a VPython program: load glow + scene + bridge, comment out the version
// header line (keeping line numbers stable), rewrite blocking rate()/sleep()
// loops to async via the bridge's AST transformer, then execute.
function runVpython(prog) {
  writeOut('Loading VPython (GlowScript)…\n');
  return ensureGlow().then(function() {
    installRateCancellation();  // wrap rate() before the bridge imports it
    setupGlowScene();
    showGraphic();
    return ensureVpython();
  }).then(function() {
    // The bridge binds `scene` and `rate` to window.* at import time (once).
    // Re-point them in Python before the user code imports them:
    //  - scene: the canvas was rebuilt above, so target the fresh one.
    //  - rate:  bind to the cancellation-wrapped window.rate so a re-run can
    //           interrupt the loop (the import-time binding caught the
    //           unwrapped rate, defeating cancellation otherwise).
    return pyodide.runPythonAsync(
      'import vpython as _vpy\n' +
      'from js import scene as _js_scene\n' +
      'from js import rate as _wrapped_rate\n' +
      '_vpy.scene = _vpy.canvas(jsObj=_js_scene)\n' +
      '_vpy.rate = _wrapped_rate\n' +
      'scene = _vpy.scene\n' +
      'rate = _wrapped_rate\n'
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
    // Everything in globals now is library/bootstrap (the vpython/math/random
    // star-imports, scene, rate, …). Fold it into the explorer baseline once so
    // those names are hidden — but only once, so vars created by earlier runs
    // stay visible on re-runs.
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
  "_SKIP = {'__user_source__', '_plt', '_vpy', '_js_scene', '_wrapped_rate'}",
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
  "    _out.append({'name': _name, 'type': type(_val).__name__, 'kind': _kind, 'repr': _r, 'len': _n})",
  "_out.sort(key=lambda d: (d['kind'] != 'value', d['name']))",
  'json.dumps(_out)'
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

function paintVariables() {
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

  var html = '';
  for (var j = 0; j < shown.length; j++) {
    var v = shown[j];
    var typeCell = escHtml(v.type);
    if (v.len != null && SIZED_TYPES[v.type]) {
      typeCell += ' <span class="var-len">(' + v.len + ')</span>';
    }
    html += '<tr class="var-row var-kind-' + v.kind + '">'
      + '<td class="var-name">' + kindIcon(v.kind) + escHtml(v.name) + '</td>'
      + '<td class="var-type">' + typeCell + '</td>'
      + '<td class="var-value"><span class="var-value-text">' + escHtml(v.repr) + '</span>'
      + '<button type="button" class="var-copy" title="Copy value" aria-label="Copy value" tabindex="-1">'
      + '<i class="fa fa-clone"></i></button></td>'
      + '</tr>';
  }
  $body.html(html);
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

function finishRun(serializedCode, err) {
  running = false;
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

  if (running) {
    // A run is already in flight. For a VPython program (which yields at rate())
    // request cancellation and queue a fresh run, so clicking Run restarts a
    // running animation. For anything else keep the old behavior (ignore).
    if (runningIsVpython) {
      cancelRequested = true;
      rerunQueued = true;
    }
    return;
  }

  startRun();
}

function startRun() {
  cancelRequested = false;
  rerunQueued = false;
  runningIsVpython = false;

  if (window.parent) {
    window.parent.postMessage("started", "*");
  }

  var serializedCode = api.getValue();

  initConsoleOutput();
  resetOutput();
  $('#console-output').removeClass('console-mode');

  // Default to a console-only layout each run; showGraphic() re-splits the pane
  // when the code uses matplotlib.
  $('#graphic-wrap').addClass('hide');
  $('#output-dragbar').addClass('hide');
  $('#console-wrap').css('height', '100%');

  if (!pyodideReady) {
    writeOut('Loading Python (Pyodide)…\n');
  }

  running = true;

  ensurePyodide().then(function() {
    var prog = syncFilesToFS(editor.getAllFiles(), mainFile);

    // VPython/GlowScript programs take a separate path: glow library + the
    // vpython bridge + async rewriting, rendering 3D into the graphic pane.
    if (usesVPython(prog)) {
      runningIsVpython = true;  // mark cancellable so Run-while-running restarts
      return runVpython(prog);
    }

    if (importsPackages(prog)) {
      writeOut('Loading packages…\n');
    }

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
    var msg = (err && (err.message || err.toString())) || 'Error';
    if (jqconsole) {
      jqconsole.Write('\n' + msg + '\n', 'jqconsole-error', false);
    }
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
  // Pyodide has no simple interrupt for an in-flight coroutine in this slice.
  writeOut('\n[stop is not supported for Pyodide trinkets yet]\n');
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
    $(document).on('trinket.code.console', $.proxy(this.showResult, this));

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
    $('#output-dragbar').mousedown(function(e) {
      e.preventDefault();

      var containerHeight = $('.trinket-content-wrapper').height();
      var containerTop    = $('.trinket-content-wrapper').offset().top;
      var dragbarHeight   = $('#output-dragbar').height();

      $(document).on('mousemove.output-dragbar', function(e) {
        var topHeight    = e.pageY - containerTop - dragbarHeight / 2;
        var bottomHeight = containerHeight - topHeight - dragbarHeight / 2;
        if (topHeight >= 20 && bottomHeight >= 20) {
          $('#graphic-wrap').css('height', topHeight);
          $('#console-wrap').css('height', bottomHeight);
        }
      });

      $(document).on('mouseup.output-dragbar', function() {
        $(document).off('mousemove.output-dragbar mouseup.output-dragbar');
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
  showCode : function() {
    $('#codeOutput').addClass('hide');
    $('#editor').removeClass('hide');
    api.closeOverlay('#modules');
    api.focus();
  },
  showResult : function(event) {
    if (runOption !== 'run' && event && $(event.target).data('button') === 'run') {
      api.changeRunOption('run');
    }
    api.runMode = '';
    api.triggerRunModeChange();
    api.hasRun = true;

    $('#codeOutput').removeClass('hide');
    $('#editor').addClass('hide');

    api.closeOverlay('#modules');

    $('#instructionsContainer').addClass('hide');
    $('#outputContainer').removeClass('hide');

    $('#codeOutputTab').addClass('active');
    $('#instructionsTab').removeClass('active');
    hideVariables();  // a run always returns focus to the Result pane

    runCode();

    if (event) {
      api.callAnalytics('Interaction', 'Click', 'Run');
    }
  },
  stopExecution : function() {
    stopCode();
  },
  showTestResult : function() {},
  consoleResult : function(event) {
    this.showResult(event);
  },
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

    if (trinket.code && (start === 'result') && autoRun !== false) {
      this.showResult();
    }
    else {
      this.showCode();
      resetOutput();
    }
  },
  replaceMain : function(trinket) {
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
    var icon_classes = { run : 'fa fa-play', stop : 'fa fa-stop' };
    var titles = { run : 'View the result.', stop : 'Stop program.' };
    var labels = { run : 'Run', stop : 'Stop' };
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
