// Runner-side half of the GlowScript Stop button.
//
// install() runs INSIDE a program's sandboxed runner page: glowscript.js
// injects source() into the runner template, ahead of the program. So install
// must stay self-contained -- it may use nothing but its parameter and the
// runner's own globals.
//
// While no stop is requested every wrapped wait is a pass-through. After a stop
// request a wait in progress never hands control back to the program and a new
// wait never starts, so the program parks where it is and the scene stays live
// (camera rotation and zoom belong to the runtime, not the program). The runner
// confirms with glowscript.stopped once the program is parked. The one
// exception: while the runner template takes a snapshot of a stopped program,
// waits that start during the snapshot pass through, so the screenshot can
// finish (allowWaits below).
//
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md
// UMD-lite: window global for the embed page, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketGlowscriptStopShim = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function install(win) {
    // Repeated on purpose: source() stringifies install on its own, which
    // leaves the factory's directive behind, so in the runner page this is
    // the only 'use strict' install gets.
    'use strict';
    if (win.__trinketStop) { return win.__trinketStop; }

    // How long an allowWaits() window can stay open if nothing releases it.
    var ALLOW_WAITS_MS = 5000;

    // The stop state, published as win.__trinketStop:
    //   requested  - the page asked for a stop; from then on the waits park.
    //   pending    - wrapped waits in flight. A stop that arrives while one is
    //                in flight finds the program parked in it, so it confirms
    //                at once.
    //   confirmed  - glowscript.stopped has been posted. It is posted once.
    //   exempt     - how many allowWaits() windows are open. A window opens
    //                only after a confirmed stop; while one is open, new
    //                waits pass through.
    //   allowWaits - opens such a window (below).
    var stop = { requested: false, pending: 0, confirmed: false, exempt: 0 };
    win.__trinketStop = stop;

    function post(message) {
      // Deliberately empty catch: a runner that cannot reach the page has no
      // one to report to, and the page's teardown fallback covers a lost
      // ready or stopped message.
      try { win.parent.postMessage(JSON.stringify(message), '*'); } catch (e) {}
    }

    // Not named confirm: that would shadow the runner page's window.confirm.
    function confirmStopped() {
      if (stop.confirmed) { return; }
      stop.confirmed = true;
      post({ 'glowscript.stopped': true });
    }

    function parkForever() {
      return new Promise(function () {});
    }

    // A counted wait has settled. True: the program goes on. False: a stop
    // arrived meanwhile, so the program stays parked and the stop is confirmed.
    function settled() {
      stop.pending -= 1;
      if (stop.requested) { confirmStopped(); return false; }
      return true;
    }

    // A stopped program is still asked for snapshots (the thumbnail saved with
    // the trinket), and the runtime's screenshot goes through the same waits
    // that keep the program parked. The runner template asks for this window
    // around a screenshot: a wait that starts while it is open passes through,
    // while the program's own waits, which started before it, stay parked.
    // That is any wait, not only the screenshot's, so an event handler's flow
    // can advance while the window is open. release() closes it once, and so
    // does a timer, in case the screenshot never finishes.
    //
    // Granted only once the stop is confirmed. Before that the program may
    // still be on its way to its next wait; a window opened then would still
    // be open after the confirmation and would let that wait through. So the
    // answer is a release() that does nothing: no window, no timer.
    // A Save while a stop is unconfirmed gets no window, so that save keeps no
    // new thumbnail (spec, Known limits).
    stop.allowWaits = function () {
      if (!stop.confirmed) { return function () {}; }
      var released = false;
      function release() {
        if (released) { return; }
        released = true;
        stop.exempt -= 1;
      }
      // Scheduled before the window opens: if scheduling failed, none is left open.
      win.setTimeout(release, ALLOW_WAITS_MS);
      stop.exempt += 1;
      return release;
    };

    function wrap(owner, name) {
      var original = owner && owner[name];
      if (typeof original !== 'function' || original.__trinketStoppable) { return; }

      var wrapped = function () {
        // Decided once, when the call is made. A window only opens after a
        // confirmed stop; checking confirmed here as well is a second guard.
        // An exempt wait goes straight to the runtime, and so do its result
        // and continuation. It is not counted in pending, which only decides
        // whether a stop request confirms at once: exempt waits happen after
        // the stop is confirmed, when nothing reads it.
        var exempt = stop.exempt > 0 && stop.confirmed;
        if (exempt) { return original.apply(this, arguments); }

        if (stop.requested) {
          confirmStopped();
          return parkForever();
        }

        var args = Array.prototype.slice.call(arguments);
        var last = args.length - 1;

        // GlowScript 1.1 to 2.7 pass the program's continuation last.
        if (last >= 0 && typeof args[last] === 'function') {
          var resume = args[last];
          var called = false;
          stop.pending += 1;
          args[last] = function () {
            // A wait settles once. Counting a repeated call again would take
            // pending below the waits really in flight, and would resume the
            // program a second time.
            if (called) { return undefined; }
            called = true;
            return settled() ? resume.apply(this, arguments) : undefined;
          };
          return original.apply(this, args);
        }

        // GlowScript 2.9 and later: the program awaits the result.
        var result = original.apply(this, args);
        if (!result || typeof result.then !== 'function') { return result; }
        stop.pending += 1;
        return new Promise(function (resolve, reject) {
          result.then(function (value) {
            if (settled()) { resolve(value); }
          }, function (error) {
            if (settled()) { reject(error); }
          });
        });
      };

      wrapped.__trinketStoppable = true;
      owner[name] = wrapped;
    }

    ['rate', 'sleep', 'waitfor', 'pause'].forEach(function (name) { wrap(win, name); });
    if (typeof win.canvas === 'function' && win.canvas.prototype) {
      wrap(win.canvas.prototype, 'waitfor');
      wrap(win.canvas.prototype, 'pause');
    }

    win.addEventListener('message', function (event) {
      // Only the page that embeds the runner may stop it, and in both sandbox
      // modes that page is the runner's parent. Another window that can reach
      // the runner, a sibling frame or a popup, is ignored.
      if (event.source !== win.parent) { return; }
      if (event.data !== 'glowscript.stop' || stop.requested) { return; }
      stop.requested = true;
      if (stop.pending > 0) { confirmStopped(); }
    });

    post({ 'glowscript.ready': true });
    return stop;
  }

  // The statement glowscript.js puts into the runner template.
  function source() {
    return '(' + install.toString() + ')(window);';
  }

  return { install: install, source: source };
}));
