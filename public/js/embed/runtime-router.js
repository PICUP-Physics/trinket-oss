(function(root) {
  'use strict';

  // #108: which runtime should THIS program use?
  //
  // Kept pure — no DOM, no Pyodide, no config lookups — so every rule can be
  // tested in node. pyodide.js is already large; putting the rules there would
  // make them reachable only through a browser.

  // Calls the async transform rewrites to `await`. Inside a lambda or a
  // comprehension it CANNOT (neither can be async), and _async_transform.py
  // documents that as a known limitation. Such a program must stay on the main
  // thread, where these calls are synchronous and still work.
  var AWAITABLE = ['input', 'sleep', 'rate'];

  // Strip comments and string literals before scanning, so `print("[input() ...]")`
  // is not mistaken for a real comprehension.
  function stripLiterals(src) {
    return String(src || '')
      .replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/#[^\n]*/g, '');
  }

  // True when an awaitable call appears inside a lambda body or a comprehension.
  function hasUnawaitableCall(src) {
    var code = stripLiterals(src);
    var names = AWAITABLE.join('|');

    // lambda ... : ... input() ...   (up to the end of the line)
    if (new RegExp('\\blambda\\b[^\\n:]*:[^\\n]*\\b(?:' + names + ')\\s*\\(').test(code)) {
      return true;
    }

    // [ ... input() ... for ... ] — a bracketed span containing BOTH a `for` and
    // an awaitable call is a comprehension using one.
    //
    // This needs a depth-tracking scan, not a regex: `[input() for _ in xs]`
    // contains `()` inside the `[]`, so a pattern that forbids nested brackets
    // never matches the span that matters — and a call is nested by definition,
    // which is the only case worth detecting.
    var callRe = new RegExp('\\b(?:' + names + ')\\s*\\(');
    var stack = [];
    for (var i = 0; i < code.length; i++) {
      var ch = code.charAt(i);
      if (ch === '[' || ch === '(' || ch === '{') {
        stack.push(i);
      } else if (ch === ']' || ch === ')' || ch === '}') {
        var start = stack.pop();
        if (start === undefined) continue;
        var inner = code.slice(start + 1, i);
        if (/\bfor\b/.test(inner) && callRe.test(inner)) return true;
      }
    }
    return false;
  }

  // #324: the inline console input (#86: `import console`, console.input())
  // exists only on the main thread; the worker has no `console` module, so a
  // program that imports it dies there with "No module named 'console'".
  function usesConsole(src) {
    return /^[ \t]*(?:import[ \t]+(?:[\w.]+(?:[ \t]+as[ \t]+\w+)?[ \t]*,[ \t]*)*console\b(?![\w.])|from[ \t]+console[ \t]+import\b)/m
      .test(stripLiterals(src));
  }

  // options: { usesVPython, usesConsole, workerEnabled, workerVPython, queryRuntime, storedRuntime }
  // usesConsole lets the page report an import in ANY file (a helper, say);
  // `source` is only the main file.
  function chooseRuntime(source, options) {
    var opts = options || {};
    var stored = (opts.storedRuntime === 'worker' || opts.storedRuntime === 'main')
      ? opts.storedRuntime : '';

    // Opt-in (spec 2026-08-10 V1/V2): vpython-jupyter in the worker. The FLAG is
    // the only gate — ?runtime=worker must not opt a class in by URL — but an
    // explicit 'main' still escapes (query param, or the per-trinket stored
    // runtime that arrived with #141 after the spec), so both are checked
    // inline here rather than by the rules below, which this rule sits above.
    //
    // The lambda/comprehension guard is checked inline for the same reason, and
    // it matters MORE here than on the python3 path. There, an un-awaited
    // `rate()` is a call that simply happens synchronously. In a vpython worker
    // run `rate`/`sleep` are coroutine FACTORIES: an un-awaited call constructs a
    // coroutine and drops it — no flush, no pacing, no yield to the event loop.
    // So the flag would turn a program that works on the main thread into one
    // that renders nothing and spins, which is precisely the shape this guard
    // was written to keep off the worker. Falling through lands on
    // `usesVPython → main`, the right destination.
    if (opts.usesVPython && opts.workerVPython && opts.queryRuntime !== 'main' &&
        stored !== 'main' && !hasUnawaitableCall(source)) {
      return { runtime: 'worker', vpython: true, reason: 'vpython: workerVPython flag routes to the worker runtime' };
    }

    // VPython first: its bridge does `from js import sphere, box, rate, …`,
    // binding synchronously to the window realm. No choice of any kind can
    // override that — off-thread it would simply fail to import.
    if (opts.usesVPython) {
      return { runtime: 'main', reason: 'vpython: bridge requires the window realm' };
    }

    // #324: console input likewise. The worker has no `console` module at all,
    // so neither the URL nor a stored setting may send such a program there.
    // (This sits below the workerVPython rule; a program using both VPython and
    // the console is not a combination #86 offers.)
    if (opts.usesConsole || usesConsole(source)) {
      return { runtime: 'main', reason: 'console: console.input needs the page' };
    }

    // The URL is a deliberate, temporary act by whoever is holding it, and it
    // is allowed to override the guard below: the guard over-matches on purpose
    // (see hasUnawaitableCall), so an author needs an escape from a false
    // positive. #128 D3.
    if (opts.queryRuntime === 'main')   return { runtime: 'main',   reason: 'query: runtime=main' };
    if (opts.queryRuntime === 'worker') return { runtime: 'worker', reason: 'query: runtime=worker' };

    // A STORED setting must not be able to select a runtime that cannot run the
    // program — it affects every student who opens the trinket, permanently.
    // So the guard sits above it, and below the URL. #128 D3.
    //
    // The guard only matters when the worker is actually a possibility: either
    // the deploy enables it, or this trinket asked for it. On a deploy with the
    // worker off and no stored preference, the honest reason is the flag, and
    // the notice must stay silent as it always has.
    // #128: when a stored value is set, IT alone decides whether the worker was
    // ever on the table — not the deploy flag. Before this, `stored === 'main'`
    // with the flag on still made workerPossible true (via the flag half of the
    // old `||`), so a guard-tripping program got the guard's reason ("await
    // cannot be inserted in a lambda or comprehension") even though the author
    // chose main and nothing was ever going to the worker. The runtime was
    // still correct (rule 4 below returns `stored` either way), but every
    // student was told about a worker limitation that never applied to them.
    var workerPossible = stored ? (stored === 'worker') : !!opts.workerEnabled;

    if (workerPossible && hasUnawaitableCall(source)) {
      return { runtime: 'main', reason: 'await cannot be inserted in a lambda or comprehension' };
    }

    if (stored) {
      return { runtime: stored, reason: 'trinket setting: runtime=' + stored };
    }

    if (!opts.workerEnabled) {
      return { runtime: 'main', reason: 'config: worker runtime disabled' };
    }

    return { runtime: 'worker', reason: 'default' };
  }

  // Why a program ended up where it did, in words a student can act on. Only
  // the reasons worth explaining appear here; the rest carry no parenthetical.
  var NOTES = {
    'vpython: bridge requires the window realm'             : 'Web VPython draws on the page',
    'config: worker runtime disabled'                       : 'the stoppable runtime is off for this site',
    'await cannot be inserted in a lambda or comprehension' : 'input(), sleep() or rate() inside a lambda or comprehension',
    'console: console.input needs the page'                 : 'console.input() reads from the page',
    'trinket setting: runtime=worker'                       : "this trinket's setting",
    'trinket setting: runtime=main'                         : "this trinket's setting"
  };

  // The console line announcing the runtime. Both paths print an identical
  // "Loading Python (Pyodide)…", so a program that ASKED for the worker and was
  // routed to the main thread anyway — VPython, or a call the async transform
  // cannot rewrite — looked exactly like one that got what it asked for. That
  // ambiguity cost a real debugging session.
  //
  // Deliberately quiet: it says nothing for the ordinary main-thread run that
  // every deploy with the flag off does today. It speaks only when the answer
  // is not the obvious one.
  function runtimeNotice(decision, queryRuntime) {
    if (!decision) return '';
    var asked   = (queryRuntime === 'worker' || queryRuntime === 'main');
    var ignored = asked && queryRuntime !== decision.runtime;

    var worthSaying = decision.runtime === 'worker'
                   || ignored
                   || decision.reason === 'await cannot be inserted in a lambda or comprehension'
                   || decision.reason === 'console: console.input needs the page'
                   || decision.reason.indexOf('trinket setting:') === 0;
    if (!worthSaying) return '';

    var line = decision.runtime === 'worker'
      ? 'Running off the main thread — Stop always works.'
      : 'Running on the main thread.';

    var why = NOTES[decision.reason];
    if (why) line = line.replace(/\.$/, '') + ' (' + why + ').';

    // The case that prompted this: the URL asked and did not get it.
    if (ignored) line += '\n?runtime=' + queryRuntime + ' could not be honoured here.';

    return line + '\n';
  }

  var router = {
    chooseRuntime      : chooseRuntime,
    hasUnawaitableCall : hasUnawaitableCall,
    usesConsole        : usesConsole,
    runtimeNotice      : runtimeNotice
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = router;
  if (root && root.TrinketIO && root.TrinketIO.export) root.TrinketIO.export('embed.runtimeRouter', router);
})(typeof window !== 'undefined' ? window : this);
