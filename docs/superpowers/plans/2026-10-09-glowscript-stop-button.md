# GlowScript Stop Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In Web VPython (GlowScript) trinkets, Run turns into an animated Stop while a program runs, Stop freezes the program in place, and the control returns to Run when the program finishes or is stopped.

**Architecture:** A self-contained shim, injected into the runner page that `glowscript.js` already builds for every Run, wraps GlowScript's wait functions so a stop request parks the program. It reports ready, done and stopped to the page by `postMessage`. On the page, a pure controller decides the state (idle, running or stopping) with a 2 s teardown fallback. A small view morphs the existing `.run-it` control, and `glowscript.js` wires the three together.

**Tech Stack:** Browser ES5 JavaScript using the UMD-lite module pattern of `public/js/embed/runner-retry.js`, jQuery 2 and Foundation 5 on the page, SCSS built by Vite, Vitest with jsdom for unit tests, and Playwright for the browser spec.

**Spec:** `docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md`

## Superseded during execution

The plan below is kept as written. Where the committed code differs from a code block, the code and the spec are authoritative. Each block listed was superseded by a ruling made during execution (recorded in the SDD ledger, which git ignores); the final review's fix wave counts as one ruling.

- **Task 2, Steps 1 and 3** (shim tests, `glowscript-stop-shim.js`): e7deb86, 2a47f2f, 8fb69ec and 73c7679, all from the fix wave. Bookkeeping tests from the Task 2 review; one `settled()` helper, `confirmStopped()` and a documented stop state; the snapshot exemption (`allowWaits()`, `exempt`), granted only after a confirmed stop.
- **Task 3, Steps 1 and 3** (controller tests, `glowscript-run-state.js`): 4ce03f6, then d3ea392, 27bdb73 and 126609a from the fix wave. The stop timer is armed before any effect runs and teardown ends in try/finally; an error with an empty or missing message still ends the run. Fix wave: a background error leaves the run going, a non-object message is ignored, and the stop paths are pinned more tightly.
- **Task 4, Steps 2, 4 and 6** (view tests, `run-stop-button.js`, `_run_stop.scss`): a18b02f, then 27bdb73 from the fix wave. Foundation builds its tooltips once at init, so the view rewrites the tooltip's text in place instead of removing it; the width is locked to the widest label (itself superseded by `docs/superpowers/plans/2026-10-11-run-stop-fixed-width.md`: the control keeps Run's width, and the stopping label is `Stop`); while running, `:focus` is transparent, the strip joins every color list, and `:hover` is split from `:focus-visible`. Fix wave: the focus ring moves to `outline-offset: -6px`.
- **Task 5, Step 1** (template tests): 3e70567, then 9c98f12, 8fb69ec and d3ea392 from the fix wave. Tests for the template's fail-open guard; fix wave: runner-page errors forwarded to the test output, snapshot-after-Stop and background-error tests.
- **Task 5, Step 3** (`{{stopShim}}`): 43dc65d and 3e70567. The shim is wrapped in try/catch, so a failing shim never keeps the program from running, and the catch warns.
- **Task 5, Step 4** (`runProgram`): d3ea392, fix wave. The main-flow flag that background errors depend on.
- **Task 5, Steps 8, 11.2 and 14** (page-side helpers, launch, message routing): 1f0b6ee and 3e70567. `ignoredRunner` also covers the outgoing runner from launch; load-failure reports count only from the current runner; a torn-down run clears `lastRunnerHtml`, so it is never rebuilt.
- **Task 5, Step 12** (`initialize`): 27bdb73, fix wave. `onState` catches a throwing view, so drawing the control can never block Run or Stop.
- **Task 5, Step 16.2** (What's New): removed during PR review (#336, 2026-10-12). What's New is being reworked under #332, so this PR leaves it alone; the CHANGELOG entry stays.
- **Task 6, Step 1** (browser spec): 8a6e67b, 84b09fb, then fb71697 from the fix wave. A fifth, keyboard test; tests 3 to 5 made to fail when their behaviour is gone; fix wave: snapshot after Stop, an error in an event handler, and a 5 s timeout in `printed()`, which the polls read as no output yet rather than as a failure.

Added with no plan block: the Enter keypress guard in `glowscript.js` (3e70567), and the `.fail` handler on the external-sandbox POST (1f0b6ee).

Review Focus item 2 ("Enter toggles") is not attainable end to end: `runCode()` moves focus to `#honeypot`, and the runner iframe's load handler then moves it into the runner. Both behaviours predate this branch. The view does keep focus on the same control, which is what its unit test pins.

## Global Constraints

- Scope is GlowScript Web VPython trinkets only. Do not change the Pyodide runner (`public/js/embed/pyodide.js`), its `.stop-it` control, or the markup of `lib/views/embed/default-toolbar.html`.
- Running colors: `#C62828` for Stop and `#6B6B6B` for Stopping….
- The strip is an `aria-hidden` SVG inset 3px from each edge. Its `rect` has `width="100%" height="100%" rx="3" pathLength="100"`, a 2px stroke in `currentColor`, and `stroke-dasharray: 24 76`, and it animates `stroke-dashoffset` from 0 to -100 over 1.6 s, linear, infinite.
- `prefers-reduced-motion: reduce` replaces the moving strip with a static 1.5px outline.
- The stop confirmation window is 2000 ms. A Stop within 500 ms of a launch is ignored as the second click of a double-click on Run.
- Running shows label `Stop`, aria-label `Stop program`, title `Stop the program.`, icon `fa fa-stop`, and action `code.stop`. Stopping shows label `Stopping…`, aria-label `Stopping program`, title `Stopping the program.`, action `code.stop`, and `aria-disabled="true"`.
- Runner to page messages are `{"glowscript.ready": true}`, `{"glowscript.done": true}` and `{"glowscript.stopped": true}`. The page sends the runner the plain string `"glowscript.stop"`.
- The teardown note reads `Program stopped. Press Run to start it again.`
- New JS files use the UMD-lite pattern of `public/js/embed/runner-retry.js`: a window global for the page and `module.exports` for the tests.
- No new dependencies. `jsdom` is already declared and is restored with `npm install`; `package.json` and `package-lock.json` must not change.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A double-click on Run must leave the new program running. Pinned by the controller test "the second click of a double-click on Run does not stop the new program" (Task 3).
2. Keyboard focus must stay on the same control through Run, Stop and back to Run, so Enter toggles it. Pinned by the view test "keeps keyboard focus on the same control" (Task 4).
3. A late message from an earlier run's runner must not move the button. Pinned by the controller test "ignores messages from any other runner" (Task 3). The runner identity check is wired in Task 5.
4. Stop followed by Run before the confirmation arrives: the old run's timeout must not tear down the new run. Pinned by "Run pressed while stopping starts the new run and cancels the old teardown" (Task 3).
5. Old GlowScript versions (1.1 to 2.7, callback style) must stop and report done too. Pinned by the shim's callback-style tests (Task 2) and the runner-template tests on version 2.7.5 (Task 5).

## File Structure

| File | Responsibility |
|---|---|
| `public/js/embed/glowscript-stop-shim.js` (create) | Runner-side shim: `install(win)` wraps the wait functions and answers `glowscript.stop`; `source()` returns injectable text |
| `public/js/embed/glowscript-run-state.js` (create) | Pure page-side controller: states, 2 s window, 500 ms guard, generation, message routing |
| `public/js/embed/run-stop-button.js` (create) | Morphs every `.run-it` between Run, Stop and Stopping…, and restores each control's own originals |
| `static/scss/embed/_run_stop.scss` (create), `static/scss/embed/embed.scss` (modify) | State colors, strip, reduced motion, teardown note |
| `lib/views/embed/glowscript.html` (modify) | Runner template: `{{stopShim}}` and the done messages; script list gains the three files |
| `public/js/embed/glowscript.js` (modify) | Wiring: create controller and view, launch, message routing, Stop event, teardown, generation guards |
| `test/unit/glowscript-stop-shim.test.js`, `glowscript-run-state.test.js`, `run-stop-button.test.js`, `glowscript-runner-template.test.js` (create) | Unit tests |
| `test/browser/specs/glowscript-stop.spec.js` (create) | Playwright spec against the local stack |
| `CHANGELOG.md`, `lib/views/static/whats-new.html` (modify) | User-facing notes |

Throwaway work stays outside the repository: `<scratchpad>/glowscript-spike/`, plus `.claude/launch.json`, which git ignores. Here `<scratchpad>` means `/private/tmp/claude-1067127468/-Users-zimmermant-Dropbox-claude-sandbox-workspace-Software-Development-trinket-oss-picup-fork/1bca0e29-5060-4169-a42b-f28c65290714/scratchpad`.

---

### Task 1: Spike, to verify the pause shim against the real 3.2.3 runtime (throwaway)

**Files:**
- Create: `<scratchpad>/glowscript-spike/index.html` (outside the repo)
- Create or modify: `.claude/launch.json` (git ignores it)
- Create: `.claude/epics/glowscript-stop-button/updates/spike.md` (local evidence)

**Interfaces:**
- Consumes: nothing.
- Produces: a go or no-go decision recorded in `spike.md`, plus the element GlowScript's `print()` writes into (expected `textarea#print`), which Task 6 uses.

- [ ] **Step 1: Write the harness page.** It mirrors the runner template's script order. The shim below is the prototype that Task 2 formalises.

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>GlowScript stop spike (throwaway)</title>
<script>
  window.__msgs = [];
  window.addEventListener('message', function (e) { window.__msgs.push(e.data); });
  window.reportScriptError = function () { return ''; };
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/2.1.4/jquery.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.11.4/jquery-ui.min.js"></script>
<script src="https://storage.googleapis.com/rswvprunner/package/glow.3.2.min.js?build=2026-06-16b"></script>
<script src="https://storage.googleapis.com/rswvprunner/package/RSrun.3.2.min.js?build=2026-06-16b"></script>
<script src="https://storage.googleapis.com/rswvprunner/package/RScompiler.3.2.min.js?build=2026-06-16b"></script>
</head>
<body>
<div id="glowscript"></div>
<script>
(function install(win) {
  'use strict';
  if (win.__trinketStop) { return win.__trinketStop; }
  var stop = { requested: false, pending: 0, confirmed: false };
  win.__trinketStop = stop;
  function post(message) { try { win.parent.postMessage(JSON.stringify(message), '*'); } catch (e) {} }
  function confirm() { if (stop.confirmed) { return; } stop.confirmed = true; post({ 'glowscript.stopped': true }); }
  function parkForever() { return new Promise(function () {}); }
  function wrap(owner, name) {
    var original = owner && owner[name];
    if (typeof original !== 'function' || original.__trinketStoppable) { return; }
    var wrapped = function () {
      if (stop.requested) { confirm(); return parkForever(); }
      var args = Array.prototype.slice.call(arguments);
      var last = args.length - 1;
      if (last >= 0 && typeof args[last] === 'function') {
        var resume = args[last];
        stop.pending += 1;
        args[last] = function () {
          stop.pending -= 1;
          if (stop.requested) { confirm(); return undefined; }
          return resume.apply(this, arguments);
        };
        return original.apply(this, args);
      }
      var result = original.apply(this, args);
      if (!result || typeof result.then !== 'function') { return result; }
      stop.pending += 1;
      return new Promise(function (resolve, reject) {
        result.then(function (value) { stop.pending -= 1; if (stop.requested) { confirm(); return; } resolve(value); },
                    function (error) { stop.pending -= 1; if (stop.requested) { confirm(); return; } reject(error); });
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
    if (event.data !== 'glowscript.stop' || stop.requested) { return; }
    stop.requested = true;
    if (stop.pending > 0) { confirm(); }
  });
  post({ 'glowscript.ready': true });
  return stop;
})(window);

var PROGRAMS = {
  loop:    'Web VPython 3.2\nb = box()\nn = 0\nwhile True:\n    rate(30)\n    n = n + 1\n    b.rotate(angle=0.05, axis=vec(0, 1, 0))\n    print(n)\n',
  sleep:   'Web VPython 3.2\nn = 0\nwhile True:\n    sleep(0.1)\n    n = n + 1\n    print(n)\n',
  finite:  'Web VPython 3.2\nsphere()\nfor i in range(3):\n    rate(10)\n',
  waitfor: 'Web VPython 3.2\nbox()\nscene.waitfor("click")\nprint("clicked")\n'
};
var which = (location.search.match(/case=(\w+)/) || [])[1] || 'loop';
window.__probe = {
  rateIsFunction: typeof window.rate === 'function',
  rateWrapped: !!(window.rate && window.rate.__trinketStoppable),
  rateDescriptor: JSON.stringify(Object.getOwnPropertyDescriptor(window, 'rate') || null, ['writable', 'configurable', 'enumerable']),
  sleepWrapped: !!(window.sleep && window.sleep.__trinketStoppable),
  canvasIsFunction: typeof window.canvas === 'function',
  canvasWaitforWrapped: !!(window.canvas && window.canvas.prototype && window.canvas.prototype.waitfor && window.canvas.prototype.waitfor.__trinketStoppable)
};
var compiled = window.glowscript_compile(PROGRAMS[which], { lang: 'vpython', version: '3.2.3' });
window.__compiled = compiled;
window.__context = { glowscript_container: $('#glowscript') };
(async function () {
  try {
    eval(compiled);
    await __main__();
    window.parent.postMessage(JSON.stringify({ 'glowscript.done': true }), '*');
  } catch (err) {
    window.parent.postMessage(JSON.stringify({ 'glowscript.error': String((err && err.message) || err) }), '*');
  }
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Serve it.** Add this configuration to `.claude/launch.json`, creating the file if needed and keeping any existing entries.

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "glowscript-spike",
      "runtimeExecutable": "python3",
      "runtimeArgs": ["-m", "http.server", "8765", "--directory", "<scratchpad>/glowscript-spike"],
      "port": 8765
    }
  ]
}
```

Start it with the Browser pane's `preview_start` (name `glowscript-spike`) and navigate to `http://localhost:8765/?case=loop`.

- [ ] **Step 3: Probe interception.** After about 5 s, evaluate this in the page:

```js
({ probe: window.__probe, msgs: window.__msgs,
   compiledAwaitsRate: /await\s+(\w+\.)?rate\s*\(/.test(window.__compiled),
   printTag: (document.querySelector('#print') || {}).tagName,
   printed: ((document.querySelector('#print') || {}).value || '').split('\n').filter(Boolean).length })
```

Expected:
- `probe.rateIsFunction` and `probe.rateWrapped` are `true`;
- `msgs` contains `{"glowscript.ready":true}`;
- `printTag` is `TEXTAREA` and `printed` keeps growing between two evaluations.

Also record `compiledAwaitsRate`. If it shows the program calls something other than the global `rate`, interception has failed. Go to Step 7 with a no-go.

- [ ] **Step 4: Stop it.** Evaluate `window.postMessage('glowscript.stop', '*')`. After 1 s, record `printed`; after another 2 s, record it again. Expected: both values are equal, and `msgs` contains `{"glowscript.stopped":true}`.

- [ ] **Step 5: Check that the parked scene still renders.** Take a screenshot. Scroll the mouse wheel 3 ticks over the canvas, which is GlowScript's zoom, and take another. Expected: the box is visibly larger or smaller in the second screenshot.

- [ ] **Step 6: Check the other cases.**
  - `?case=sleep`: repeat Steps 3 and 4; expect `sleepWrapped` true and printing to stop.
  - `?case=finite`: expect `{"glowscript.done":true}` in `msgs` within 5 s.
  - `?case=waitfor`: expect `canvasIsFunction` true. Record `canvasWaitforWrapped`. Then post the stop message, click the canvas, and expect `stopped` in `msgs` and no `clicked` in `#print`.

- [ ] **Step 7: Record the decision.** Write `.claude/epics/glowscript-stop-button/updates/spike.md` with the date, every probe value, the screenshots' outcome, the `print()` element, and a verdict.
  - **Go:** Steps 3, 4, 5 and the `finite` case pass. Continue with Task 2. Fold any findings about `waitfor` and `pause` into Task 2's wrap list. If `canvas.prototype.waitfor` is not where waits live, record where they do.
  - **No-go:** `rate` cannot be intercepted, or a parked scene stops rendering. Stop all work and report to the requester. Do not start Task 2.

---

### Task 2: Runner shim module

**Files:**
- Create: `public/js/embed/glowscript-stop-shim.js`
- Test: `test/unit/glowscript-stop-shim.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the global `trinketGlowscriptStopShim` (page) or `module.exports` (tests), with:
  - `install(win: Window): StopState`, which wraps the waits, listens for `"glowscript.stop"`, and posts ready. `StopState` is `{ requested: boolean, pending: number, confirmed: boolean }`, also stored on `win.__trinketStop`. Install is idempotent.
  - `source(): string`, which returns `'(' + install.toString() + ')(window);'` for the runner template.

- [ ] **Step 1: Write the failing test** at `test/unit/glowscript-stop-shim.test.js`:

```js
'use strict';

// Runner-side half of the GlowScript Stop button. The shim runs INSIDE the
// program's sandboxed runner page; these tests drive it with a fake window.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { install, source } = require('../../public/js/embed/glowscript-stop-shim');

function fakeWindow(extra) {
  const listeners = [];
  const posted = [];
  const win = Object.assign({
    parent: { postMessage: (message) => posted.push(JSON.parse(message)) },
    addEventListener: (type, fn) => { if (type === 'message') { listeners.push(fn); } },
  }, extra);
  win.posted = posted;
  win.send = (data) => listeners.forEach((fn) => fn({ data }));
  return win;
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const stoppedCount = (win) => win.posted.filter((m) => m['glowscript.stopped']).length;

describe('install', () => {
  it('announces itself to the page once', () => {
    const win = fakeWindow();
    install(win);
    expect(win.posted).toEqual([{ 'glowscript.ready': true }]);
  });

  it('is idempotent: a second install neither re-wraps nor re-announces', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    const wrapped = win.rate;
    install(win);
    expect(win.rate).toBe(wrapped);
    expect(win.posted).toHaveLength(1);
  });

  it('skips wait functions the runtime does not define', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    expect(win.sleep).toBeUndefined();
    expect(win.rate.__trinketStoppable).toBe(true);
  });
});

describe('promise-style waits (GlowScript 2.9 and later)', () => {
  it('pass values and errors through while no stop is requested', async () => {
    const win = fakeWindow({ rate: (n) => Promise.resolve(n * 2), sleep: () => Promise.reject(new Error('nope')) });
    install(win);
    await expect(win.rate(21)).resolves.toBe(42);
    await expect(win.sleep(1)).rejects.toThrow('nope');
  });

  it('a stop while a wait is pending confirms at once and never resumes the program', async () => {
    const pending = deferred();
    const win = fakeWindow({ rate: () => pending.promise });
    install(win);
    let resumed = false;
    win.rate(30).then(() => { resumed = true; });

    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(1);

    pending.resolve();
    await tick();
    expect(resumed).toBe(false);
  });

  it('a stop while the program computes confirms at its next wait, which never returns', async () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    install(win);
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(0);

    let resumed = false;
    win.rate(30).then(() => { resumed = true; });
    await tick();
    expect(stoppedCount(win)).toBe(1);
    expect(resumed).toBe(false);
  });

  it('a rejection after a stop does not reach the program either', async () => {
    const pending = deferred();
    const win = fakeWindow({ sleep: () => pending.promise });
    install(win);
    let settled = false;
    win.sleep(1).then(() => { settled = true; }, () => { settled = true; });
    win.send('glowscript.stop');
    pending.reject(new Error('late'));
    await tick();
    expect(settled).toBe(false);
  });

  it('confirms only once however many waits are parked', async () => {
    const win = fakeWindow({ rate: () => deferred().promise, sleep: () => deferred().promise });
    install(win);
    win.rate(30);
    win.sleep(1);
    win.send('glowscript.stop');
    win.send('glowscript.stop');
    win.rate(30);
    await tick();
    expect(stoppedCount(win)).toBe(1);
  });

  it('wraps canvas waits and keeps their receiver', async () => {
    function canvas() {}
    let receiver = null;
    canvas.prototype.waitfor = function () { receiver = this; return Promise.resolve('click'); };
    const win = fakeWindow({ canvas });
    install(win);
    const scene = new canvas();
    await expect(scene.waitfor('click')).resolves.toBe('click');
    expect(receiver).toBe(scene);
    expect(canvas.prototype.waitfor.__trinketStoppable).toBe(true);
  });
});

describe('callback-style waits (GlowScript 1.1 to 2.7)', () => {
  it('resume the program normally while no stop is requested', () => {
    let pendingCallback = null;
    const win = fakeWindow({ rate: (n, cb) => { pendingCallback = cb; } });
    install(win);
    let resumed = false;
    win.rate(30, () => { resumed = true; });
    pendingCallback();
    expect(resumed).toBe(true);
  });

  it('a stop while parked confirms at once and swallows the continuation', () => {
    let pendingCallback = null;
    const win = fakeWindow({ rate: (n, cb) => { pendingCallback = cb; } });
    install(win);
    let resumed = false;
    win.rate(30, () => { resumed = true; });
    win.send('glowscript.stop');
    expect(stoppedCount(win)).toBe(1);
    pendingCallback();
    expect(resumed).toBe(false);
  });
});

describe('messages', () => {
  it('ignores anything but the stop request', () => {
    const win = fakeWindow({ rate: () => deferred().promise });
    install(win);
    win.rate(30);
    win.send('glowscript.snapshot');
    win.send(JSON.stringify({ 'glowscript.stop': true }));
    expect(stoppedCount(win)).toBe(0);
  });
});

describe('source', () => {
  it('is a self-contained statement that installs the shim on `window`', () => {
    const win = fakeWindow({ rate: () => Promise.resolve() });
    new Function('window', source())(win);
    expect(win.posted).toEqual([{ 'glowscript.ready': true }]);
    expect(win.rate.__trinketStoppable).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/unit/glowscript-stop-shim.test.js`
Expected: FAIL with `Cannot find module '../../public/js/embed/glowscript-stop-shim'`.

- [ ] **Step 3: Write the implementation** at `public/js/embed/glowscript-stop-shim.js`:

```js
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
// confirms with glowscript.stopped once the program is parked.
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
    'use strict';
    if (win.__trinketStop) { return win.__trinketStop; }

    var stop = { requested: false, pending: 0, confirmed: false };
    win.__trinketStop = stop;

    function post(message) {
      try { win.parent.postMessage(JSON.stringify(message), '*'); } catch (e) {}
    }

    function confirm() {
      if (stop.confirmed) { return; }
      stop.confirmed = true;
      post({ 'glowscript.stopped': true });
    }

    function parkForever() {
      return new Promise(function () {});
    }

    function wrap(owner, name) {
      var original = owner && owner[name];
      if (typeof original !== 'function' || original.__trinketStoppable) { return; }

      var wrapped = function () {
        if (stop.requested) {
          confirm();
          return parkForever();
        }

        var args = Array.prototype.slice.call(arguments);
        var last = args.length - 1;

        // GlowScript 1.1 to 2.7 pass the program's continuation last.
        if (last >= 0 && typeof args[last] === 'function') {
          var resume = args[last];
          stop.pending += 1;
          args[last] = function () {
            stop.pending -= 1;
            if (stop.requested) { confirm(); return undefined; }
            return resume.apply(this, arguments);
          };
          return original.apply(this, args);
        }

        // GlowScript 2.9 and later: the program awaits the result.
        var result = original.apply(this, args);
        if (!result || typeof result.then !== 'function') { return result; }
        stop.pending += 1;
        return new Promise(function (resolve, reject) {
          result.then(function (value) {
            stop.pending -= 1;
            if (stop.requested) { confirm(); return; }
            resolve(value);
          }, function (error) {
            stop.pending -= 1;
            if (stop.requested) { confirm(); return; }
            reject(error);
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
      if (event.data !== 'glowscript.stop' || stop.requested) { return; }
      stop.requested = true;
      if (stop.pending > 0) { confirm(); }
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
```

If the spike recorded that waits live somewhere other than these names, add exactly those owners and names to the wrap calls, with a test like "wraps canvas waits and keeps their receiver" for each.

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/unit/glowscript-stop-shim.test.js`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit.**

```bash
git add public/js/embed/glowscript-stop-shim.js test/unit/glowscript-stop-shim.test.js
git commit -m "feat(glowscript): runner shim that parks a program on Stop

Wraps GlowScript's wait functions (rate, sleep, waitfor, pause) so a stop
request parks the program where it is, for both the promise style (2.9+)
and the continuation style (1.1-2.7), and reports ready/stopped to the page.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Run-state controller

**Files:**
- Create: `public/js/embed/glowscript-run-state.js`
- Test: `test/unit/glowscript-run-state.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the global `trinketGlowscriptRunState`, with `create(opts)`, `STOP_TIMEOUT_MS = 2000` and `STOP_GRACE_MS = 500`.
  - `opts` is `{ onState(state), requestStop(), teardown(), setTimer(fn, ms) -> id, clearTimer(id), now() -> ms, stopTimeoutMs?, stopGraceMs? }`. All are optional; the defaults are no-ops, `setTimeout`, `clearTimeout` and `Date.now`.
  - `create` returns `{ launched(), ready(), finished(), loadFailed(), stop(), stopped(), receive(data, fromCurrentRunner), state() -> 'idle'|'running'|'stopping', generation() -> number }`.

- [ ] **Step 1: Write the failing test** at `test/unit/glowscript-run-state.test.js`:

```js
'use strict';

// Page-side decisions for the GlowScript Stop button: every row of the spec's
// transition table, driven with an injected clock and timer queue.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { create, STOP_TIMEOUT_MS, STOP_GRACE_MS } = require('../../public/js/embed/glowscript-run-state');

function harness() {
  const effects = { states: [], requestStop: 0, teardown: 0 };
  const timers = new Map();
  let nextTimer = 1;
  let clock = 0;
  const ctl = create({
    onState: (s) => effects.states.push(s),
    requestStop: () => { effects.requestStop += 1; },
    teardown: () => { effects.teardown += 1; },
    setTimer: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    now: () => clock,
  });
  return {
    ctl, effects, timers,
    advance: (ms) => { clock += ms; },
    fireTimers: () => { const due = [...timers.values()]; timers.clear(); due.forEach((t) => t.fn()); },
  };
}

// A run past the double-click guard whose runner has reported in.
function readyRun() {
  const h = harness();
  h.ctl.launched();
  h.ctl.ready();
  h.advance(STOP_GRACE_MS);
  return h;
}

describe('a run', () => {
  it('starts idle at generation 0', () => {
    const { ctl } = harness();
    expect(ctl.state()).toBe('idle');
    expect(ctl.generation()).toBe(0);
  });

  it('turns the button into Stop when launched, with a new generation', () => {
    const h = harness();
    h.ctl.launched();
    expect(h.ctl.state()).toBe('running');
    expect(h.effects.states).toEqual(['running']);
    expect(h.ctl.generation()).toBe(1);
  });

  it('a relaunch while running keeps Stop without redrawing it, and takes a new generation', () => {
    const h = harness();
    h.ctl.launched();
    h.ctl.launched();
    expect(h.effects.states).toEqual(['running']);
    expect(h.ctl.generation()).toBe(2);
  });

  it('returns to Run when the program finishes or fails', () => {
    const h = readyRun();
    h.ctl.finished();
    expect(h.ctl.state()).toBe('idle');
    expect(h.effects.states).toEqual(['running', 'idle']);
  });

  it('returns to Run when the runtime cannot be loaded', () => {
    const h = harness();
    h.ctl.launched();
    h.ctl.loadFailed();
    expect(h.ctl.state()).toBe('idle');
  });

  it('ignores end-of-run events while idle', () => {
    const h = harness();
    h.ctl.finished();
    h.ctl.stopped();
    h.ctl.loadFailed();
    h.ctl.ready();
    expect(h.effects.states).toEqual([]);
  });
});

describe('stop', () => {
  it('asks the runner to park and waits up to the stop window', () => {
    const h = readyRun();
    h.ctl.stop();
    expect(h.ctl.state()).toBe('stopping');
    expect(h.effects.requestStop).toBe(1);
    expect([...h.timers.values()].map((t) => t.ms)).toEqual([STOP_TIMEOUT_MS]);
  });

  it('a confirmation returns to Run and leaves the frozen runner in place', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.stopped();
    expect(h.ctl.state()).toBe('idle');
    expect(h.effects.teardown).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  it('no confirmation within the window tears the runner down', () => {
    const h = readyRun();
    const before = h.ctl.generation();
    h.ctl.stop();
    h.fireTimers();
    expect(h.effects.teardown).toBe(1);
    expect(h.ctl.state()).toBe('idle');
    expect(h.ctl.generation()).toBe(before + 1);
  });

  it('a program that finishes or fails while stopping just returns to Run', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.finished();
    expect(h.ctl.state()).toBe('idle');
    expect(h.effects.teardown).toBe(0);
    expect(h.timers.size).toBe(0);
  });

  it('a load failure while stopping returns to Run and cancels the window', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.loadFailed();
    expect(h.ctl.state()).toBe('idle');
    expect(h.timers.size).toBe(0);
  });

  it('before the runner is ready, tears down at once with a new generation', () => {
    const h = harness();
    h.ctl.launched();
    h.advance(STOP_GRACE_MS);
    h.ctl.stop();
    expect(h.effects.teardown).toBe(1);
    expect(h.effects.requestStop).toBe(0);
    expect(h.ctl.state()).toBe('idle');
    expect(h.ctl.generation()).toBe(2);
  });

  it('the second click of a double-click on Run does not stop the new program', () => {
    const h = harness();
    h.ctl.launched();
    h.ctl.ready();
    h.advance(STOP_GRACE_MS - 1);
    h.ctl.stop();
    expect(h.ctl.state()).toBe('running');
    expect(h.effects.requestStop).toBe(0);
    expect(h.effects.teardown).toBe(0);
  });

  it('is ignored while stopping and while idle', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.stop();
    expect(h.effects.requestStop).toBe(1);
    h.ctl.stopped();
    h.ctl.stop();
    expect(h.effects.requestStop).toBe(1);
    expect(h.ctl.state()).toBe('idle');
  });

  it('Run pressed while stopping starts the new run and cancels the old teardown', () => {
    const h = readyRun();
    h.ctl.stop();
    h.ctl.launched();
    expect(h.ctl.state()).toBe('running');
    expect(h.timers.size).toBe(0);
    h.fireTimers();
    expect(h.effects.teardown).toBe(0);
    // The new runner has not reported in, so a Stop past the guard tears down.
    h.advance(STOP_GRACE_MS);
    h.ctl.stop();
    expect(h.effects.teardown).toBe(1);
  });
});

describe('receive', () => {
  it("routes the current runner's messages", () => {
    const h = harness();
    h.ctl.launched();
    h.ctl.receive({ 'glowscript.ready': true }, true);
    h.advance(STOP_GRACE_MS);
    h.ctl.stop();
    expect(h.effects.requestStop).toBe(1);
    h.ctl.receive({ 'glowscript.stopped': true }, true);
    expect(h.ctl.state()).toBe('idle');
  });

  it('treats done and error alike as the end of the run', () => {
    for (const data of [{ 'glowscript.done': true }, { 'glowscript.error': 'boom', type: 'runtime' }]) {
      const h = readyRun();
      h.ctl.receive(data, true);
      expect(h.ctl.state()).toBe('idle');
    }
  });

  it('ignores messages from any other runner, and non-runner messages', () => {
    const h = readyRun();
    h.ctl.receive({ 'glowscript.done': true }, false);
    h.ctl.receive(undefined, true);
    h.ctl.receive({ snapshot: 'data:' }, true);
    expect(h.ctl.state()).toBe('running');
  });
});

describe('defaults', () => {
  it('uses a 2 s stop window and a 500 ms double-click guard', () => {
    expect(STOP_TIMEOUT_MS).toBe(2000);
    expect(STOP_GRACE_MS).toBe(500);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/unit/glowscript-run-state.test.js`
Expected: FAIL with `Cannot find module '../../public/js/embed/glowscript-run-state'`.

- [ ] **Step 3: Write the implementation** at `public/js/embed/glowscript-run-state.js`:

```js
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
      teardown();
      enter('idle');
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
        enter('stopping');
        requestStop();
        timer = setTimer(function () {
          timer = null;
          if (state === 'stopping') { tearDown(); }
        }, stopTimeoutMs);
      },
      // The runner parked the program; its scene stays, frozen.
      stopped: function () {
        if (state !== 'stopping') { return; }
        cancelTimer();
        enter('idle');
      },
      // Route a parsed runner message. Only the current run's runner counts.
      receive: function (data, fromCurrentRunner) {
        if (!data || !fromCurrentRunner) { return; }
        if (data['glowscript.ready']) { api.ready(); }
        else if (data['glowscript.done'] || data['glowscript.error']) { api.finished(); }
        else if (data['glowscript.stopped']) { api.stopped(); }
      },
      state: function () { return state; },
      generation: function () { return generation; }
    };

    return api;
  }

  return { create: create, STOP_TIMEOUT_MS: STOP_TIMEOUT_MS, STOP_GRACE_MS: STOP_GRACE_MS };
}));
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run test/unit/glowscript-run-state.test.js`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit.**

```bash
git add public/js/embed/glowscript-run-state.js test/unit/glowscript-run-state.test.js
git commit -m "feat(glowscript): run-state controller for the Stop button

Pure idle/running/stopping state machine: a 2 s confirmation window with a
teardown fallback, a 500 ms double-click guard, a generation number for the
page's async guards, and routing that ignores any runner but the current one.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Run/Stop button view and styles

**Files:**
- Create: `public/js/embed/run-stop-button.js`
- Create: `static/scss/embed/_run_stop.scss`
- Modify: `static/scss/embed/embed.scss:23` (import after `"glowscript"`)
- Test: `test/unit/run-stop-button.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: the global `trinketRunStopButton` with `create(elements: ArrayLike<Element>, $?: jQuery)`. It returns `{ set(state: 'idle'|'running'|'stopping'), state() }`. `set` throws `Error('unknown run state: <state>')` for anything else.
- Produces these CSS classes, which Task 5 relies on: `run-state-running`, `run-state-stopping`, `run-stop-trace`, and `glowscript-stopped-note`.

- [ ] **Step 1: Restore the declared test dependencies.** `jsdom` is declared in `package.json` but missing from this checkout.

Run: `npm install && git status --short package.json package-lock.json && node -e "require('jsdom'); console.log('jsdom ok')"`
Expected: no output from `git status`, then `jsdom ok`.

- [ ] **Step 2: Write the failing test** at `test/unit/run-stop-button.test.js`:

```js
'use strict';

// Page-side view of the GlowScript Stop button, against the real markup of both
// toolbars that carry a .run-it: the editor toolbar (glowscript.html) and the
// output-only toolbar (default-toolbar.html).
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const { JSDOM } = require('jsdom');
const { create } = require('../../public/js/embed/run-stop-button');

const EDITOR_RUN = '<a id="editorRun" class="run-it menu-button item allow-original" data-action="code.run" data-tooltip aria-haspopup="true" title="View the result." data-options="disable_for_touch:true" data-selector="tip1"><i class="fa fa-play"></i><label class="show-for-large-up">Run</label></a>';
const OUTPUT_RUN = '<button id="outputRun" class="run-it menu-button item button allow-original" data-action="code.run" title="View the result." aria-label="Run Code" role="button" tabindex="0"><i class="fa fa-play"></i><label>Run</label></button>';

function page() {
  const dom = new JSDOM('<!doctype html><body><div class="icon-bar">' + EDITOR_RUN + OUTPUT_RUN + '</div>'
    + '<span class="tooltip" data-selector="tip1">View the result.</span>'
    + '<span class="tooltip" data-selector="other">Other</span></body>');
  const doc = dom.window.document;
  const dataCalls = [];
  const $ = (el) => ({ data: (key, value) => dataCalls.push([el.id, key, value]) });
  const view = create(doc.querySelectorAll('.run-it'), $);
  return { doc, view, dataCalls, editor: doc.getElementById('editorRun'), output: doc.getElementById('outputRun') };
}

const text = (el, sel) => el.querySelector(sel).textContent;
const iconClass = (el) => el.querySelector('i').getAttribute('class');

describe('running', () => {
  it('turns every Run control into Stop', () => {
    const { view, editor, output } = page();
    view.set('running');
    for (const el of [editor, output]) {
      expect(el.getAttribute('data-action')).toBe('code.stop');
      expect(el.getAttribute('aria-label')).toBe('Stop program');
      expect(el.getAttribute('title')).toBe('Stop the program.');
      expect(iconClass(el)).toBe('fa fa-stop');
      expect(text(el, 'label')).toBe('Stop');
      expect(el.classList.contains('run-state-running')).toBe(true);
      expect(el.hasAttribute('aria-disabled')).toBe(false);
    }
  });

  it('updates the action jQuery has cached, which is what embed.js dispatches on', () => {
    const { view, dataCalls } = page();
    view.set('running');
    expect(dataCalls).toEqual([['editorRun', 'action', 'code.stop'], ['outputRun', 'action', 'code.stop']]);
  });

  it('injects one decorative strip per control, however often it runs', () => {
    const { view, editor } = page();
    view.set('running');
    view.set('idle');
    view.set('running');
    const traces = editor.querySelectorAll('svg.run-stop-trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].getAttribute('aria-hidden')).toBe('true');
    const rect = traces[0].querySelector('rect');
    expect(rect.getAttribute('pathLength')).toBe('100');
    expect(rect.getAttribute('width')).toBe('100%');
    expect(rect.getAttribute('height')).toBe('100%');
    expect(rect.getAttribute('rx')).toBe('3');
  });

  it("keeps the control's width while it is Stop, and releases it on Run", () => {
    const { view, editor } = page();
    Object.defineProperty(editor, 'offsetWidth', { configurable: true, value: 88 });
    view.set('running');
    expect(editor.style.minWidth).toBe('88px');
    Object.defineProperty(editor, 'offsetWidth', { configurable: true, value: 120 });
    view.set('stopping');
    expect(editor.style.minWidth).toBe('88px');
    view.set('idle');
    expect(editor.style.minWidth).toBe('');
  });

  it("drops the control's cached Foundation tooltip so it is rebuilt from the new title", () => {
    const { doc, view } = page();
    view.set('running');
    expect(doc.querySelector('span.tooltip[data-selector="tip1"]')).toBeNull();
    expect(doc.querySelector('span.tooltip[data-selector="other"]')).not.toBeNull();
  });

  it('keeps keyboard focus on the same control', () => {
    const { doc, view, output } = page();
    output.focus();
    view.set('running');
    expect(doc.activeElement).toBe(output);
    view.set('idle');
    expect(doc.activeElement).toBe(output);
  });
});

describe('stopping', () => {
  it('shows Stopping…, still routes to code.stop, and is marked disabled for assistive tech', () => {
    const { view, editor } = page();
    view.set('running');
    view.set('stopping');
    expect(text(editor, 'label')).toBe('Stopping…');
    expect(editor.getAttribute('aria-label')).toBe('Stopping program');
    expect(editor.getAttribute('title')).toBe('Stopping the program.');
    expect(editor.getAttribute('data-action')).toBe('code.stop');
    expect(editor.getAttribute('aria-disabled')).toBe('true');
    expect(editor.classList.contains('run-state-stopping')).toBe(true);
    expect(editor.classList.contains('run-state-running')).toBe(false);
  });
});

describe('idle', () => {
  it("restores each toolbar's own original wording exactly", () => {
    const { view, editor, output } = page();
    view.set('running');
    view.set('stopping');
    view.set('idle');

    expect(editor.getAttribute('data-action')).toBe('code.run');
    expect(editor.getAttribute('title')).toBe('View the result.');
    expect(editor.hasAttribute('aria-label')).toBe(false);
    expect(text(editor, 'label')).toBe('Run');

    expect(output.getAttribute('aria-label')).toBe('Run Code');
    expect(text(output, 'label')).toBe('Run');

    for (const el of [editor, output]) {
      expect(iconClass(el)).toBe('fa fa-play');
      expect(el.hasAttribute('aria-disabled')).toBe(false);
      expect(el.classList.contains('run-state-running')).toBe(false);
      expect(el.classList.contains('run-state-stopping')).toBe(false);
    }
  });
});

describe('robustness', () => {
  it('rejects an unknown state', () => {
    const { view } = page();
    expect(() => view.set('paused')).toThrow(/unknown run state/);
  });

  it('copes with a control that has no icon or label', () => {
    const dom = new JSDOM('<a class="run-it" data-action="code.run">Run</a>');
    const view = create(dom.window.document.querySelectorAll('.run-it'));
    expect(() => { view.set('running'); view.set('idle'); }).not.toThrow();
  });

  it('reports its state', () => {
    const { view } = page();
    expect(view.state()).toBe('idle');
    view.set('running');
    expect(view.state()).toBe('running');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails.**

Run: `npx vitest run test/unit/run-stop-button.test.js`
Expected: FAIL with `Cannot find module '../../public/js/embed/run-stop-button'`.

- [ ] **Step 4: Write the view** at `public/js/embed/run-stop-button.js`:

```js
// Page-side view of the GlowScript Stop button: morphs the toolbar's Run
// control(s) between Run, Stop and Stopping…, and back to exactly what each
// one was, so the editor and output-only toolbars keep their own wording.
//
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md
// UMD-lite: window global for the embed page, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketRunStopButton = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STATES = {
    running:  { cls: 'run-state-running',  icon: 'fa fa-stop', label: 'Stop',
                aria: 'Stop program',     title: 'Stop the program.' },
    stopping: { cls: 'run-state-stopping', icon: 'fa fa-stop', label: 'Stopping…',
                aria: 'Stopping program', title: 'Stopping the program.' }
  };

  function setAttr(el, name, value) {
    if (value === null || value === undefined) { el.removeAttribute(name); }
    else { el.setAttribute(name, value); }
  }

  function snapshot(el) {
    var icon = el.querySelector('i');
    var label = el.querySelector('label');
    return {
      action: el.getAttribute('data-action'),
      title: el.getAttribute('title'),
      aria: el.getAttribute('aria-label'),
      icon: icon ? icon.getAttribute('class') : null,
      label: label ? label.textContent : null
    };
  }

  // The strip that laps the control's inside edge while a program runs.
  function addTrace(el) {
    if (el.querySelector('.run-stop-trace')) { return; }
    var doc = el.ownerDocument;
    var svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'run-stop-trace');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var rect = doc.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    rect.setAttribute('rx', '3');
    rect.setAttribute('pathLength', '100');
    svg.appendChild(rect);
    el.appendChild(svg);
  }

  // Foundation builds a control's tooltip lazily from its title and caches it;
  // drop the cached one so the next hover rebuilds it from the new title.
  function dropTooltip(el) {
    var selector = el.getAttribute('data-selector');
    if (!selector) { return; }
    var tips = el.ownerDocument.querySelectorAll('span.tooltip[data-selector="' + selector + '"]');
    Array.prototype.forEach.call(tips, function (tip) { tip.parentNode.removeChild(tip); });
  }

  function setAction(el, action, $) {
    setAttr(el, 'data-action', action);
    // embed.js dispatches on jQuery's .data('action'), which caches the first read.
    if ($) { $(el).data('action', action); }
  }

  function create(elements, $) {
    var items = Array.prototype.map.call(elements, function (el) {
      return { el: el, orig: snapshot(el) };
    });
    var current = 'idle';

    function apply(item, next) {
      var el = item.el;
      var orig = item.orig;
      var icon = el.querySelector('i');
      var label = el.querySelector('label');

      el.classList.remove('run-state-running', 'run-state-stopping');

      if (next === 'idle') {
        setAction(el, orig.action, $);
        setAttr(el, 'title', orig.title);
        setAttr(el, 'aria-label', orig.aria);
        el.removeAttribute('aria-disabled');
        if (icon) { setAttr(icon, 'class', orig.icon); }
        if (label) { label.textContent = orig.label; }
        el.style.minWidth = '';
      } else {
        var s = STATES[next];
        // Keep Run's width so the toolbar does not shift between Run, Stop and Stopping….
        if (current === 'idle') { el.style.minWidth = el.offsetWidth ? el.offsetWidth + 'px' : ''; }
        addTrace(el);
        el.classList.add(s.cls);
        setAction(el, 'code.stop', $);
        setAttr(el, 'title', s.title);
        setAttr(el, 'aria-label', s.aria);
        if (next === 'stopping') { el.setAttribute('aria-disabled', 'true'); }
        else { el.removeAttribute('aria-disabled'); }
        if (icon) { icon.setAttribute('class', s.icon); }
        if (label) { label.textContent = s.label; }
      }

      dropTooltip(el);
    }

    return {
      set: function (next) {
        if (next !== 'idle' && !STATES[next]) { throw new Error('unknown run state: ' + next); }
        items.forEach(function (item) { apply(item, next); });
        current = next;
      },
      state: function () { return current; }
    };
  }

  return { create: create };
}));
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `npx vitest run test/unit/run-stop-button.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 6: Write the styles** at `static/scss/embed/_run_stop.scss`:

```scss
// The Run control while a GlowScript program runs or is stopping.
// run-stop-button.js adds the run-state-* classes and nothing else does, so the
// Run controls of other runtimes are untouched. Values are the spec's:
// docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md
//
// Colors are !important because Foundation's icon-bar and the toolbar rules in
// _wrapper.scss style items, their children and their hover fills through
// several nested selectors; a state color has to win over all of them.

$run-stop-color: #C62828;      // 5.6:1 on white
$run-stopping-color: #6B6B6B;  // 5.3:1 on white

.run-it .run-stop-trace {
  display: none;
}

.run-it.run-state-running,
.run-it.run-state-stopping {
  position: relative;

  .run-stop-trace {
    display: block;
    position: absolute;
    left: 3px;
    top: 3px;
    width: calc(100% - 6px);
    height: calc(100% - 6px);
    overflow: visible;
    pointer-events: none;

    rect {
      fill: none;
      stroke: currentColor;
      stroke-width: 2px;
      stroke-linecap: round;
      stroke-dasharray: 24 76;
      animation: run-stop-lap 1.6s linear infinite;
    }
  }
}

.run-it.run-state-running {
  &,
  > i,
  > label {
    color: $run-stop-color !important;
  }

  &:hover,
  &:focus-visible {
    background: $run-stop-color !important;

    &,
    > i,
    > label {
      color: #fff !important;
    }
  }

  &:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -4px;
  }
}

.run-it.run-state-stopping {
  cursor: progress;

  &,
  > i,
  > label {
    color: $run-stopping-color !important;
  }

  &:hover,
  &:focus,
  &:active {
    background: transparent !important;
  }

  .run-stop-trace rect {
    animation-play-state: paused;
    opacity: 0.5;
  }
}

@keyframes run-stop-lap {
  to {
    stroke-dashoffset: -100;
  }
}

@media (prefers-reduced-motion: reduce) {
  .run-it.run-state-running .run-stop-trace rect,
  .run-it.run-state-stopping .run-stop-trace rect {
    animation: none;
    stroke-dasharray: none;
    stroke-width: 1.5px;
  }
}

.glowscript-stopped-note {
  margin: 2em 1em;
  text-align: center;
  color: #525252;
}
```

- [ ] **Step 7: Import it.** In `static/scss/embed/embed.scss`, add one line directly after `@import "glowscript";` (line 23):

```scss
@import "run_stop";
```

- [ ] **Step 8: Build the CSS and check the output.**

Run: `npm run build:css && grep -c "run-state-running" public/css/embed.css && grep -c "run-stop-lap" public/css/embed.css && grep -c "prefers-reduced-motion" public/css/embed.css`
Expected: the build succeeds, and each `grep -c` prints a number of 1 or more. (`public/css/embed.css` is a build output that git ignores; do not commit it.)

- [ ] **Step 9: Commit.**

```bash
git add public/js/embed/run-stop-button.js static/scss/embed/_run_stop.scss static/scss/embed/embed.scss test/unit/run-stop-button.test.js
git commit -m "feat(glowscript): Run/Stop button view and styles

Morphs every .run-it between Run, Stop and Stopping… and restores each
toolbar's own wording. While running, a strip laps the control's inside
edge (static outline under prefers-reduced-motion).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Wire into the GlowScript embed, and document

**Files:**
- Modify: `lib/views/embed/glowscript.html`: the runner template at `:210-214` (`window.onerror`), `:238-241` (`runProgram`), `:290-299` (the `userMain` callback), and the script list at `:381-389`.
- Modify: `public/js/embed/glowscript.js`: top-level block after `:79`, `:96-107`, `:131-146`, `:254-279`, `:322-329`, `:379`, `:468-483`.
- Create: `test/unit/glowscript-runner-template.test.js`
- Modify: `CHANGELOG.md:12`, `lib/views/static/whats-new.html:39`

**Interfaces:**
- Consumes:
  - from Task 2, `trinketGlowscriptStopShim.source()`;
  - from Task 3, `trinketGlowscriptRunState.create({ onState, requestStop, teardown })` and its `launched()`, `stop()`, `loadFailed()`, `receive(data, fromCurrentRunner)` and `generation()`;
  - from Task 4, `trinketRunStopButton.create(elements, $)` with `.set(state)`, and the `glowscript-stopped-note` class.
- Produces: the runner template variable `stopShim`, and the runner messages `glowscript.ready`, `glowscript.done` and `glowscript.stopped`.

- [ ] **Step 1: Write the failing test** at `test/unit/glowscript-runner-template.test.js`:

```js
'use strict';

// The runner page glowscript.js builds for every Run, executed against a fake
// GlowScript runtime: the stop shim must be installed before the program runs,
// and the runner must report ready, then done -- or stopped -- on both of
// GlowScript's calling styles.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const shim = require('../../public/js/embed/glowscript-stop-shim');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'lib/views/embed/glowscript.html'), 'utf8');
const TEMPLATE = PAGE.split('<textarea id="glowscriptTemplate" class="hide">')[1].split('</textarea>')[0];

function compileTemplate() {
  let exported;
  const src = fs.readFileSync(path.join(ROOT, 'public/js/util/template.js'), 'utf8');
  vm.runInNewContext(src, { window: { TrinketIO: { export: (name, fn) => { exported = fn; } } } });
  return exported.compile(TEMPLATE);
}

// Fill the template the way runCode() in glowscript.js does.
function runnerHtml(version) {
  return compileTemplate()({
    prog: 'Web VPython 3.2\nbox()\n',
    url: 'https://trinket.test',
    domain: 'trinket.test',
    path: 'vpython-glowscript',
    prefix: 'cache-prefix-t/',
    lang: 'vpython',
    runMode: '',
    version: version,
    versionStringAdded: false,
    jqueryList: '',
    glowscriptTextarea: 'block',
    stopShim: shim.source(),
  });
}

// A minimal stand-in for the jQuery calls the runner script makes.
function fakeJQuery(window) {
  const $ = (sel) => {
    const el = typeof sel === 'string' ? window.document.querySelector(sel) : sel;
    return {
      0: el,
      text: () => (el ? el.textContent : ''),
      remove: () => { if (el) { el.remove(); } },
      css: () => {},
      append: () => {},
    };
  };
  $.find = () => [];
  return $;
}

// Load the runner page with a fake runtime whose compiler returns `compiled`.
function loadRunner(version, compiled, waits) {
  const messages = [];
  const dom = new JSDOM(runnerHtml(version), {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.$ = fakeJQuery(window);
      window.reportScriptError = () => '';
      window.glowscript_compile = () => compiled;
      window.ticks = 0;
      Object.assign(window, waits);
      window.addEventListener('message', (e) => {
        try { messages.push(JSON.parse(e.data)); } catch (err) { /* plain-string messages */ }
      });
    },
  });
  return { window: dom.window, messages };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 2000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) { throw new Error('timed out'); }
    await sleep(5);
  }
}
const kinds = (messages) => messages.map((m) => Object.keys(m)[0]);

// GlowScript 2.9+: rate() returns a promise the program awaits.
const promiseRate = { rate: () => new Promise((resolve) => setTimeout(resolve, 1)) };
// GlowScript 1.1 to 2.7: rate(n, continuation).
const callbackRate = { rate: (n, next) => { setTimeout(next, 1); } };

describe('the runner template', () => {
  it('installs the stop shim before compiling or running the program', () => {
    const at = (s) => TEMPLATE.indexOf(s);
    expect(at('{{stopShim}}')).toBeGreaterThan(-1);
    expect(at('{{stopShim}}')).toBeLessThan(at('glowscript_compile('));
    expect(at('{{stopShim}}')).toBeLessThan(at('runProgram(compiled)'));
  });
});

describe('GlowScript 2.9 and later (promise style)', () => {
  it('reports ready, then done, when the program finishes', async () => {
    const { messages } = loadRunner('3.2.3',
      'async function __main__() { await rate(30); await rate(30); }', promiseRate);
    await until(() => kinds(messages).includes('glowscript.done'));
    expect(kinds(messages)).toEqual(['glowscript.ready', 'glowscript.done']);
  });

  it('parks a never-ending program on Stop and reports stopped, not done', async () => {
    const { window, messages } = loadRunner('3.2.3',
      'async function __main__() { while (true) { await rate(30); window.ticks += 1; } }', promiseRate);
    await until(() => window.ticks > 3);
    window.postMessage('glowscript.stop', '*');
    await until(() => kinds(messages).includes('glowscript.stopped'));
    const parkedAt = window.ticks;
    await sleep(30);
    expect(window.ticks).toBe(parkedAt);
    expect(kinds(messages)).not.toContain('glowscript.done');
  });

  it('reports an error, and no done, when the program fails', async () => {
    const { messages } = loadRunner('3.2.3',
      'async function __main__() { throw new Error("boom"); }', promiseRate);
    await until(() => kinds(messages).includes('glowscript.error'));
    expect(kinds(messages)).not.toContain('glowscript.done');
  });
});

describe('GlowScript 1.1 to 2.7 (callback style)', () => {
  it('reports ready, then done, when the program finishes', async () => {
    const { messages } = loadRunner('2.7.5',
      '(function (done) { rate(30, function () { done(); }); })', callbackRate);
    await until(() => kinds(messages).includes('glowscript.done'));
    expect(kinds(messages)).toEqual(['glowscript.ready', 'glowscript.done']);
  });

  it('parks a never-ending program on Stop and reports stopped, not done', async () => {
    const { window, messages } = loadRunner('2.7.5',
      '(function (done) { function loop() { window.ticks += 1; rate(30, loop); } loop(); })', callbackRate);
    await until(() => window.ticks > 3);
    window.postMessage('glowscript.stop', '*');
    await until(() => kinds(messages).includes('glowscript.stopped'));
    const parkedAt = window.ticks;
    await sleep(30);
    expect(window.ticks).toBe(parkedAt);
    expect(kinds(messages)).not.toContain('glowscript.done');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run test/unit/glowscript-runner-template.test.js`
Expected: FAIL. The ordering test fails because `{{stopShim}}` is absent (`indexOf` returns -1), and the done and stopped tests time out.

- [ ] **Step 3: Install the shim in the runner template.** In `lib/views/embed/glowscript.html`, replace

```
            return false;
          };
```

with

```
            return false;
          };

          // Stop button: parks the program on request (glowscript-stop-shim.js).
          {{stopShim}}
```

- [ ] **Step 4: Report done on the 2.9+ path.** In the same file, inside `runProgram`, replace

```
              eval(program);
              await __main__();
```

with

```
              eval(program);
              await __main__();
              window.parent.postMessage(JSON.stringify({ "glowscript.done": true }), "*");
```

- [ ] **Step 5: Report done on the 1.1 to 2.7 path.** In the same file, in the `window.userMain(function(err) {` callback (indented 20 spaces inside the callback), replace

```
                      else {
                        window.parent.postMessage(JSON.stringify({ "glowscript.error" : err.message, type : "runtime" }), "*");
                      }
                    }
                  });
```

with

```
                      else {
                        window.parent.postMessage(JSON.stringify({ "glowscript.error" : err.message, type : "runtime" }), "*");
                      }
                    }
                    else {
                      window.parent.postMessage(JSON.stringify({ "glowscript.done": true }), "*");
                    }
                  });
```

- [ ] **Step 6: Load the new scripts.** In the same file, in the `{% set js = extra_js.concat([` list, replace

```
       '/js/embed/runner-retry.js',
       '/js/embed/glowscript.js'
```

with

```
       '/js/embed/runner-retry.js',
       '/js/embed/glowscript-stop-shim.js',
       '/js/embed/glowscript-run-state.js',
       '/js/embed/run-stop-button.js',
       '/js/embed/glowscript.js'
```

- [ ] **Step 7: Run the template test to verify it passes.**

Run: `npx vitest run test/unit/glowscript-runner-template.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 8: Add the page-side helpers to `glowscript.js`.** In `public/js/embed/glowscript.js`, directly after the `var runnerRetry = ...;` statement (it ends at line 79), add:

```js

// Run/Stop button (docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md).
// runState decides, runButton draws, and this file owns the DOM and the runner.
var runState  = null;
var runButton = null;
// A runner that reported a load failure and is about to be rebuilt: the compile
// error it reports next is expected and must not end the run.
var ignoredRunner = null;

function currentRunnerWindow() {
  var frame = document.getElementById('glowscriptOutput');
  return frame ? frame.contentWindow : null;
}

// No confirmation from the runner (or it was never ready): remove it outright.
function tearDownRunner() {
  $('#glowscriptIframeContainer').empty().append(
    $('<p>', { 'class': 'glowscript-stopped-note', text: 'Program stopped. Press Run to start it again.' })
  );
  $('#loadingContent').hide();
}

function stopShimSource() {
  return (typeof trinketGlowscriptStopShim !== 'undefined') ? trinketGlowscriptStopShim.source() : '';
}
```

- [ ] **Step 9: Guard load-failure rebuilds.** Replace the whole `handleRunnerLoadFailure` function (lines 96-107) with:

```js
function handleRunnerLoadFailure(src, source) {
  if (!runnerRetry || !lastRunnerHtml) { return; }
  var verdict = runnerRetry.onLoadFailure(src);
  if (verdict.retry) {
    ignoredRunner = source || null;
    var generation = runState ? runState.generation() : null;
    setTimeout(function() {
      // A Stop, or a newer Run, since this was scheduled: don't resurrect it.
      if (runState && runState.generation() !== generation) { return; }
      rebuildRunner();
    }, verdict.delayMs);
  }
  else if (verdict.reason === 'exhausted') {
    api.showMessage('alert',
      'The 3D runtime could not be loaded after several tries. ' +
      'Please check your connection and press Run again.');
    if (runState) { runState.loadFailed(); }
  }
}
```

- [ ] **Step 10: Guard the external sandbox reply.** In `runCodeExternal`, replace

```js
  $.post(sandboxUrl, {files: files})
    .done(function(data, status) {
      if (status === "success") {
```

with

```js
  var generation = runState ? runState.generation() : null;

  $.post(sandboxUrl, {files: files})
    .done(function(data, status) {
      // A Stop, or a newer Run, since this was sent: don't resurrect it.
      if (runState && runState.generation() !== generation) { return; }
      if (status === "success") {
```

- [ ] **Step 11: Inject the shim and announce the launch in `runCode()`.**
  1. In the `template('glowscriptTemplate', { ... })` call, replace `    glowscriptTextarea : glowscriptTextarea` with:

     ```js
         glowscriptTextarea : glowscriptTextarea,
         stopShim   : stopShimSource()
     ```

  2. Replace

     ```js
       if (runnerRetry) { runnerRetry.reset(); }
     ```

     with

     ```js
       if (runnerRetry) { runnerRetry.reset(); }

       // The control is Stop for as long as this run lasts.
       ignoredRunner = null;
       if (runState) { runState.launched(); }
     ```

- [ ] **Step 12: Create the controller and the view first thing in `initialize`.** Replace

```js
    autoRun = (start === 'result');
```

with

```js
    autoRun = (start === 'result');

    // Before anything can start a run (start=result runs from api.reset below).
    if (typeof trinketGlowscriptRunState !== 'undefined' && typeof trinketRunStopButton !== 'undefined') {
      runButton = trinketRunStopButton.create(document.querySelectorAll('.run-it'), $);
      runState = trinketGlowscriptRunState.create({
        onState     : function(state) { runButton.set(state); },
        requestStop : function() {
          var runner = currentRunnerWindow();
          if (runner) { runner.postMessage('glowscript.stop', '*'); }
        },
        teardown    : tearDownRunner
      });
    }
```

- [ ] **Step 13: Handle the Stop event.** Replace

```js
    $(document).on('trinket.code.run',  $.proxy(this.showResult, this));
```

with

```js
    $(document).on('trinket.code.run',  $.proxy(this.showResult, this));
    $(document).on('trinket.code.stop', function() { if (runState) { runState.stop(); } });
```

- [ ] **Step 14: Route runner messages.** In the `window.addEventListener('message', ...)` handler inside `initialize`:
  1. Replace `handleRunnerLoadFailure(data["glowscript.loadfail"]);` with `handleRunnerLoadFailure(data["glowscript.loadfail"], e.source);`.
  2. Replace

     ```js
           if (data && data["glowscript.error"]) {
             api.showMessage('alert', data["glowscript.error"]);
           }
         });
     ```

     with

     ```js
           if (data && data["glowscript.error"]) {
             api.showMessage('alert', data["glowscript.error"]);
           }

           // Only the current run's runner moves the Run/Stop control.
           if (runState) {
             runState.receive(data, e.source === currentRunnerWindow() && e.source !== ignoredRunner);
           }
         });
     ```

- [ ] **Step 15: Check that nothing else regressed.**

Run: `npx vitest run test/unit test/lib/api/runner-asset-prefix.test.js test/lib/api/examModePlainEditor.test.js`
Expected: PASS for every file. In particular `cachify-stamps-scripts.test.js` still sees `glowscript.html` routing its list through `cachify_js`.

- [ ] **Step 16: Document it.**
  1. In `CHANGELOG.md`, insert this as the first bullet under `### Writing and running code` (line 12, after its blank line):

     ```markdown
     - **Web VPython programs can be stopped.** While a program runs, Run turns into
       a red Stop with a strip lapping its edge; Stop freezes the scene where it
       stands (it can still be rotated and zoomed), and the button returns to Run,
       as it also does when a program finishes on its own.
     ```

  2. In `lib/views/static/whats-new.html`, insert directly before `      <li><strong>iPad friendly.</strong>`:

     ```html
           <li><strong>Stop Web VPython programs.</strong> While a Web VPython program runs, the
             Run button turns into Stop. Press it to freeze the animation where it is (you can
             still turn and zoom the scene), and Run comes back when you're ready to go again.</li>
     ```

- [ ] **Step 17: Commit.**

```bash
git add lib/views/embed/glowscript.html public/js/embed/glowscript.js test/unit/glowscript-runner-template.test.js CHANGELOG.md lib/views/static/whats-new.html
git commit -m "feat(glowscript): Stop button for Web VPython trinkets

Injects the stop shim into every runner page, reports done when a program
finishes, and wires the run-state controller and Run/Stop view into the
GlowScript embed. Stop freezes the program in place; if the runner does not
confirm within 2 s (or never became ready) it is torn down instead. A
generation guard keeps a stopped run from being resurrected by a late
external-sandbox reply or a scheduled load-failure rebuild.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Browser spec and final verification

**Files:**
- Create: `test/browser/specs/glowscript-stop.spec.js`

**Interfaces:**
- Consumes: the whole feature (Tasks 2 to 5), and from `spike.md` the element `print()` writes into (expected `textarea#print`).
- Produces: nothing new.

- [ ] **Step 1: Write the spec** at `test/browser/specs/glowscript-stop.spec.js`. If `spike.md` recorded a different print element, use that selector in `printed()`.

```js
const { test, expect } = require('@playwright/test');

// The Web VPython (glowscript) Stop button, end to end against the real
// runtime. Needs the local stack with the vendored 3.2.3 runtime
// (test/browser/README.md). Spec:
// docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const LOOP = 'Web VPython 3.2\nb = box()\nn = 0\nwhile True:\n    rate(30)\n    n = n + 1\n    b.rotate(angle=0.05, axis=vec(0, 1, 0))\n    print(n)\n';
const FINITE = 'Web VPython 3.2\nsphere()\nfor i in range(3):\n    rate(10)\n';
const BROKEN = 'Web VPython 3.2\nwhile True\n    rate(30)\n';

async function run(page, code) {
  await page.goto('/embed/glowscript');
  await expect(page.locator('.ace_editor')).toBeVisible();
  await page.evaluate((src) => {
    document.querySelector('.ace_editor').env.editor.setValue(src, 1);
  }, code);
  await page.locator('.run-it').first().click();
}

const runControl = (page) => page.locator('.run-it').first();
const printed = (page) => page.frameLocator('#glowscriptOutput').locator('textarea#print').inputValue();
const printedLines = async (page) => (await printed(page)).split('\n').filter(Boolean).length;

test.describe('Web VPython Stop button', () => {
  test('Run turns into Stop, with the strip, while a program runs', async ({ page }) => {
    await run(page, LOOP);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page).locator('label')).toHaveText('Stop');
    await expect(runControl(page).locator('svg.run-stop-trace')).toBeVisible();
  });

  test('Stop freezes the program in place and returns to Run', async ({ page }) => {
    await run(page, LOOP);
    await expect.poll(() => printedLines(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForTimeout(600); // past the double-click guard
    await runControl(page).click();
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 5_000 });
    await expect(runControl(page).locator('label')).toHaveText('Run');

    const frozen = await printed(page);
    await page.waitForTimeout(1_500);
    expect(await printed(page)).toBe(frozen);
    await expect(page.locator('#glowscriptOutput')).toHaveCount(1);
    await expect(page.locator('.glowscript-stopped-note')).toHaveCount(0);
  });

  test('a program that finishes returns to Run on its own', async ({ page }) => {
    await run(page, FINITE);
    await expect(runControl(page)).toHaveClass(/run-state-running/);
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 60_000 });
  });

  test('a compile error returns to Run', async ({ page }) => {
    await run(page, BROKEN);
    await expect(runControl(page)).not.toHaveClass(/run-state-/, { timeout: 60_000 });
  });
});
```

- [ ] **Step 2: Run it if the local stack is up.**

Run: `curl -sf -o /dev/null http://localhost:3001/ && echo stack-up || echo stack-down`

- If the stack is up, run `cd test/browser && npm install && npx playwright test specs/glowscript-stop.spec.js`. Expected: 4 passed.
- If the stack is down, do not start it. Record "glowscript-stop.spec.js written, not run: local stack unavailable" in `.claude/epics/glowscript-stop-button/updates/verification.md`, and report it in the final summary.

- [ ] **Step 3: Run the full unit and API suite, and the CSS build.**

Run: `npx vitest run && npm run build:css`
Expected: every test file passes and the CSS build succeeds. Record the pass and fail counts in `.claude/epics/glowscript-stop-button/updates/verification.md`.

- [ ] **Step 4: Commit.**

```bash
git add test/browser/specs/glowscript-stop.spec.js
git commit -m "test(glowscript): browser spec for the Web VPython Stop button

Run shows Stop with the strip; Stop freezes the program and returns to Run;
a finishing program and a compile error both return to Run on their own.
Runs against the local stack with the vendored 3.2.3 runtime.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
