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

  // The vpython scene channel, and the one thing on it the page cannot work out
  // for itself: whether a package is the REPLY to a trigger the page sent, or
  // something the PROGRAM pushed on its own (rate() flushes up to
  // rate_control.MAX_RENDERS a second from inside the animation loop).
  //
  // The page's pacer needs that to know when to get out of the way, and it
  // cannot infer it: trinket_worker._dispatch answers EVERY inbound message with
  // a flush, so inbound traffic alone never distinguishes a busy program from
  // the page's own echo.
  //
  // Implemented as a COUNT of dispatches still owed a reply rather than "are we
  // inside the dispatch call right now". The two are identical while _dispatch
  // is synchronous, which it is today — but decision V4 has JSPI in view, and
  // under it a dispatch could suspend and flush after returning. A boolean
  // would then mark every reply unsolicited, the pacer would alternate
  // tick/poll, and a static scene would silently drop to half its pacing with
  // nothing failing. The count survives that: what it relies on is the
  // transport's own contract — one flush per dispatch (trinket_worker._dispatch
  // ends with baseObj.trigger()) — not on JS call-stack timing.
  //
  // Pure so it can be unit-tested; the live path is a browser spec.
  function createSceneChannel(opts) {
    var owed = 0;        // dispatches that have not yet produced their flush
    var sends = 0;

    return {
      // The outbound half of the pipe vpython's trinket_worker transport
      // expects. The transport JSON-encodes every update package ({cmds,
      // methods, attrs} — glowcomm's wire format) and calls this.
      send: function(jsonStr) {
        sends++;
        var solicited = owed > 0;
        if (solicited) owed--;
        opts.post({ type: 'scene-ops', id: opts.runId(), generation: opts.generation(),
                    solicited: solicited, ops: String(jsonStr) });
      },

      // The page's browser events (or a bare pacing trigger) going in. Before
      // the transport boots — or on a run with no vpython at all — there is
      // nothing to dispatch to, and dropping the message is correct: it is
      // pacing, not data, and it must not be counted as owing a reply.
      dispatch: function(eventsJson) {
        var fn = opts.dispatcher();
        if (typeof fn !== 'function') return;
        owed++;
        var before = sends;
        try {
          fn(String(eventsJson || '[]'));
        } catch (e) {
          // It threw without flushing, so the reply is not merely late — it is
          // never coming. Give the credit back, or the next thing the PROGRAM
          // pushes would be mislabelled as this dispatch's reply.
          if (sends === before && owed > 0) owed--;
          opts.onError(e);
        }
      },

      _owed: function() { return owed; }    // test-only
    };
  }

  // ---- worker runtime (skipped entirely when required from node) -----------
  // Worker context detection. This used to test for importScripts, which a
  // MODULE worker does not have — so after the #215 conversion that guard would
  // skip the entire runtime and the worker would answer nothing, silently.
  // postMessage + no window is true in both worker flavours and false under node.
  if (typeof self !== 'undefined' && typeof self.postMessage === 'function' &&
      typeof window === 'undefined') {
    var pyodide = null;
    var currentRunId = null;
    var varsHelper = '';

    var post = function(msg) { self.postMessage(msg); };

    var boot = function(msg) {
      // Dynamic import of pyodide.mjs, the module build. importScripts is a
      // classic-worker API and 314.x refuses to load that way at all (#215).
      return import(msg.pyodideUrl).then(function(mod) {
        var load = (mod && mod.loadPyodide) || self.loadPyodide;
        return load({ indexURL: msg.indexURL });
      }).then(function(py) {
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
    //
    // VPython is the other case, and it is decided by the RUN, not by this
    // regex — see wantsTransform() below.
    function needsTransform(src) {
      return /(^|[^.\w])input\s*\(/.test(src || '') || /\bconsole\s*\.\s*input\s*\(/.test(src || '');
    }

    // A vpython run ALWAYS gets the transform. rate()/sleep() are coroutines in
    // the worker (trinket_worker's transport patches), so without an inserted
    // `await` the program builds a coroutine per iteration and throws it away:
    // no pacing, no flush — the animation never draws and the loop hot-spins.
    //
    // Keyed off msg.vpython rather than a widened source regex on purpose. The
    // transform's await set contains the BARE names `rate` and `sleep`, so a
    // regex hit on `rate(` would also fire for an ordinary python3 program that
    // defines its own rate() — and `await`ing a function that returns a plain
    // value is a TypeError at runtime, i.e. the transform would break a working
    // program. msg.vpython is set only by the router, only for a run it has
    // already classified as VPython, so it cannot mis-fire on a non-vpython
    // program at all.
    function wantsTransform(msg, src) {
      return !!(msg && msg.vpython) || needsTransform(src);
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

    // ---- vpython (spec 2026-08-10) ------------------------------------------
    //
    // vpython runs execute against the vpython-jupyter wheel (spec 2026-08-10).
    // Idempotent per worker: micropip is a no-op if already installed.
    //
    // deps=False is REQUIRED: the wheel declares the jupyter-stack dependencies
    // vpython needs on a notebook (ipykernel, jupyter-server-proxy, …) and
    // micropip cannot resolve them here. The worker path uses none of them —
    // the transport talks over postMessage, not a comm.
    var vpythonReady = null;
    function ensureVPython(wheelUrl) {
      if (vpythonReady) return vpythonReady;
      vpythonReady = pyodide.loadPackage(['numpy', 'micropip']).then(function() {
        pyodide.globals.set('__vpy_wheel__', wheelUrl);
        return pyodide.runPythonAsync(
          'import micropip\n' +
          'await micropip.install(__vpy_wheel__, deps=False)\n'
        );
      }).catch(function(e) {
        // Never cache a failed install, or one transient fetch error poisons
        // every later vpython run for the life of this worker.
        vpythonReady = null;
        // A raw micropip failure would reach the page as a Python traceback
        // whose frames are all site-packages — and formatPythonTraceback maps
        // the synthetic <exec> frame to main.py, so the student would be shown
        // "File main.py, line 2" above micropip internals, for a failure that
        // has nothing to do with their program. Send one plain sentence
        // instead: with no frame lines in it the formatter passes it through
        // untouched.
        //
        // A Pyodide PythonError's `.message` is the WHOLE traceback, so only
        // its last line (the `SomeError: text` one) is quoted — embedding the
        // rest would reintroduce exactly the frames this exists to suppress.
        var raw = String(e && e.message || e).split('\n');
        var reason = '';
        for (var li = raw.length - 1; li >= 0 && !reason; li--) {
          if (raw[li].trim()) reason = raw[li].trim();
        }
        throw new Error('VPython could not be loaded in the worker runtime ' +
          '(the vpython package failed to install: ' + reason +
          '). This is a site problem, not an error in your program.');
      });
      return vpythonReady;
    }

    // The scene a program draws into. The page bumps this on every re-run, so
    // ops belonging to a scene it has already torn down are identifiable as
    // stale. A vpython re-run also discards this whole worker (spec V7a), so the
    // tag is no longer guarding against a surviving Python namespace — it guards
    // against messages ALREADY POSTED when that happened, which terminate()
    // cannot un-post.
    var sceneGeneration = 0;

    // The scene channel (see createSceneChannel above). `ops` rides out on the
    // protocol's RESERVED `scene-ops` type, carried as the raw JSON string: the
    // page parses it once, into the object the front-end factory takes.
    var sceneChannel = createSceneChannel({
      post: post,
      runId: function() { return currentRunId; },
      generation: function() { return sceneGeneration; },
      dispatcher: function() { return self.__trinket_vpython_dispatch; },
      onError: function(e) {
        post({ type: 'stderr', id: currentRunId,
               text: '[vpython dispatch] ' + String(e && e.message || e) + '\n' });
      }
    });

    self.__trinket_vpython_send = sceneChannel.send;

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
        // Not a no-op. matplotlib's download helper calls alert() for the
        // "cannot determine mimetype" case, and a stub that swallows it makes
        // an unsupported format indistinguishable from a successful save --
        // the same silence that made #252 hard to find. The save path above
        // never reaches this (it swallows the message before handle_json, so
        // the patched Python handle_save never runs), but anything else in the
        // wheel that alerts would be mute too. stderr lands in the student's
        // console via worker-client's onStderr.
        self.alert = function(text) {
          post({ type: 'stderr', text: String(text) + '\n' });
        };
      }
    }

    var MPL_SETUP = [
      'import matplotlib',
      "matplotlib.use('Agg')",              // a real canvas is never drawn here
      "matplotlib.rcParams['figure.autolayout'] = True",
      // A FIXED default figure size, not one derived from the pane. Deriving it
      // from the pane -- which is what this did until the dpi pane fit landed --
      // makes figsize, and therefore every download, depend on how wide the
      // output pane happened to be when Run was pressed: drag the divider,
      // re-run, and the figure is RE-COMPOSED, because text is in absolute
      // points and a smaller canvas gives the same label a larger share of the
      // picture. Two students running identical code got different figures.
      //
      // 4.8 x 3.6 rather than matplotlib's 6.4 x 4.8: it is close to what the
      // pane-derived default produced at a typical window (measured 4.66 x 3.36
      // at a 482-px pane), so most students see no change, and the dpi floor
      // engages far less often than 6.4 in would. The pane is fitted by scaling
      // figure.dpi instead, which changes scale without touching composition.
      "matplotlib.rcParams['figure.figsize'] = [4.8, 3.6]",
      // savefig.dpi so a Download is print-usable rather than screen-sized, and
      // so the toolbar never has to fall back to figure.dpi -- which one SVG or
      // PDF export poisons, because print_figure builds a fresh canvas and its
      // __init__ rewrites figure._original_dpi.
      "matplotlib.rcParams['savefig.dpi'] = 300",
      'import matplotlib.pyplot as _plt, io as _io, base64 as _b64, js as _js, json as _json, os as _os',
      // Figures belong to a RUN, and MPL_SETUP runs once per run (see the
      // loadPackagesFromImports chain below), so this sits exactly where
      // _plt.close('all') sits in the main thread's MATPLOTLIB_SETUP_CODE and
      // gives the two runtimes the same figure lifetime: cleared when the next
      // PLOTTING run starts, not at the end of the run that drew it, so the
      // toolbar's Save still has a figure to deliver in between.
      //
      // Without it, pyplot keeps the previous run's figure while
      // _trinket_managers below is reset -- so run two draws on top of run one
      // and nothing can close it afterwards. #255.
      "_plt.close('all')",
      'from matplotlib.backends import backend_webagg_core as _wac',
      '',
      '_trinket_managers = {}',
      '',
      // FigureManagerWebAgg in backend_webagg_core has `_toolbar2_class = None`;
      // it is backend_webagg (the server-backed one we do not use) that sets it.
      // So the manager Trinket builds has no toolbar object, and
      // handle_toolbar_button does getattr(None, name)() -> AttributeError,
      // swallowed by the empty `except` around the event dispatch. Home, Back,
      // Forward, Pan and Zoom have therefore never done anything on this
      // runtime -- they render, they take the click, and nothing happens.
      'class _TrinketFigureManager(_wac.FigureManagerWebAgg):',
      '    _toolbar2_class = _wac.NavigationToolbar2WebAgg',
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
      '        _manager = _TrinketFigureManager(_canvas, _num)',
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
      '    # The toolbar Save button (#252). Pyodide patches mpl.js so Save posts',
      "    # {type:'save'} to Python, and patches Python's handle_save to render",
      "    # the figure and deliver it with document.createElement('a'). On this",
      '    # side `document` is the inert stub installed above, so that anchor is',
      '    # built against nothing and clicked into nothing: the button is a',
      '    # silent no-op, and there is otherwise no way to export a figure from',
      '    # a worker run at all. Swallow it before handle_json the same way',
      '    # supports_binary is swallowed, render here, and hand the bytes to the',
      '    # page, which has a real document to download them with.',
      '    #',
      '    # The dpi is resolved rather than left to matplotlib: see',
      '    # _trinket_savefig_dpi, defined below in this same setup string',
      '    # (pyodide-worker.js:627) -- not above it.',
      "    if _evt.get('type') == 'save':",
      "        _fmt = str(_evt.get('format') or 'png')",
      '        try:',
      '            _sbuf = _io.BytesIO()',
      '            _m.canvas.figure.savefig(_sbuf, format=_fmt, dpi=_trinket_savefig_dpi())',
      "            _trinket_mpl_send(figid, 'save', _json.dumps(",
      "                {'format': _fmt, 'b64': _b64.b64encode(_sbuf.getvalue()).decode()}))",
      '        except Exception as _err:',
      "            _trinket_mpl_send(figid, 'save-error', str(_err))",
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
      "# #283: tight_layout's first pass after Home/Back/Forward reproduces the",
      "# PREVIOUS layout, because ax.get_tightbbox is stale until a draw has run at",
      "# the restored limits; the restored axes position is then overwritten and the",
      "# x mapping lands a few percent off (measured +3.3% worker, +2.2% main). A",
      "# second pass in the same draw is exact. Scoped to the draw that follows a",
      "# nav-stack restore: _update_view flags the figure, execute() consumes the",
      "# flag. Ordinary draws pay one pass as before; with figure.autolayout off the",
      "# engine is never instantiated and none of this runs.",
      "#",
      "# The helper names below STAY in globals. They have to: the two wrappers",
      "# resolve _le_exec, _nav_update_view and _le from globals at CALL time, so",
      "# deleting them raises NameError on the first Home (checked). They are",
      "# also invisible where it would matter -- the Variables tab is filtered by",
      "# VARS_HELPER (pyodide.js:1714), which the page sends to this worker at",
      "# pyodide-worker.js:115 and which drops modules and functions by type; all",
      "# six are one or the other. NOT _snap_ns, which is RECORD_HELPER's",
      "# (pyodide.js:2144) and runs only on the main thread. (This block keeps",
      "# its own helpers too -- _wac, _trinket_managers and the rest.)",
      "import matplotlib.layout_engine as _le",
      "from matplotlib import backend_bases as _bb",
      "if not getattr(_le.TightLayoutEngine, '_trinket_relayout_patched', False):",
      "    _le_exec = _le.TightLayoutEngine.execute",
      "    def _trinket_layout_execute(self, fig):",
      "        _le_exec(self, fig)",
      "        if getattr(fig, '_trinket_relayout', False):",
      "            fig._trinket_relayout = False",
      "            _le_exec(self, fig)",
      "    _le.TightLayoutEngine.execute = _trinket_layout_execute",
      "    _le.TightLayoutEngine._trinket_relayout_patched = True",
      "    _nav_update_view = _bb.NavigationToolbar2._update_view",
      "    def _trinket_update_view(self):",
      "        # Only when the tight engine is actually in charge. plotpolish's",
      "        # 'Fit labels in figure' toggle calls fig.set_layout_engine() on a",
      "        # LIVE figure, so a restore while it is off would leave the flag set",
      "        # with nothing to consume it, and the next ordinary draw after the",
      "        # student turned it back on would pay a pass it does not need.",
      "        _f = self.canvas.figure",
      "        if isinstance(_f.get_layout_engine(), _le.TightLayoutEngine):",
      "            _f._trinket_relayout = True",
      "        return _nav_update_view(self)",
      "    _bb.NavigationToolbar2._update_view = _trinket_update_view",
      '',
      "# ---- the dpi pane fit -------------------------------------------------------",
      "#",
      "# The pane sets SCALE, the student's corner drag sets SHAPE. Fitting the pane",
      "# by figsize -- which is what matplotlib's own handle_resize does -- silently",
      "# RE-COMPOSES the figure, because text is in absolute points: the same label on",
      "# a smaller canvas takes a larger share of the picture, so the download ends up",
      "# depending on the browser window. Scaling dpi changes scale only; the picture",
      "# is identical, just bigger or smaller. This is matplotlib's own idiom --",
      "# backend_bases._set_device_pixel_ratio is exactly dpi = ratio * _original_dpi.",
      "if not getattr(_wac.FigureCanvasWebAggCore, '_trinket_panefit_patched', False):",
      "    def _trinket_pane_fit(self, event):",
      "        _f = self.figure",
      "        _fw, _fh = _f.get_size_inches()",
      "        _dpr = float(event.get('dpr') or 1) or 1.0",
      "        _w = float(event.get('w') or 0)",
      "        _h = float(event.get('h') or 0)",
      "        if _fw <= 0 or _fh <= 0 or _w <= 0 or _h <= 0:",
      "            return",
      "        # The page sends the PANE, not a dpi, and the division happens here",
      "        # against the figure's CURRENT size -- so a student writing",
      "        # plt.figure(figsize=(10, 3)) is fitted rather than rendered at twice",
      "        # the pane. Both dimensions bound it; the page has already subtracted",
      "        # the figure's own title bar and toolbar from the height.",
      "        _logical = min(_w / _fw, _h / _fh)",
      "        # Floor the LOGICAL dpi and only then multiply. Legibility is a",
      "        # function of dpi/dpr, because a device pixel is not a unit anyone",
      "        # reads. Flooring the DEVICE dpi instead leaves the floor inactive",
      "        # exactly where it is needed: at a 200-px pane on a retina screen it",
      "        # lets 10 pt fall to 5.8 CSS px while reporting the floor satisfied.",
      "        if _logical < 72:",
      "            _logical = 72",
      "        _f._set_dpi(_logical * _dpr, forward=False)",
      "        # forward=False above means the browser has not been told; this is what",
      "        # tells it, and it is what provokes the echo the page marks below.",
      "        self.manager.resize(int(_fw * _f.dpi), int(_fh * _f.dpi))",
      "        self._force_full = True",
      "        self.draw_idle()",
      "    _wac.FigureCanvasWebAggCore.handle_trinket_pane_fit = _trinket_pane_fit",
      "",
      "    _trinket_prev_resize = _wac.FigureCanvasWebAggCore.handle_resize",
      "    def _trinket_handle_resize(self, event):",
      "        # mpl.js's ResizeObserver cannot tell our fit from the student dragging",
      "        # the figure's corner -- both arrive as {type:'resize'} -- so the PAGE",
      "        # classifies them, by pointer order, and marks its own fit's echo.",
      "        #",
      "        # Without this the echo reaches handle_resize, which recomputes figsize",
      "        # from twice-truncated pixels, and figsize RATCHETS DOWN on every fit:",
      "        # measured 4.66 in -> 4.5682 in over five fits at dpr 2, with the",
      "        # explicit-dpi export moving 466x336 -> 463x333. That is \"figsize",
      "        # FIXED\" quietly broken, and quieter than the bug it replaced.",
      "        if event.get('trinket_fit_echo'):",
      "            return",
      "        return _trinket_prev_resize(self, event)",
      "    _wac.FigureCanvasWebAggCore.handle_resize = _trinket_handle_resize",
      "    _wac.FigureCanvasWebAggCore._trinket_panefit_patched = True",
      "# savefig.dpi can be the STRING 'figure', which matplotlib resolves to",
      "# figure._original_dpi -- and the pane fit makes that unreliable. Every canvas",
      "# construction rewrites _original_dpi, and print_figure builds a FRESH canvas",
      "# for svg and pdf, so one vector export leaves it holding the fitted DEVICE",
      "# dpi. Measured: a post-SVG 'figure' export gave 960x720 on the worker and",
      "# 949x712 on the main thread -- twice the CSS size, and dependent on both the",
      "# pane at export time and the display density. Before any vector export the",
      "# same choice gives 480x360, so the student's file silently changes meaning.",
      "#",
      "# Resolved here to the figure's COMPOSED density, rcParams['figure.dpi'],",
      "# which the fit never touches -- so 'figure' means what a student picking it",
      "# would expect, and keeps meaning it.",
      "def _trinket_savefig_dpi():",
      "    _d = matplotlib.rcParams['savefig.dpi']",
      "    if isinstance(_d, bool) or not isinstance(_d, (int, float)):",
      "        return matplotlib.rcParams['figure.dpi']",
      "    return _d",
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

      // A vpython run draws into the scene the page has just created; ops are
      // tagged with its generation so the page can drop any that arrive from a
      // scene it has already torn down. Absent (any non-vpython run) means 0.
      if (msg.vpython) { sceneGeneration = msg.sceneGeneration | 0; }

      var prepare = function() { return wantsTransform(msg, source)
        ? ensureTransform(msg.transformUrl).then(function() {
            pyodide.runPython(shadowsConsole
              ? '_t._MODULE_AWAIT_ATTRS = {}'
              : '_t._MODULE_AWAIT_ATTRS = dict(_t._TRINKET_ORIG_MODULE_ATTRS)');
            pyodide.globals.set('__user_source__', source);
            return pyodide.runPythonAsync(INPUT_SETUP).then(function() {
              return pyodide.runPython('transform_source(__user_source__)');
            });
          })
        : Promise.resolve(source); };

      var mpl = usesMatplotlib(source);

      // The wheel install comes FIRST and the source preparation is built after
      // it resolves, so micropip's runPythonAsync never interleaves with the
      // transform's.
      return (msg.vpython ? ensureVPython(msg.wheelUrl) : Promise.resolve())
        .then(prepare)
        .then(function(src) {
          // Pyodide-bundled packages the program imports (numpy, matplotlib,
          // pandas, …) must be installed here too — the worker has its own
          // interpreter, so the main thread's loadPackagesFromImports does not
          // help it.
          return pyodide.loadPackagesFromImports(src).then(function() {
            // The figure size used to be computed here from msg.graphicWidth,
            // once, before the program ran. The pane is now fitted by scaling
            // figure.dpi after the figure exists (handle_trinket_pane_fit in
            // MPL_SETUP), so the size is a fixed rcParam and the pane no longer
            // reaches into it. graphicWidth is still sent -- the page uses it
            // for the first fit -- but nothing in here reads it.
            if (mpl) { installDomStubs(); }
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

        // Inbound half of the vpython pipe (spec 2026-08-10).
        // The page sends browser events (or a bare pacing trigger) on the
        // RESERVED `scene-event` type; vpython's trinket_worker transport set
        // __trinket_vpython_dispatch when it booted. See createSceneChannel for
        // what happens before that boot, and for the reply accounting.
        if (msg.type === 'scene-event') {
          sceneChannel.dispatch(msg.events);
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

  var api = { buildRunReply: buildRunReply, createSceneChannel: createSceneChannel,
              PROTOCOL_VERSION: PROTOCOL_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
