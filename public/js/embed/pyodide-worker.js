(function(root) {
  'use strict';

  // #108: the Pyodide kernel, off the main thread.
  //
  // This file must NEVER reference `document`, `window`, or GlowScript — it has
  // `self` only. Anything visual crosses the channel as a message and is
  // rendered by the page.
  //
  // Stop is not implemented here, deliberately. The page calls
  // worker.terminate(), which is unconditional and therefore works for
  // `while True: pass` — the case cooperative cancellation can never reach,
  // because a loop with no yield point never lets the page run at all.
  //
  // Tracebacks are sent RAW. The page owns formatPythonTraceback() and
  // escapeConsoleHtml(); formatting here would let the two runtimes drift.

  var PROTOCOL_VERSION = 1;

  // Pure so it can be unit-tested; the live path is a browser spec.
  function buildRunReply(id, result) {
    if (result && result.ok === false) {
      return { type: 'error', id: id, traceback: result.traceback };
    }
    return { type: 'done', id: id };
  }

  // ---- worker runtime (skipped entirely when required from node) -----------
  if (typeof self !== 'undefined' && typeof self.importScripts === 'function') {
    var pyodide = null;
    var currentRunId = null;
    var varsHelper = '';

    var post = function(msg) { self.postMessage(msg); };

    var boot = function(msg) {
      self.importScripts(msg.pyodideUrl);
      return self.loadPyodide({ indexURL: msg.indexURL }).then(function(py) {
        pyodide = py;
        // Batched, exactly as the in-window runner does, so partial lines are
        // not emitted one character at a time.
        pyodide.setStdout({ batched: function(s) { post({ type: 'stdout', text: s + '\n' }); } });
        pyodide.setStderr({ batched: function(s) { post({ type: 'stderr', text: s + '\n' }); } });
        // The page owns VARS_HELPER; it is sent here so the two runtimes cannot
        // drift into showing different variables for the same program.
        varsHelper = msg.varsHelper || '';

        // Both versions: the REPL banner names the PYTHON version ("Python
        // 3.13.2"), which is not pyodide.version ("0.28.1").
        var pythonVersion = '';
        try {
          pythonVersion = pyodide.runPython('import sys; sys.version.split()[0]');
        } catch (e) { pythonVersion = ''; }

        post({
          type: 'ready',
          v: PROTOCOL_VERSION,
          pyodideVersion: pyodide.version,
          pythonVersion: pythonVersion
        });
      }).catch(function(err) {
        post({ type: 'error', id: null, traceback: 'Failed to start Python: ' + String(err && err.message || err) });
      });
    };

    // ---- input() without SharedArrayBuffer ---------------------------------
    //
    // An embed can never be crossOriginIsolated (an iframe is only isolated if
    // the TOP page is), so Atomics.wait is unavailable and input() cannot block.
    // Instead it becomes awaitable: the page answers `input-request` with
    // `stdin-reply`, and this promise resolves.
    var pendingInput = null;

    self.__trinket_worker_input = function(prompt) {
      post({ type: 'input-request', id: currentRunId, prompt: String(prompt || '') });
      return new Promise(function(resolve) { pendingInput = resolve; });
    };

    // The prompt is NOT printed from Python. Pyodide's batched stdout only
    // flushes on a newline, and a prompt has none — so `print(prompt, end="")`
    // stayed buffered and appeared AFTER the student's answer. The page writes
    // it instead, from the prompt text carried on the input-request message.
    var INPUT_SETUP = [
      'import builtins, js',
      'async def _trinket_input(prompt=""):',
      '    return await js.__trinket_worker_input(prompt)',
      'builtins.input = _trinket_input'
    ].join('\n');

    // The async transform rewrites blocking-looking calls to `await`. Its await
    // set is a module constant that deliberately EXCLUDES bare `input`, because
    // on the main thread input() is synchronous (window.prompt). Here it must be
    // awaited, so the set is extended — safe because this is the worker's own
    // interpreter and cannot affect the page's.
    var transformLoading = null;
    function ensureTransform(url) {
      if (transformLoading) return transformLoading;
      transformLoading = fetch(url)
        .then(function(r) { return r.text(); })
        .then(function(src) {
          pyodide.FS.writeFile('_trinket_async_transform.py', src);
          return pyodide.runPythonAsync([
            'import _trinket_async_transform as _t',
            '# Bare input() must be awaited HERE (the worker cannot block) though',
            '# not on the main thread, where it is window.prompt and synchronous.',
            '_t._BASE_AWAIT_NAMES = _t._BASE_AWAIT_NAMES | {"input"}',
            '_t._TRINKET_ORIG_MODULE_ATTRS = dict(_t._MODULE_AWAIT_ATTRS)',
            'from _trinket_async_transform import transform_source'
          ].join('\n'));
        })
        .catch(function(e) {
          // Never cache a failed load, or one transient fetch error poisons
          // every later run for the life of this worker.
          transformLoading = null;
          throw e;
        });
      return transformLoading;
    }

    // Only programs that actually read input need rewriting; everything else
    // runs unmodified, so the transform can't perturb an ordinary program.
    function needsTransform(src) {
      return /(^|[^.\w])input\s*\(/.test(src || '') || /\bconsole\s*\.\s*input\s*\(/.test(src || '');
    }

    // ---- matplotlib ---------------------------------------------------------
    //
    // The main thread uses the 'webagg' backend, which draws into
    // document.pyodideMplTarget. A worker has no document, so it renders
    // headlessly with Agg and ships each figure to the page as a PNG.
    //
    // The spec's follow-up swaps this payload for backend_webagg_core diffs —
    // the ipympl architecture — over this SAME `figure` message, so the seam
    // does not change when interactivity lands.
    // Static PNG, kept as the fallback path (see MPL_FALLBACK below).
    self.__trinket_worker_figure = function(b64) {
      post({ type: 'figure', id: currentRunId, figureId: 'fig', kind: 'png', data: String(b64) });
    };

    // Interactive path. Sub-kinds ride on the spec's `figure` message rather than
    // inventing new top-level types.
    var mplAssetsSent = false;
    self.__trinket_worker_mpl_assets = function(jsSrc, css, imagesJson) {
      if (mplAssetsSent) return;                 // one copy per worker is plenty
      mplAssetsSent = true;
      post({ type: 'figure', id: currentRunId, kind: 'assets',
             js: String(jsSrc), css: String(css), images: String(imagesJson || '{}') });
    };
    self.__trinket_worker_mpl_new = function(figid) {
      post({ type: 'figure', id: currentRunId, figureId: String(figid), kind: 'new' });
    };
    self.__trinket_worker_mpl = function(figid, sub, payload) {
      post({ type: 'figure', id: currentRunId, figureId: String(figid), kind: String(sub), data: String(payload) });
    };

    // Interactive figures, the ipympl way: backend_webagg_core is pure Python and
    // transport-agnostic — upstream webagg carries its messages over a WebSocket
    // from a Tornado server, ipympl over a Jupyter comm. We carry them over
    // postMessage, so the page gets matplotlib's real mpl.js frontend and its
    // whole toolbar (home / pan / zoom / save / format) with no document here.
    //
    // mpl.js and mpl.css are read from THIS matplotlib's own web_backend
    // directory, so the frontend can never skew from the backend driving it.
    // Pyodide's matplotlib PATCHES backend_webagg_core to do
    // `from js import alert, document` at module import — it is not the
    // transport-agnostic upstream module. The DOM is used only by its download
    // helper (building an <a> to save a file); the protocol machinery
    // (get_diff_image / handle_json / FigureManagerWebAgg) never touches it.
    //
    // Inert stubs therefore make the import succeed with nothing else lost:
    // saving is handled on the page from the canvas, which is where the real
    // download has to happen anyway.
    function installDomStubs() {
      if (typeof self.document === 'undefined') {
        self.document = {
          createElement: function() {
            return { style: {}, setAttribute: function() {}, click: function() {},
                     appendChild: function() {}, removeChild: function() {} };
          },
          body: { appendChild: function() {}, removeChild: function() {} }
        };
      }
      if (typeof self.alert === 'undefined') {
        self.alert = function() {};
      }
    }

    var MPL_SETUP = [
      'import matplotlib',
      "matplotlib.use('Agg')",              // a real canvas is never drawn here
      "matplotlib.rcParams['figure.autolayout'] = True",
      'try:',
      "    matplotlib.rcParams['figure.figsize'] = [__trinket_figw__, __trinket_figh__]",
      'except NameError:',
      '    pass',
      'import matplotlib.pyplot as _plt, io as _io, base64 as _b64, js as _js, json as _json, os as _os',
      'from matplotlib.backends import backend_webagg_core as _wac',
      '',
      '_trinket_managers = {}',
      '',
      '# Module level ON PURPOSE: inside a class body Python mangles any name',
      '# starting with two underscores, so `_js.__trinket_worker_mpl` would',
      '# become `_js._TrinketSocket__trinket_worker_mpl` and fail at runtime.',
      'def _trinket_mpl_send(figid, sub, payload):',
      '    _js.__trinket_worker_mpl(figid, sub, payload)',
      '',
      'class _TrinketSocket:',
      '    # matplotlib calls send_json/send_binary; supports_binary=False makes it',
      '    # hand us a base64 data URI, which mpl.js accepts as text — so no Blob',
      '    # plumbing is needed across postMessage.',
      '    supports_binary = False',
      '    def __init__(self, figid):',
      '        self.figid = figid',
      '    def send_json(self, content):',
      '        _trinket_mpl_send(self.figid, "json", _json.dumps(content))',
      '    def send_binary(self, blob):',
      '        _trinket_mpl_send(self.figid, "text",',
      '                          "data:image/png;base64," + _b64.b64encode(blob).decode())',
      '',
      'def _trinket_send_assets():',
      '    _wb = _os.path.join(_os.path.dirname(matplotlib.__file__), "backends", "web_backend")',
      '    # get_javascript() is mpl.js PLUS mpl.toolbar_items, mpl.extensions and',
      '    # the default filetype. Reading mpl.js off disk alone leaves',
      '    # toolbar_items undefined, and the toolbar renders with no buttons.',
      '    _js_src = _wac.FigureManagerWebAgg.get_javascript()',
      '    try:',
      '        with open(_os.path.join(_wb, "css", "mpl.css")) as _f:',
      '            _css = _f.read()',
      '    except OSError:',
      '        _css = ""',
      '    # mpl.js asks the EMBEDDER for toolbar icon URLs via',
      '    # mpl.toolbar_image_callback — upstream webagg has a Tornado server to',
      '    # serve them. We have none, so the icons ride along as data URIs.',
      '    _imgs = {}',
      '    _idir = _os.path.join(_wb, "images")',
      '    if _os.path.isdir(_idir):',
      '        for _name in _os.listdir(_idir):',
      '            if _name.endswith(".png"):',
      '                with open(_os.path.join(_idir, _name), "rb") as _f:',
      '                    _imgs[_name[:-4]] = _b64.b64encode(_f.read()).decode()',
      '    _js.__trinket_worker_mpl_assets(_js_src, _css, _json.dumps(_imgs))',
      '',
      'def _trinket_show(*a, **k):',
      '    _trinket_send_assets()',
      '    for _num in _plt.get_fignums():',
      '        _fig = _plt.figure(_num)',
      '        _figid = "fig" + str(_num)',
      '        if _figid in _trinket_managers:',
      '            continue',
      '        _canvas = _wac.FigureCanvasWebAggCore(_fig)',
      '        _manager = _wac.FigureManagerWebAgg(_canvas, _num)',
      '        _trinket_managers[_figid] = _manager',
      '        # Announce the figure BEFORE attaching the socket. add_web_socket',
      '        # starts sending immediately, and postMessage preserves order — so',
      '        # attaching first delivers draw messages for a figure the page has',
      '        # not created yet, and they are dropped.',
      '        _js.__trinket_worker_mpl_new(_figid)',
      '        _manager.add_web_socket(_TrinketSocket(_figid))',
      '        # The figure was already rendered by Agg before this manager',
      '        # existed, so no draw event will fire on its own and no image',
      '        # would ever be sent. Force the first frame -- SYNCHRONOUSLY:',
      '        # draw_idle() only SCHEDULES a draw for the next idle turn of',
      '        # the event loop. A program that never awaits after show() -- a',
      '        # tight `while True:` with no sleep/rate -- never reaches that',
      '        # turn, so refresh_all() below shipped an EMPTY buffer and the',
      '        # student saw a correctly sized canvas with nothing in it.',
      '        _canvas.draw()',
      '        _manager.refresh_all()',
      '',
      'def _trinket_mpl_event(figid, payload):',
      '    _m = _trinket_managers.get(figid)',
      '    if _m is None:',
      '        return',
      '    _evt = _json.loads(payload)',
      "    # Pyodide's FigureManagerWebAgg does not implement the binary",
      "    # negotiation and prints 'Unhandled message type supports_binary' to",
      '    # stderr — which lands in the student\'s console. Our socket already',
      '    # declines binary (supports_binary = False), so the message is moot.',
      "    if _evt.get('type') == 'supports_binary':",
      '        return',
      '    _m.handle_json(_evt)',
      '    # Upstream webagg has a Tornado event loop that pumps refresh_all();',
      '    # here nothing does, so a handled event (zoom, pan, home) updates the',
      '    # figure state and then never ships the redrawn frame. Pump it.',
      '    try:',
      '        _m.refresh_all()',
      '    except Exception:',
      '        pass',
      '',
      '_plt.show = _trinket_show'
    ].join('\n');

    // Any figure the program left open but never showed, flushed at the end —
    // the same courtesy the main thread does. Students routinely omit show().
    var MPL_FLUSH = [
      'import matplotlib.pyplot as _plt',
      'if _plt.get_fignums():',
      '    _plt.show()'
    ].join('\n');

    function usesMatplotlib(src) {
      return /(^|\n)\s*(import|from)\s+[^\n#]*\bmatplotlib\b/.test(src || '');
    }

    // ---- the REPL, in the worker -------------------------------------------
    //
    // The console's namespace lives here, so a runaway statement typed at the
    // prompt is killable by terminate() — the REPL's one documented limitation.
    // The cost is stated plainly to the student on stop: terminating discards
    // the interpreter, so the session's variables go with it.
    var replConsole = null;

    function ensureReplConsole() {
      if (!replConsole) {
        replConsole = pyodide.runPython(
          'from pyodide.console import PyodideConsole\n' +
          'PyodideConsole(globals())\n'
        );
      }
      return replConsole;
    }

    function pushRepl(msg) {
      currentRunId = msg.id;
      var console_;
      try {
        console_ = ensureReplConsole();
      } catch (err) {
        post({ type: 'error', id: msg.id, traceback: String(err && err.message || err) });
        return;
      }

      var result;
      try {
        result = console_.push(msg.source);
      } catch (err) {
        post({ type: 'error', id: msg.id, traceback: String(err && err.message || err) });
        return;
      }

      Promise.resolve(result)
        .then(function(value) {
          if (value !== undefined && value !== null) {
            // repr on the page would need the value itself; do it here and send
            // text, so nothing live has to cross the channel.
            post({ type: 'stdout', text: pyodide.runPython('repr')(value) + '\n' });
          }
          post({ type: 'done', id: msg.id });
        })
        .catch(function(err) {
          post({ type: 'error', id: msg.id, traceback: String(err && err.message || err) });
        });
    }

    var run = function(msg) {
      currentRunId = msg.id;

      // Secondary .py modules must exist in the worker's own filesystem before
      // the program imports them — the same job syncFilesToFS() does on the
      // main thread. The main file is passed as `source` and is not written.
      if (msg.files) {
        for (var name in msg.files) {
          if (!Object.prototype.hasOwnProperty.call(msg.files, name)) continue;
          if (!/\.py$/.test(name)) continue;
          try { pyodide.FS.writeFile(name, msg.files[name]); } catch (e) {}
        }
      }

      var source = msg.source || '';
      // Shadow guard, matching the main thread's userShadowsConsole(): if the
      // trinket ships its OWN console.py, `console.input()` is the student's
      // function, not ours. Awaiting it would be a hard error, so the namespaced
      // rule is dropped for this run. Bare input() is still the builtin and is
      // still awaited — the worker cannot block on it either way.
      var shadowsConsole = !!(msg.files &&
        Object.prototype.hasOwnProperty.call(msg.files, 'console.py'));

      var prepared = needsTransform(source)
        ? ensureTransform(msg.transformUrl).then(function() {
            pyodide.runPython(shadowsConsole
              ? '_t._MODULE_AWAIT_ATTRS = {}'
              : '_t._MODULE_AWAIT_ATTRS = dict(_t._TRINKET_ORIG_MODULE_ATTRS)');
            pyodide.globals.set('__user_source__', source);
            return pyodide.runPythonAsync(INPUT_SETUP).then(function() {
              return pyodide.runPython('transform_source(__user_source__)');
            });
          })
        : Promise.resolve(source);

      var mpl = usesMatplotlib(source);

      return prepared
        .then(function(src) {
          // Pyodide-bundled packages the program imports (numpy, matplotlib,
          // pandas, …) must be installed here too — the worker has its own
          // interpreter, so the main thread's loadPackagesFromImports does not
          // help it.
          return pyodide.loadPackagesFromImports(src).then(function() {
            if (mpl) {
              installDomStubs();
              // Default figure size chosen to fit the page's graphic pane. Only
              // the DEFAULT — a program setting its own figsize still wins.
              var gw = Number(msg.graphicWidth) || 0;
              if (gw > 200) {
                var inches = Math.max(2.4, (gw - 16) / 100);
                pyodide.globals.set('__trinket_figw__', inches);
                pyodide.globals.set('__trinket_figh__', Math.round(inches * 0.72 * 100) / 100);
              }
            }
            return mpl ? pyodide.runPythonAsync(MPL_SETUP).then(function() { return src; })
                       : src;
          });
        })
        .then(function(src) { return pyodide.runPythonAsync(src); })
        .then(function() {
          return mpl ? pyodide.runPythonAsync(MPL_FLUSH) : null;
        })
        .then(function() { post(buildRunReply(msg.id, { ok: true })); })
        .catch(function(err) {
          post(buildRunReply(msg.id, { ok: false, traceback: String(err && err.message || err) }));
        });
    };

    self.onmessage = function(e) {
      var msg = e.data || {};
      try {
        if (msg.type === 'init') { boot(msg); return; }

        if (msg.type === 'snapshot') {
          var json = null;
          if (pyodide && varsHelper) {
            var ns = null;
            try {
              ns = pyodide.toPy({ user_ns: pyodide.globals });
              json = pyodide.runPython(varsHelper, { globals: ns });
            } catch (e) {
              json = null;                 // an explorer failure must never break a run
            } finally {
              if (ns && typeof ns.destroy === 'function') { try { ns.destroy(); } catch (e) {} }
            }
          }
          post({ type: 'snapshot-result', id: msg.id, json: json });
          return;
        }

        if (msg.type === 'mpl-event') {
          if (pyodide) {
            pyodide.globals.set('__mpl_figid__', msg.figureId);
            pyodide.globals.set('__mpl_payload__', msg.content);
            try { pyodide.runPython('_trinket_mpl_event(__mpl_figid__, __mpl_payload__)'); } catch (e) {}
          }
          return;
        }

        if (msg.type === 'stdin-reply') {
          if (pendingInput) {
            var resolve = pendingInput;
            pendingInput = null;
            resolve(msg.value);
          }
          return;
        }

        if (msg.type === 'run') {
          if (!pyodide) {
            post({ type: 'error', id: msg.id, traceback: 'Python is not ready yet.' });
            return;
          }
          if (msg.mode === 'repl') { pushRepl(msg); } else { run(msg); }
          return;
        }

        // Reserved types are DEFINED by the spec but not implemented in v1.
        // Answer explicitly rather than dropping the message silently, so a
        // caller gets a diagnosable error instead of a hang.
        post({
          type: 'error',
          id: msg.id,
          traceback: 'message type not supported in runtime v' + PROTOCOL_VERSION + ': ' + msg.type
        });
      } catch (err) {
        post({ type: 'error', id: msg.id, traceback: String(err && err.message || err) });
      }
    };
  }

  var api = { buildRunReply: buildRunReply, PROTOCOL_VERSION: PROTOCOL_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
