(function(root) {
  'use strict';

  // #108: page side of the worker channel. Owns the worker's lifecycle and
  // correlates replies to runs.
  //
  // Stop is worker.terminate() — unconditional, and the whole reason this
  // exists. A terminated worker cannot be reused, so a replacement is created
  // lazily on the next run.

  var PROTOCOL_VERSION = 1;   // must match pyodide-worker.js
  var seq = 0;

  function createWorkerClient(options) {
    var opts = options || {};
    var WorkerCtor = opts.WorkerCtor || (typeof Worker !== 'undefined' ? Worker : null);
    if (!WorkerCtor) throw new Error('Web Workers are not available');

    var worker = null;
    var current = null;        // { id, resolve } for the in-flight run
    var ready = false;         // has THIS worker finished booting Pyodide?
    var readyInfo = null;      // the ready message (carries pyodideVersion)
    var pending = {};          // id -> resolve, for request/response messages
    var readyWaiters = [];     // resolvers waiting on that boot

    function settle() {
      var run = current;
      current = null;
      if (run) run.resolve();
    }

    function onMessage(e) {
      var msg = (e && e.data) || {};

      // Lifecycle and streaming messages are not tied to a specific run.
      if (msg.type === 'ready') {
        ready = true;
        readyInfo = msg;
        var waiters = readyWaiters;
        readyWaiters = [];
        waiters.forEach(function(resolve) { resolve(); });
        if (opts.onReady) opts.onReady(msg);
        return;
      }
      if (msg.type === 'stdout') { if (opts.onStdout) opts.onStdout(msg.text); return; }
      if (msg.type === 'stderr') { if (opts.onStderr) opts.onStderr(msg.text); return; }

      // input() cannot block in a worker — there is no SharedArrayBuffer in an
      // embed, so Atomics.wait is unavailable. The worker suspends on a promise
      // and we answer it here. Scoped to the current run so a prompt from a
      // worker we already replaced is ignored rather than answered.
      if (msg.type === 'input-request') {
        if (!current || msg.id !== current.id) return;
        var answer = opts.onInputRequest
          ? Promise.resolve(opts.onInputRequest(msg.prompt))
          : Promise.resolve('');          // never hang on a prompt nobody can answer
        answer.then(function(value) {
          // A stop may have replaced the worker while the student was typing.
          if (worker && current && current.id === msg.id) {
            worker.postMessage({ type: 'stdin-reply', id: msg.id, value: String(value) });
          }
        });
        return;
      }

      // A figure belongs to a run, so it is scoped like input-request: a figure
      // from a worker we already replaced must not paint over the new run's
      // output. (The plan suggested rendering figures unconditionally; scoping
      // them is strictly safer and costs nothing.)
      if (msg.type === 'figure') {
        if (!current || msg.id !== current.id) return;
        if (opts.onFigure) opts.onFigure(msg);
        return;
      }

      // Scene updates from the vpython transport. NOT scoped to `current` like
      // figures — deliberately: a vpython scene outlives its run (the program
      // ends, the scene stays live and browser-paced), so ops legitimately
      // arrive after settle() nulls `current`. Staleness is handled by the
      // `generation` tag the kernel stamps on every package instead: the page
      // bumps the generation on re-run and drops ops from an older scene.
      if (msg.type === 'scene-ops') {
        if (opts.onSceneOps) opts.onSceneOps(msg);
        return;
      }

      // Request/response replies (the variable explorer). Not tied to a run:
      // they are asked for AFTER a run finishes, when the worker is idle.
      if (msg.type === 'snapshot-result') {
        var done = pending[msg.id];
        if (!done) return;
        delete pending[msg.id];
        var parsed = [];
        try { parsed = msg.json ? JSON.parse(msg.json) : []; } catch (e) { parsed = []; }
        done(parsed);
        return;
      }

      // A boot failure carries no run id — it happened before any run existed.
      // The id check below would drop it, leaving the page waiting on a worker
      // that will never become ready. Report it and settle whatever is waiting.
      if (msg.type === 'error' && (msg.id === null || msg.id === undefined)) {
        if (opts.onError) opts.onError(msg.traceback);
        settle();
        return;
      }

      // Everything below completes a run. A reply from a worker we already
      // replaced carries a stale id and must NOT settle the current run —
      // otherwise stopping and immediately re-running would end the new run the
      // moment the dead worker's last message arrived.
      if (!current || msg.id !== current.id) return;

      if (msg.type === 'error') {
        if (opts.onError) opts.onError(msg.traceback);
        settle();
        return;
      }
      if (msg.type === 'done') { settle(); return; }
    }

    function ensureWorker() {
      if (worker) return worker;
      ready = false;
      readyWaiters = [];
      // A MODULE worker. Pyodide 314.x (Python 3.14) dropped classic workers
      // outright ("Classic web workers are not supported"), and a module worker
      // boots fine at 0.28.1, 0.29.4 and 314.0.6 alike — so this is backward
      // compatible and can land before any version bump (picup #215).
      worker = new WorkerCtor(opts.workerUrl, { type: 'module' });
      worker.onmessage = onMessage;
      worker.postMessage({
        type: 'init',
        v: PROTOCOL_VERSION,
        pyodideUrl: opts.pyodideUrl,
        indexURL: opts.indexURL,
        // The page owns the variable-explorer helper source; the worker runs it
        // verbatim so the two runtimes cannot show different variables.
        varsHelper: opts.varsHelper || ''
      });
      return worker;
    }

    // Booting Pyodide in the worker takes seconds. A `run` posted before that
    // finishes is answered "Python is not ready yet", so runs wait here instead.
    function whenReady() {
      if (ready) return Promise.resolve();
      return new Promise(function(resolve) { readyWaiters.push(resolve); });
    }

    ensureWorker();

    return {
      run: function(source, files, opts2) {
        var w = ensureWorker();
        var id = 'run-' + (++seq);
        return new Promise(function(resolve) {
          current = { id: id, resolve: resolve };
          whenReady().then(function() {
            // stop() may have replaced the worker, or another run started,
            // while Pyodide was still booting.
            if (worker === w && current && current.id === id) {
              var runMsg = { type: 'run', id: id, source: source, files: files || null,
                             transformUrl: opts.transformUrl,
                             graphicWidth: (opts2 && opts2.graphicWidth) || 0 };
              // The worker VPython path (spec 2026-08-10) needs the wheel to
              // install and the scene generation to tag its ops with. Added
              // ONLY for a vpython run, so an ordinary python3 run message is
              // byte-for-byte what it always was.
              if (opts2 && opts2.vpython) {
                runMsg.vpython = true;
                runMsg.wheelUrl = opts2.wheelUrl;
                runMsg.sceneGeneration = opts2.sceneGeneration | 0;
              }
              w.postMessage(runMsg);
            }
          });
        });
      },

      // Unconditional. Works for `while True: pass`, which cooperative
      // cancellation can never reach.
      stop: function() {
        if (worker) { worker.terminate(); worker = null; }
        settle();
      },

      // Throw the interpreter away WITHOUT it being a Stop: the next run() boots
      // a fresh one, with a fresh Python namespace.
      //
      // Same mechanism as stop() and named differently on purpose — the caller's
      // intent is "start clean", not "kill what is running", and the two are read
      // in very different places. The worker VPython path (spec 2026-08-10) is
      // the one caller: on this host a Run is a fresh program from the top, and
      // vpython's `scene = canvas()` at import time makes that unavoidable
      // besides (see V7a in the design spec). Ordinary python3 runs never call
      // this and keep their accumulating namespace.
      //
      // Returns whether there WAS an interpreter to discard, so the page can
      // tell a student whose console session just went with it — and stay quiet
      // when nothing was lost.
      discardWorker: function() {
        var had = !!worker;
        if (worker) { worker.terminate(); worker = null; }
        settle();
        return had;
      },

      // One REPL statement. Same channel and same correlation as run(), so
      // stop() and the id matching apply unchanged; only the mode differs.
      pushRepl: function(source) {
        var w = ensureWorker();
        var id = 'repl-' + (++seq);
        return new Promise(function(resolve) {
          current = { id: id, resolve: resolve };
          whenReady().then(function() {
            if (worker === w && current && current.id === id) {
              w.postMessage({ type: 'run', id: id, mode: 'repl', source: source });
            }
          });
        });
      },

      // Post-run namespace snapshot for the Variables panel. VARS_HELPER already
      // produces JSON and the page already parses it, so this is a transport
      // change with no logic change — nothing live crosses the channel.
      snapshot: function() {
        // A stop terminates the worker and discards the namespace, so there is
        // nothing to snapshot and nothing will ever reply. Resolve empty rather
        // than leaving the caller waiting.
        if (!worker) return Promise.resolve([]);
        var w = worker;
        var id = 'snap-' + (++seq);
        return new Promise(function(resolve) {
          pending[id] = resolve;
          w.postMessage({ type: 'snapshot', id: id });
        });
      },

      // Toolbar clicks and mouse events, back to the figure's manager.
      sendMplEvent: function(figureId, content) {
        if (worker) {
          worker.postMessage({ type: 'mpl-event', figureId: figureId, content: content });
        }
      },

      // Browser events — or the bare pacing trigger `[{"trigger":1}]` — to the
      // vpython transport in the worker (spec 2026-08-10).
      // `events` is a JSON array string in glowcomm's wire format.
      sendSceneEvent: function(events) {
        if (worker) {
          worker.postMessage({ type: 'scene-event', events: String(events) });
        }
      },

      // Resolves when the worker's Pyodide has booted, with the ready message.
      // Lets the page show a banner without booting a SECOND interpreter on the
      // main thread just to read sys.version.
      ready: function() { return whenReady().then(function() { return readyInfo || {}; }); },

      isRunning: function() { return !!current; },

      dispose: function() {
        if (worker) { worker.terminate(); worker = null; }
        current = null;
      }
    };
  }

  var api = { createWorkerClient: createWorkerClient, PROTOCOL_VERSION: PROTOCOL_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('embed.workerClient', api);
})(typeof window !== 'undefined' ? window : this);
