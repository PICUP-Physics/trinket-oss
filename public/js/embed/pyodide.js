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
// figure.autolayout keeps axis labels/titles from clipping (from PR #18).
// plt.close('all') ensures stale figures from a previous run don't resurface.
var MATPLOTLIB_SETUP_CODE = [
  "import matplotlib",
  "matplotlib.use('webagg')",
  "matplotlib.rcParams['figure.autolayout'] = True",
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
  // Clearing output while a step-through replay is active would otherwise
  // leave a half-state: blank console but replay-locked variables and live
  // step controls. Exit replay first (quiet — this reset IS the console
  // rewrite). No-op when replay isn't active.
  exitReplay(true);

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

// Detect a matplotlib import so we can point its render target at #graphic
// before the user's code runs. The package name can appear anywhere on an
// import line, not just first — e.g. `import numpy, matplotlib` or
// `from matplotlib import pyplot` — so match the whole (comment-stripped) line,
// not only the token right after import/from. Missing it here skips the
// render-target setup, so the figure falls back to document.body instead of the
// #graphic pane (see issue #21).
function usesMatplotlib(code) {
  return /(^|\n)\s*(import|from)\s+[^\n#]*\bmatplotlib\b/.test(code);
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
  // Completed with "ready" once the library + bridge have loaded (see #27).
  writeOut('Loading VPython (GlowScript)… ');
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
    // The GlowScript library + vpython bridge are ready now; complete the
    // loading line before Pyodide narrates any package installs below (#27).
    writeOut('ready\n');
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
  // KEEP IN SYNC with RECORD_HELPER's _SKIP + _snap_ns filters (the step
  // debugger's per-step snapshots): a runner-injected name added here but not
  // there makes the debugger show internals the explorer hides, or vice versa.
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
// Design: docs/pyodide-debugger-mvp.md. Clicking "Step through" re-runs the
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
  "_SKIP = {'__user_source__', '_plt', '_vpy', '_js_scene', '_wrapped_rate'}",
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
  // sail past the cap into a multi-MB JSON) plus per-step dict overhead.
  '    _size[0] += (_buf.tell() - _last_out[0]) + 40',
  '    _last_out[0] = _buf.tell()',
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
  "json.dumps({'error': _err, 'truncated': _truncated[0], 'output': _buf.getvalue(), 'steps': _steps, 'snaps': _snaps})"
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
    var files = editor.getAllFiles();
    if (!files || !files.hasOwnProperty(file)) {
      // Not open in the editor (e.g. hidden file): step without a highlight
      // rather than marking a line in the wrong file.
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

  var prev = {};
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
      // rebuild from scratch.
      jqconsole.Reset();
      jqconsole.Append(loadingHeader());
      jqconsole.Write(debugRec.output.slice(0, st.out));
      if (wantErr) {
        jqconsole.Write('\n' + debugRec.error + '\n', 'jqconsole-error', false);
      }
    } else if (st.out > debugLastOut) {
      // Forward over new output: append just the delta.
      jqconsole.Write(debugRec.output.slice(debugLastOut, st.out));
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
  var note = '';
  if (rec.truncated) note = 'recording stopped after ' + (rec.steps.length - 1) + ' steps';
  else if (rec.error) note = 'ends with an error';
  $('#debug-note').text(note);
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
  $('#debug-note').text('');
  $('#debug-launch').removeClass('hide');
  $('#debug-recording').addClass('hide');
  // Restore the console to the full recorded output and the table to the live
  // post-run explorer view.
  if (!quiet && jqconsole) {
    jqconsole.Reset();
    jqconsole.Append(loadingHeader());
    jqconsole.Write(rec.output);
    if (rec.error) jqconsole.Write('\n' + rec.error + '\n', 'jqconsole-error', false);
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
            _max_steps: DEBUG_MAX_STEPS,
            _max_vars: DEBUG_MAX_VARS,
            _max_repr: DEBUG_MAX_REPR,
            _max_depth: DEBUG_MAX_DEPTH,
            _max_bytes: DEBUG_MAX_BYTES
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

  var showedRuntimeLoading = !pyodideReady;
  if (showedRuntimeLoading) {
    // No trailing newline: the line is completed with "ready" once the runtime
    // has loaded, so the "…" never lingers in the output as if it were still
    // working after the program's results have already printed (#27).
    writeOut('Loading Python (Pyodide)… ');
  }

  running = true;

  ensurePyodide().then(function() {
    if (showedRuntimeLoading) {
      writeOut('ready\n');
    }
    var prog = syncFilesToFS(editor.getAllFiles(), mainFile);

    // VPython/GlowScript programs take a separate path: glow library + the
    // vpython bridge + async rewriting, rendering 3D into the graphic pane.
    if (usesVPython(prog)) {
      runningIsVpython = true;  // mark cancellable so Run-while-running restarts
      return runVpython(prog);
    }

    // Auto-install any Pyodide-bundled packages the code imports (numpy,
    // matplotlib, pandas, …) from the CDN before running. Pyodide narrates this
    // itself ("Loading …" then "Loaded …"), which already reads as complete, so
    // we no longer add our own "Loading packages…" line — that one had no
    // matching completion and lingered as if still working (#27).
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

        // Arrow-key stepping while replaying (ignored while typing in the
        // editor or any input, so it never hijacks code editing).
        $(document).on('keydown.stepDebugger', function(e) {
          if (!debugRec) return;
          if (e.which !== 37 && e.which !== 39) return;
          var t = $(e.target);
          if (t.is('input, textarea') || t.closest('.ace_editor').length) return;
          e.preventDefault();
          debugStepTo(debugIdx + (e.which === 39 ? 1 : -1));
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
    hideVariables();     // a run always returns focus to the Result pane
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
