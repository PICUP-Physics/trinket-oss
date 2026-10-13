// Page-side decisions for the GlowScript Stop button: idle, running, stopping.
//
// Pure -- no DOM and no clock of its own. glowscript.js passes in the effects
// (onState draws the button, requestStop messages the runner, teardown removes
// the runner) and, for tests, the timer and clock functions.
//
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md
// UMD-lite: window global for the embed page, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketGlowscriptRunState = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // How long a parked-program confirmation may take before the runner is torn down.
  var STOP_TIMEOUT_MS = 2000;
  // A Stop this soon after a Run is the second click of a double-click on Run.
  var STOP_GRACE_MS = 500;

  function noop() {}

  function create(opts) {
    opts = opts || {};
    var onState       = opts.onState     || noop;
    var requestStop   = opts.requestStop || noop;
    var teardown      = opts.teardown    || noop;
    var setTimer      = opts.setTimer    || function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimer    = opts.clearTimer  || function (id) { clearTimeout(id); };
    var now           = opts.now         || function () { return Date.now(); };
    var stopTimeoutMs = opts.stopTimeoutMs || STOP_TIMEOUT_MS;
    var stopGraceMs   = (typeof opts.stopGraceMs === 'number') ? opts.stopGraceMs : STOP_GRACE_MS;

    var state = 'idle';
    var ready = false;
    var generation = 0;
    var launchedAt = -Infinity;
    var timer = null;

    function enter(next) {
      if (next === state) { return; }
      state = next;
      onState(state);
    }

    function cancelTimer() {
      if (timer !== null) { clearTimer(timer); timer = null; }
    }

    function tearDown() {
      cancelTimer();
      generation += 1;
      ready = false;
      try { teardown(); } finally { enter('idle'); }
    }

    var api = {
      // A new run began; its runner has not reported in yet.
      launched: function () {
        cancelTimer();
        generation += 1;
        ready = false;
        launchedAt = now();
        enter('running');
      },
      ready: function () {
        if (state === 'running') { ready = true; }
      },
      // The program finished on its own, or failed.
      finished: function () {
        if (state === 'idle') { return; }
        cancelTimer();
        enter('idle');
      },
      // The runtime could not be loaded and the retry budget is spent.
      loadFailed: function () {
        if (state === 'idle') { return; }
        cancelTimer();
        enter('idle');
      },
      stop: function () {
        if (state !== 'running') { return; }
        if (now() - launchedAt < stopGraceMs) { return; }
        if (!ready) { tearDown(); return; }
        // Arm the fallback first, so a failing effect below cannot strand the
        // control in Stopping… with nothing left to end it.
        timer = setTimer(function () {
          timer = null;
          if (state === 'stopping') { tearDown(); }
        }, stopTimeoutMs);
        enter('stopping');
        requestStop();
      },
      // The runner parked the program; its scene stays, frozen.
      stopped: function () {
        if (state !== 'stopping') { return; }
        cancelTimer();
        enter('idle');
      },
      // Route a parsed runner message. Only the current run's runner counts.
      receive: function (data, fromCurrentRunner) {
        // A program can post any JSON, a bare string or number included; only
        // an object can be a runner message (and `in` throws on a primitive).
        if (!data || typeof data !== 'object' || !fromCurrentRunner) { return; }
        if (data['glowscript.ready']) { api.ready(); }
        // An error raised outside the main flow (an event handler, a timer)
        // leaves the program running, so the run goes on.
        else if (data['glowscript.background']) { return; }
        // Any other runner error ends the run, including one whose message is
        // empty or missing: every runner error carries a type of runtime or compile.
        else if (data['glowscript.done'] || 'glowscript.error' in data ||
                 data.type === 'runtime' || data.type === 'compile') { api.finished(); }
        else if (data['glowscript.stopped']) { api.stopped(); }
      },
      state: function () { return state; },
      generation: function () { return generation; }
    };

    return api;
  }

  return { create: create, STOP_TIMEOUT_MS: STOP_TIMEOUT_MS, STOP_GRACE_MS: STOP_GRACE_MS };
}));
