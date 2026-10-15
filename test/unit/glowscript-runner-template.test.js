'use strict';

// The runner page glowscript.js builds for every Run, executed against a fake
// GlowScript runtime: the stop shim must be installed before the program runs,
// and the runner must report ready, then done -- or stopped -- on both of
// GlowScript's calling styles.
// Spec: docs/superpowers/specs/2026-10-09-glowscript-stop-button-design.md

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
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
function runnerHtml(version, stopShim) {
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
    stopShim: stopShim === undefined ? shim.source() : stopShim,
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
      // The pre-2.9 snapshot code waits for its image to load; a fake image already has.
      load: (fn) => { fn.call(el); },
    };
  };
  $.find = () => [];
  return $;
}

// Load the runner page with a fake runtime whose compiler returns `compiled`.
// `waits` holds the runtime's wait functions, or installs a fuller runtime
// when it is a function of the runner's window.
function loadRunner(version, compiled, waits, stopShim) {
  const messages = [];
  const warnings = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('warn', (...args) => warnings.push(args.join(' ')));
  // Forward the runner page's own errors (an uncaught exception, a missing
  // browser API): otherwise they vanish, and the test only reports 'timed out'.
  virtualConsole.on('jsdomError', (error) => {
    console.error('runner page:', error.message);
    if (error.detail) { console.error(error.detail); }
  });
  const dom = new JSDOM(runnerHtml(version, stopShim), {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window.$ = fakeJQuery(window);
      window.reportScriptError = () => '';
      window.glowscript_compile = () => compiled;
      window.ticks = 0;
      if (typeof waits === 'function') { waits(window); } else { Object.assign(window, waits); }
      window.addEventListener('message', (e) => {
        try { messages.push(JSON.parse(e.data)); } catch (err) { /* plain-string messages */ }
      });
    },
  });
  return { window: dom.window, messages, warnings };
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

// The page's stop request. The runner takes a stop only from its parent, and a
// top-level jsdom window is its own parent. window.postMessage cannot stand in:
// jsdom delivers it with no source.
function sendStop(window) {
  window.dispatchEvent(new window.MessageEvent('message', { data: 'glowscript.stop', source: window.parent }));
}

// GlowScript 2.9+: rate() returns a promise the program awaits.
const promiseRate = { rate: () => new Promise((resolve) => setTimeout(resolve, 1)) };
// GlowScript 1.1 to 2.7: rate(n, continuation).
const callbackRate = { rate: (n, next) => { setTimeout(next, 1); } };

// A canvas whose screenshot goes through the wrapped waits, as GlowScript's
// does: the renderer waits for canvas.waitfor('draw_complete'), which polls
// the global rate(60) until the runtime's render loop (which Stop leaves
// running) has drawn a frame. jsdom has no 2D canvas, so the drawing the
// snapshot code does afterwards is stubbed.
const SNAPSHOT = 'data:image/png;base64,c25hcHNob3Q=';
function snapshotCanvas(window, screenshot, waitfor) {
  function canvas() {
    const scene = this;
    scene.drawn = false;
    (function renderLoop() { scene.drawn = true; window.setTimeout(renderLoop, 5); }());
    scene.__renderer = { screenshot: screenshot(scene) };
  }
  canvas.prototype.waitfor = waitfor;
  canvas.activated = [];
  window.canvas = canvas;
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage: () => {} });
  window.HTMLCanvasElement.prototype.toDataURL = () => SNAPSHOT;
}
const IMAGE = { width: 400, height: 300 };
// GlowScript 2.9 and later, shaped like 3.2.2.
function snapshotRuntimePromise(window) {
  Object.assign(window, promiseRate);
  snapshotCanvas(window,
    (scene) => async () => { await scene.waitfor('draw_complete'); return IMAGE; },
    async function (event) {
      this.drawn = false;
      while (!this.drawn) { await window.rate(60); }
      return event;
    });
}
// GlowScript 1.1 to 2.7, shaped like 2.7.5: continuations instead of promises.
function snapshotRuntimeCallback(window) {
  Object.assign(window, callbackRate);
  snapshotCanvas(window,
    (scene) => (done) => { scene.waitfor('draw_complete', () => done(null, IMAGE)); },
    function (event, next) {
      const scene = this;
      scene.drawn = false;
      (function poll() { if (scene.drawn) { next(event); } else { window.rate(60, poll); } }());
    });
}

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
    sendStop(window);
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
    sendStop(window);
    await until(() => kinds(messages).includes('glowscript.stopped'));
    const parkedAt = window.ticks;
    await sleep(30);
    expect(window.ticks).toBe(parkedAt);
    expect(kinds(messages)).not.toContain('glowscript.done');
  });
});

// window.onerror reports an error the runner did not catch. On GlowScript 2.9
// and later the main flow's own errors arrive through runProgram instead, so
// one window.onerror sees while that flow runs came from outside it. Each test
// fires the program's event handler on the runner's own timer queue, as the
// runtime would; the uncaught error it raises is forwarded to the test output.
describe('an error raised outside the main flow', () => {
  const HANDLER = 'window.handler = function () { undefinedThing.x = 1; };';
  const handlerReport = (messages) => messages.find((m) => String(m['glowscript.error']).includes('undefinedThing'));

  it('is tagged background while the main flow runs (GlowScript 2.9 and later)', async () => {
    const { window, messages } = loadRunner('3.2.3',
      HANDLER + 'async function __main__() { while (!window.finish) { await rate(30); window.ticks += 1; } }', promiseRate);
    await until(() => window.ticks > 3);
    window.setTimeout(window.handler, 0);
    await until(() => handlerReport(messages));
    const ticks = window.ticks;
    await until(() => window.ticks > ticks);
    window.finish = true;
    await until(() => kinds(messages).includes('glowscript.done'));
    expect(handlerReport(messages)).toMatchObject({ type: 'runtime', 'glowscript.background': true });
  });

  const settledMains = [
    ['finished', 'async function __main__() { await rate(30); }', 'glowscript.done'],
    ['failed', 'async function __main__() { await rate(30); throw new Error("main failed"); }', 'glowscript.error'],
  ];
  for (const [how, main, settled] of settledMains) {
    it(`is not tagged once the main flow has ${how}`, async () => {
      const { window, messages } = loadRunner('3.2.3', HANDLER + main, promiseRate);
      await until(() => kinds(messages).includes(settled));
      window.setTimeout(window.handler, 0);
      await until(() => handlerReport(messages));
      expect(handlerReport(messages)).not.toHaveProperty(['glowscript.background']);
    });
  }

  it('is not tagged before GlowScript 2.9, where main-flow errors may arrive only this way', async () => {
    const { window, messages } = loadRunner('2.7.5',
      HANDLER + '(function (done) { function loop() { window.ticks += 1; if (window.finish) { done(); } else { rate(30, loop); } } loop(); })',
      callbackRate);
    await until(() => window.ticks > 3);
    window.setTimeout(window.handler, 0);
    await until(() => handlerReport(messages));
    window.finish = true;
    await until(() => kinds(messages).includes('glowscript.done'));
    expect(handlerReport(messages)).not.toHaveProperty(['glowscript.background']);
  });
});

describe('a snapshot requested after Stop', () => {
  const cases = [
    ['3.2.3', snapshotRuntimePromise,
      'async function __main__() { window.scene = new canvas(); while (true) { await rate(30); window.ticks += 1; } }',
      (window, done) => { window.rate(30).then(done); }],
    ['2.7.5', snapshotRuntimeCallback,
      '(function (done) { window.scene = new canvas(); function loop() { window.ticks += 1; rate(30, loop); } loop(); })',
      (window, done) => { window.rate(30, done); }],
  ];
  for (const [version, runtime, compiled, wait] of cases) {
    it(`is answered while the program stays parked (GlowScript ${version})`, async () => {
      const { window, messages } = loadRunner(version, compiled, runtime);
      try {
        await until(() => window.ticks > 3);
        sendStop(window);
        await until(() => kinds(messages).includes('glowscript.stopped'));
        const parkedAt = window.ticks;

        window.postMessage('glowscript.snapshot', '*');
        // Posted only once the runtime's screenshot has resolved.
        await until(() => kinds(messages).includes('snapshot'));
        expect(messages.find((m) => m.snapshot).snapshot).toBe(SNAPSHOT);

        // The screenshot's waits were let through only while it ran.
        let resumed = false;
        wait(window, () => { resumed = true; });
        await sleep(30);
        expect(resumed).toBe(false);
        expect(window.ticks).toBe(parkedAt);
      } finally {
        window.close();
      }
    });
  }
});

describe('a snapshot when the stop shim is missing or broken', () => {
  const RUNNING = {
    '3.2.3': 'async function __main__() { window.scene = new canvas(); while (!window.finish) { await rate(30); } }',
    '2.7.5': '(function (done) { window.scene = new canvas(); function loop() { if (!window.finish) { rate(30, loop); } } loop(); })',
  };
  const RUNTIME = { '3.2.3': snapshotRuntimePromise, '2.7.5': snapshotRuntimeCallback };
  const cases = [
    ['3.2.3', 'no stop shim', 'throw new Error("shim");', null],
    ['3.2.3', 'an older stop shim without allowWaits', 'window.__trinketStop = {};', null],
    ['3.2.3', 'allowWaits throws', 'window.__trinketStop = { allowWaits: function () { throw new Error("broken"); } };',
      'snapshot waits not allowed'],
    ['2.7.5', 'allowWaits returns no release function', 'window.__trinketStop = { allowWaits: function () { return 1; } };',
      'snapshot waits not closed'],
  ];
  for (const [version, what, stopShim, warning] of cases) {
    it(`is still answered with ${what} (GlowScript ${version})`, async () => {
      const { window, messages, warnings } = loadRunner(version, RUNNING[version], RUNTIME[version], stopShim);
      try {
        await until(() => window.scene);
        window.postMessage('glowscript.snapshot', '*');
        await until(() => kinds(messages).includes('snapshot'));
        // A shim that has no window to offer is not a failure: nothing to warn about.
        const snapshotWarnings = warnings.filter((w) => w.includes('snapshot waits'));
        if (warning) { expect(snapshotWarnings.join('\n')).toContain(warning); }
        else { expect(snapshotWarnings).toEqual([]); }
      } finally {
        window.finish = true;
        window.close();
      }
    });
  }
});

describe('a failing stop shim', () => {
  const cases = [
    ['3.2.3', 'async function __main__() { await rate(30); }', promiseRate],
    ['2.7.5', '(function (done) { rate(30, function () { done(); }); })', callbackRate],
  ];
  for (const [version, compiled, waits] of cases) {
    it(`never keeps the program from running (GlowScript ${version})`, async () => {
      const { messages, warnings } = loadRunner(version, compiled, waits, 'throw new Error("shim");');
      await until(() => kinds(messages).includes('glowscript.done'));
      expect(kinds(messages)).toEqual(['glowscript.done']);
      expect(warnings.join('\n')).toContain('Stop button unavailable');
    });
  }
});
