const { test, expect } = require('@playwright/test');

// §16 canary (decision V3): the captured transport stream, the PORTED handler,
// and trinket's SERVED glow 3.2.3 — before anything is built on that combination.
// No worker involved: the fixtures are replayed directly on a blank embed page.

// Captured verbatim from the channel spike. MSG0's second entry has NO `cmd`
// key — it exercises handle_cmds' non-constructor path; do not "fix" it.
const MSG0 = {"cmds": [{"cmd": "canvas", "idx": 0}, {"lights": "empty_list", "idx": 0}, {"cmd": "distant_light", "idx": 2, "direction": [0.22, 0.44, 0.88], "color": [0.8, 0.8, 0.8], "canvas": 0}, {"cmd": "distant_light", "idx": 3, "direction": [-0.88, -0.22, -0.44], "color": [0.3, 0.3, 0.3], "canvas": 0}]};
const MSG1 = {"cmds": [{"cmd": "sphere", "idx": 4, "color": [1.0, 0.0, 0.0], "size": [3.0, 3.0, 3.0], "canvas": 0}], "attrs": ["a4a1,2,3"]};

// --- running a program on the real path -------------------------------------
// Every spec below the canary does the same three things: check the opt-in flag
// is actually on in this dev stack, put the program in the editor, hit Run.
// runVPython() is that, and it is where a change to how a program is started
// belongs — not in six copies.

// The path is opt-in and OFF by default, so a dev stack without it in
// config/local.yaml would fail these for a configuration reason rather than a
// code reason. Probe the flag the page actually received and say what to do.
async function skipUnlessWorkerVPython(page) {
  await page.goto('/embed/python3');
  const on = await page.evaluate(() =>
    !!(window.trinket && window.trinket.config && window.trinket.config.workerVPython));
  test.skip(!on, 'SKIP: features.workerVPython is off in this dev stack. ' +
    'Add `workerVPython: true` under `features:` in config/local.yaml and ' +
    '`docker restart trinket-gcr`, then re-run.');
}

// Load the page, gate on the flag, type the program, Run. Returns once the click
// has landed — WAITING for the scene is each spec's own business, because what
// counts as "up" differs (a 3D canvas, a graph canvas, a console message).
//
// Any tap a spec installs with page.addInitScript() must be installed BEFORE
// this is called: the goto inside it is the navigation the taps attach to.
async function runVPython(page, src) {
  await skipUnlessWorkerVPython(page);
  // Generous, not the 5 s default: these specs run back to back and each leaves
  // a Pyodide teardown behind it, so the editor's own boot has been seen to lose
  // the race on a loaded machine. Waiting longer costs nothing when it is ready
  // (which is almost always) and turns a flake into a real failure signal.
  await expect(page.locator('.ace_editor').first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate((code) => {
    document.querySelector('.ace_editor').env.editor.setValue(code, 1);
  }, src);
  await page.locator('.run-it').first().click();
}

// The tap every real-path spec installs: the worker channel, seen from outside
// the page's own code. Counts scene-ops in, records scene-events out.
async function tapWorkerChannel(page) {
  await page.addInitScript(() => {
    const RealWorker = window.Worker;
    window.__sceneOps = [];        // one entry per inbound package (the generation)
    window.__sceneEvents = [];     // the raw JSON of every outbound scene-event
    window.__workers = [];
    window.Worker = function (url, options) {
      const w = new RealWorker(url, options);
      window.__workers.push(w);
      const realPost = w.postMessage.bind(w);
      w.postMessage = function (m) {
        if (m && m.type === 'scene-event') window.__sceneEvents.push(String(m.events));
        return realPost(m);
      };
      w.addEventListener('message', (e) => {
        const d = e && e.data;
        if (d && d.type === 'scene-ops') window.__sceneOps.push(d.generation);
      });
      return w;
    };
    window.Worker.prototype = RealWorker.prototype;
  });
}

const STATIC_SPHERE = 'from vpython import *\nball = sphere(color=color.red)\n';

test.describe('Worker VPython (vpython-jupyter adoption)', () => {
  test('CANARY: captured sphere stream renders on trinket glow 3.2.3', async ({ page }) => {
    const logs = [];
    page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
    // Kept separate from `logs` because it is ASSERTED, not just printed: an
    // exception thrown inside glow's async render loop lands here and nowhere
    // else, and would otherwise be invisible unless it happened to zero the
    // pixel count. Tasks 8-11 add genuinely async behaviour to this file.
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto('/embed/python3?runtime=main');   // any embed page; we just need a DOM + origin

    const result = await page.evaluate(async ([MSG0, MSG1]) => {
      const load = (src) => new Promise((ok, bad) => {
        const s = document.createElement('script'); s.src = src; s.onload = ok;
        s.onerror = () => bad(new Error('failed to load ' + src));
        document.head.appendChild(s);
      });
      await load('/components/vpython-glowscript/package/glow.3.2.3.min.js');
      await load('/components/vpython-worker/glowcomm_host.js');

      const holder = document.createElement('div');
      holder.id = 'canary-scene'; document.body.appendChild(holder);
      // glowcomm.js:776-778 sets __context before the constructors run; the port
      // merges into it as well, but it has to exist first.
      window.__context = { glowscript_container: $(holder) };

      const errs = [];
      const fe = self.createGlowFrontend({ container: holder, send: () => {} });
      try { fe.handle(JSON.parse(JSON.stringify(MSG0))); }
      catch (e) { errs.push('MSG0: ' + ((e && e.stack) || e)); }
      try { fe.handle(JSON.parse(JSON.stringify(MSG1))); }
      catch (e) { errs.push('MSG1: ' + ((e && e.stack) || e)); }

      // The registry, against the REAL glow constructors (the unit suite can only
      // check this against a stub): idx 0 canvas, 2+3 lights, 4 sphere, and the
      // compact attr code "a4a1,2,3" applied to the live sphere as a glow vector.
      const objs = fe._objs();
      const sphere = objs[4];
      const shape = {
        idxs: Object.keys(objs),
        isCanvas: !!(objs[0] && objs[0].__proto__ && objs[0].__proto__.constructor === window.canvas),
        lights: (objs[0] && objs[0].lights && objs[0].lights.length) || 0,
        pos: sphere && sphere.pos ? [sphere.pos.x, sphere.pos.y, sphere.pos.z] : null,
        color: sphere && sphere.color ? [sphere.color.x, sphere.color.y, sphere.color.z] : null,
      };

      // GlowScript renders into a <canvas> inside the container.
      await new Promise(r => setTimeout(r, 1500));
      const cv = holder.querySelector('canvas');
      if (!cv) return { ok: false, why: 'no canvas element', errs, shape };

      const glName = ['webgl2', 'webgl', 'experimental-webgl']
        .find(n => { try { return !!cv.getContext(n); } catch (e) { return false; } });
      const gl = glName ? cv.getContext(glName) : null;
      if (!gl) return { ok: false, why: 'no WebGL context', errs, shape };

      // Count red-ish pixels: the fixture sphere is color=[1,0,0] on a black scene.
      const readRed = () => {
        const px = new Uint8Array(4 * cv.width * cv.height);
        gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let n = 0;
        for (let i = 0; i < px.length; i += 4) { if (px[i] > 60 && px[i+1] < 60 && px[i+2] < 60) n++; }
        return n;
      };
      // glow does not ask for preserveDrawingBuffer, so a read taken outside the
      // drawing frame sees a cleared buffer (measured: 0). The shipped assertion
      // reads inside a rAF callback; `direct` is kept only to document that.
      //
      // The read RETRIES across frames rather than sampling one. A single rAF
      // read assumes glow has drawn by the time the 1500 ms wait is up, which is
      // usually true and was observed false once, on a loaded machine running
      // this file's other 9 specs first (SwiftShader was logging "GPU stall due
      // to ReadPixels" at the time): `inFrame` came back 0 while every other
      // assertion in this test passed, and the same test passed alone
      // immediately after. Waiting for the frame asserts the same thing — a red
      // sphere rasterised — without asserting it happened by an arbitrary
      // deadline.
      let direct = -1, inFrame = -1, readErr = null;
      try { direct = readRed(); } catch (e) { readErr = String(e); }
      try {
        const nextFrame = () => new Promise(r => requestAnimationFrame(r));
        for (let i = 0; i < 120 && inFrame <= 100; i++) {   // ~2 s at 60 fps
          await nextFrame();
          inFrame = readRed();
        }
      } catch (e) { readErr = String(e); }

      return {
        errs, shape, glName, readErr, direct, inFrame,
        preserveDrawingBuffer: !!gl.getContextAttributes().preserveDrawingBuffer,
        w: cv.width, h: cv.height,
        why: 'red px: inFrame=' + inFrame + ' (direct=' + direct + ')',
      };
    }, [MSG0, MSG1]);

    console.log('CANARY diagnostics: ' + JSON.stringify(result, null, 2));
    if (logs.length) console.log('page console:\n' + logs.join('\n'));

    expect(result.errs, 'the ported handler threw on the captured stream').toEqual([]);
    // Nothing blew up asynchronously either — see the pageErrors comment above.
    // No filter: the only page-console noise these runs produce is SwiftShader's
    // "GPU stall due to ReadPixels" performance warning, which is a console
    // warning and never reaches pageerror.
    expect(pageErrors, 'uncaught page exception (glow render loop?)').toEqual([]);
    // Whole stream landed on real glow constructors.
    expect(result.shape.idxs).toEqual(['0', '2', '3', '4']);
    expect(result.shape.isCanvas).toBe(true);       // idx 0 is a real glow canvas, not just some object
    expect(result.shape.lights).toBe(2);            // "empty_list" cleared the defaults, 2 distant_lights added
    expect(result.shape.pos).toEqual([1, 2, 3]);    // compact attr code "a4a1,2,3" reached the live object
    expect(result.shape.color).toEqual([1, 0, 0]);
    // ...and it actually rasterised: a red sphere occupies >100 pixels.
    expect(result.inFrame).toBeGreaterThan(100);
  });

  // --- Task 7: the real path ------------------------------------------------
  // Everything above replays fixtures. Everything below runs a STUDENT PROGRAM:
  // editor -> router -> worker -> vpython wheel -> transport -> scene-ops ->
  // the page host shim -> GlowScript on the page.
  //
  // The programs in THIS block are deliberately static — no rate(), no
  // animation — so they isolate "the scene renders" from "the loop is paced".
  // Animation is the Task 8 spec at the bottom of the file (which is also what
  // made the kernel apply the async transform to vpython runs; these static
  // programs go through that same transform now, and must still pass).

  test('a real program renders a sphere via the worker', async ({ page }) => {
    // Well past the file's 90 s default: a cold Pyodide boot plus a 3.5 MB wheel
    // install is the slow part, and the toPass budget below has to fit inside it.
    test.setTimeout(300_000);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await runVPython(page, STATIC_SPHERE);

    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
      // GLOW IS LAZY (Task 2 finding): a canvas with no objects produces no
      // <canvas> element at all, so the element itself — not the container — is
      // the "the scene is really up" signal.
      const n = await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length);
      expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // ...and it is THIS program's sphere, not just any canvas: the student's
    // `color=color.red` survived Python -> wire -> port -> glow as a real vector.
    const scene = await page.evaluate(() => {
      const objs = window.__vpythonScene.frontend._objs();
      const red = objs.find((o) => o && o.color && o.color.x === 1 && o.color.y === 0 && o.color.z === 0);
      return { count: objs.filter(Boolean).length, red: !!red };
    });
    expect(scene.red, 'the red sphere never reached GlowScript').toBe(true);
    expect(scene.count).toBeGreaterThan(1);   // canvas + lights + the sphere

    // The scene shares the output pane with the console, exactly like a figure.
    await expect(page.locator('#graphic-wrap')).toBeVisible();
    expect(pageErrors, 'uncaught page exception on the worker vpython path').toEqual([]);
  });

  test('scene ops carry the live generation, and a stale scene is dropped', async ({ page }) => {
    // Two full runs — and since Task 11 each is its own cold Pyodide boot plus
    // wheel install — plus a quiet-stream measurement between them.
    test.setTimeout(420_000);
    // Task 5 stamps `generation` on every scene-ops package and Task 7 owns the
    // counter it stamps; until now neither had a test. Tap the worker channel
    // from OUTSIDE the page code so the assertion sees the real wire messages.
    await tapWorkerChannel(page);
    await runVPython(page, STATIC_SPHERE);

    await expect(async () => {
      const n = await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length);
      expect(n).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // The pacing clock belongs to the RUN, not to the scene. Once the program has
    // finished (plus a short drain so its last objects flush), the stream must go
    // quiet: an idle scene polling the worker 30 times a second for the life of
    // the tab is pure cost, and glow orbits the camera on this thread anyway.
    await expect(async () => {
      const before = await page.evaluate(() => window.__sceneOps.length);
      await page.waitForTimeout(1000);
      expect(await page.evaluate(() => window.__sceneOps.length),
        'the pacing clock is still ticking after the run finished').toBe(before);
    }).toPass({ timeout: 60_000 });

    // Every package of the first run carries generation 1 — the page's counter,
    // bumped once when this run tore the previous (empty) scene down. A literal
    // 0 would mean the kernel is still being told a constant.
    const gens = await page.evaluate(() => window.__sceneOps.slice());
    expect(gens.length).toBeGreaterThan(0);
    expect([...new Set(gens)]).toEqual([1]);
    expect(await page.evaluate(() => window.__vpythonScene.generation)).toBe(1);
    expect(await page.evaluate(() => window.__vpythonScene.handled)).toBeGreaterThan(0);

    // A package from a scene the page has already torn down must be dropped, not
    // drawn. Inject one directly on the worker object: `generation` is the only
    // thing that makes it stale, and this is the cheapest way to produce one
    // deterministically.
    // The counters are read inside the SAME evaluate as the dispatch: the pacer
    // is live and moves `handled` between two separate round trips.
    const probe = await page.evaluate(() => {
      const before = window.__vpythonScene.dropped;
      // The LAST worker, not the first: a vpython run discards the interpreter
      // and boots a fresh one (Task 11), so the worker whose onmessage the page
      // is listening to is the most recent one made.
      const live = window.__workers[window.__workers.length - 1];
      live.dispatchEvent(new MessageEvent('message', { data: {
        type: 'scene-ops', id: 'stale-run', generation: 999,
        ops: JSON.stringify({ cmds: [{ cmd: 'box', idx: 77, canvas: 0 }] }),
      }}));
      return { before, after: window.__vpythonScene.dropped };
    });
    expect(probe.after).toBe(probe.before + 1);
    // ...and it never reached the front-end: idx 77 was never constructed.
    expect(await page.evaluate(() =>
      window.__vpythonScene.frontend._objs()[77] === undefined)).toBe(true);

    // Re-run: the scene is thrown away and the next generation is what the
    // kernel stamps from then on. (The generation tag still earns its keep even
    // though a vpython re-run now also discards the interpreter — the OLD
    // worker's last packages can still be sitting in the page's message queue
    // when the new scene comes up, and terminate() does not un-post them.)
    await page.evaluate(() => { window.__sceneOps.length = 0; });
    await page.locator('.run-it').first().click();
    await expect(async () => {
      const after = await page.evaluate(() =>
        window.__sceneOps.filter((g) => g !== 999));
      expect(after.length).toBeGreaterThan(0);
      expect(Math.max(...after)).toBe(2);
    }).toPass({ timeout: 180_000 });
    expect(await page.evaluate(() => window.__vpythonScene.generation)).toBe(2);
  });

  // --- Task 8: THE HEADLINE -------------------------------------------------
  // Everything above runs a program that ENDS. This one never does — it is the
  // shape every real VPython program has, and the whole reason for the worker:
  // on the main thread a `while True: rate(60)` loop owns the only thread, so
  // Stop is a button the page is too busy to notice (picup #108). Off-thread it
  // is one terminate() call.
  //
  // Three claims, and the middle one is the easy one to fake:
  //   1. it ANIMATES — pacing works, not merely "the program started";
  //   2. the page stays responsive while it runs;
  //   3. Stop actually kills it (and the scene stops moving, and the pacing
  //      clock is wound down rather than left pinging a dead worker).
  const ANIMATION = 'from vpython import *\n' +
                    'b = sphere()\n' +
                    'while True:\n' +
                    '    rate(60)\n' +
                    '    b.pos.x += 0.01\n';

  // The sphere, found by shape rather than by constructor identity: on this
  // scene it is the only object with a numeric `pos` (the canvas has `center`,
  // the two distant_lights have `direction`), so this does not depend on which
  // glow constructors happen to be global.
  function movingX(page) {
    return page.evaluate(() => {
      const objs = window.__vpythonScene.frontend._objs().filter(Boolean);
      const s = objs.find((o) => o && o.pos && typeof o.pos.x === 'number');
      return s ? s.pos.x : null;
    });
  }

  test('THE POINT: a rate() animation animates, the page stays responsive, and Stop kills it', async ({ page }) => {
    // Same budget as the other real-path specs: a cold Pyodide boot plus the
    // 3.5 MB wheel install dominates, and the toPass windows sit inside it.
    test.setTimeout(300_000);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // Two taps, installed before any page script runs.
    //
    // (a) The worker channel (the shared tap), so claim 3 can be checked on the
    //     WIRE: after Stop no further scene-ops may arrive. It also records what
    //     the page SENDS, which is what the two-clocks assertion below reads.
    // (b) The PACING CLOCK ITSELF, counting how many times its interval
    //     callback fires. (a) alone cannot see a leaked clock: sendSceneEvent
    //     no-ops once the worker is gone, so a clock left running emits nothing
    //     and "no more scene-ops" would only ever prove the WORKER is dead.
    //     Counting callback invocations survives worker death, which is the
    //     whole point. Matched on SCENE_PACE_MS (pyodide.js) — the tap is
    //     self-validating: the run asserts the counter moved, so if that
    //     constant ever changes this fails loudly instead of silently reading 0
    //     forever.
    await tapWorkerChannel(page);
    await page.addInitScript(() => {
      const SCENE_PACE_MS = 33;
      const realSetInterval = window.setInterval;
      window.__pacerTicks = 0;
      window.setInterval = function (fn, delay) {
        if (delay === SCENE_PACE_MS && typeof fn === 'function') {
          return realSetInterval.call(window, function () {
            window.__pacerTicks++;
            return fn.apply(this, arguments);
          }, delay);
        }
        return realSetInterval.apply(window, arguments);
      };
    });

    await runVPython(page, ANIMATION);

    // The scene comes up. GLOW IS LAZY, so the <canvas> element appearing is
    // the signal that objects actually reached the front-end.
    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length)).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // Claim 1: it MOVES. Sample the live glow object twice. Without the async
    // transform, `rate(60)` builds a coroutine nobody awaits: no flush, no
    // asyncio yield, the worker spins forever inside the loop and x never
    // changes. "The program is running" would still look true; this would not.
    let x0 = null;
    await expect(async () => {
      x0 = await movingX(page);
      expect(x0, 'no object with a position ever reached the scene').not.toBeNull();
    }).toPass({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    const x1 = await movingX(page);
    // 1.5 s of rate(60) at 0.01/frame is ~0.9 units; anything above noise proves
    // the loop is being paced and flushed rather than spinning or stalled.
    expect(Math.abs(x1 - x0),
      'the sphere never moved — rate() is not pacing/flushing the loop').toBeGreaterThan(0.05);

    // The pacing-clock tap is live. Asserted BEFORE it is used as evidence, so a
    // tap that silently stopped matching cannot make the post-Stop comparison
    // below a vacuous 0 === 0.
    expect(await page.evaluate(() => window.__pacerTicks),
      'the setInterval tap never saw the pacing clock — did SCENE_PACE_MS change?')
      .toBeGreaterThan(0);

    // Claim 2: the page is not the thing doing the work. A main-thread run of
    // this program would never answer at all.
    const t0 = Date.now();
    await page.evaluate(() => document.title);
    expect(Date.now() - t0, 'the page blocked while the animation ran').toBeLessThan(2000);

    // Baseline for the two-clocks measurement, taken at the start of the x1..x2
    // window below.
    const clocks0 = await page.evaluate(() =>
      ({ sends: window.__sceneEvents.length, ops: window.__sceneOps.length }));

    // Claim 3: Stop — and it has to be a stop, not a coincidence. Two more
    // samples first, because |x1-x0| alone is satisfied by an animation that ran
    // a handful of frames and then wedged, and a scene that froze BEFORE the
    // click passes the freeze check further down for free.
    //
    // x2 narrows the window to the last 1.5 s; the sample taken INSIDE the click
    // evaluate (atStop.x, below) is the one that actually closes it, because it
    // is read in the same synchronous turn as the Stop. The three together say:
    // the loop was still running at the instant we stopped it.
    //
    // The 0.05 threshold is deliberately far below the ~0.9 units 1.5 s of
    // rate(60) at 0.01/frame produces — it is a "not noise" bound, not a
    // throughput one. What keeps a barely-alive animation from passing is that
    // the SAME bound has to be cleared in each successive window, including the
    // one ending at the click.
    await page.waitForTimeout(1500);
    const x2 = await movingX(page);
    expect(Math.abs(x2 - x1),
      'the animation stalled before Stop — the freeze check below would prove nothing')
      .toBeGreaterThan(0.05);

    // THE TWO CLOCKS (Task 11). The pacer and the student's rate() loop can both
    // make the worker flush, and while the loop is running the pacer's handshake
    // is redundant: rate() triggers a render up to MAX_RENDERS a second from
    // inside the program. Measured before the pacer learned to back off: 91 host
    // messages against 254 packages over three seconds — a third of the traffic
    // on the hottest path in the system, buying nothing.
    //
    // Measured over the 1.5 s window just used for x1..x2, so this costs no extra
    // wall clock. `sends` is what the PAGE put on the wire; `ops` is what came
    // back.
    const clocks = await page.evaluate(() =>
      ({ sends: window.__sceneEvents.length, ops: window.__sceneOps.length }));
    const paceWindow = Math.floor(1500 / 33);        // ticks the pacer got in that window
    console.log('TWO CLOCKS over ~1.5 s of animation: sends=' +
      (clocks.sends - clocks0.sends) + ' ops=' + (clocks.ops - clocks0.ops) +
      ' (pacer ticks available: ' + paceWindow + ')');
    // The loop really is flushing on its own — otherwise "the pacer stayed
    // quiet" would just mean the scene was dead.
    expect(clocks.ops - clocks0.ops,
      'the program was not flushing on its own; the next assertion would be vacuous')
      .toBeGreaterThan(paceWindow);
    // ...and the pacer got out of its way. Before the fix this was one send per
    // tick (~45); a handful may still go out for a camera the test never moves.
    expect(clocks.sends - clocks0.sends,
      'the pacer is still sending a handshake per tick while rate() drives the loop')
      .toBeLessThan(paceWindow / 4);

    // The button is still up, because the program never ends.
    await expect(page.locator('.stop-it')).toBeVisible();

    // A known gap before the click, so the "still moving as the button went
    // down" assertion has a window to measure rather than however many
    // milliseconds the round trips above happened to take. 0.5 s of rate(60) at
    // 0.01/frame is ~0.3 units, six times the 0.05 noise bound.
    await page.waitForTimeout(500);

    // Clicked from page context rather than with the locator so the counters
    // are read in the SAME synchronous turn as the click. This matters: a
    // pacing clock that stopCode() forgot to cancel is still wound down ~500 ms
    // later by finishVPythonPacing()'s drain, so a baseline taken one round
    // trip after the click would already contain the leaked ticks and the leak
    // would be invisible. Reading them the instant stopCode() returns makes the
    // difference exact — 0 further ticks if it cancelled, ~15 if it did not.
    // The sphere's position is read in that same turn, BEFORE the click: a
    // sample at the click instant. Every other sample is one round trip old, so
    // an animation that wedged after x2 was taken would still satisfy the
    // freeze check below for free.
    const atStop = await page.evaluate(() => {
      const objs = window.__vpythonScene.frontend._objs().filter(Boolean);
      const s = objs.find((o) => o && o.pos && typeof o.pos.x === 'number');
      const x = s ? s.pos.x : null;
      document.querySelector('.stop-it').click();
      return { x: x, ticks: window.__pacerTicks, ops: window.__sceneOps.length };
    });
    expect(atStop.ops,
      'the scene-ops tap never saw a package — the comparison below would be 0 vs 0')
      .toBeGreaterThan(0);
    // Still moving as the button went down — not merely "moved at some point
    // during the run".
    console.log('MOTION x0=' + x0 + ' x1=' + x1 + ' x2=' + x2 + ' atStop=' + atStop.x);
    expect(Math.abs(atStop.x - x1),
      'the animation was not running at the moment Stop was clicked').toBeGreaterThan(0.05);
    expect(Math.abs(atStop.x - x2),
      'the animation wedged between the last sample and the click — the freeze ' +
      'check below would prove nothing').toBeGreaterThan(0.05);

    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '')).toContain('[stopped');
    }).toPass({ timeout: 30_000 });

    // ...and it is dead, not merely reported dead: the scene stays where it
    // froze (a stopped program keeps its picture — the student can still orbit
    // it), nothing more arrives on the wire, and the clock itself has stopped.
    const frozen = await movingX(page);
    await page.waitForTimeout(1500);
    expect(await movingX(page), 'the animation kept running after Stop').toBe(frozen);
    expect(await page.evaluate(() => window.__sceneOps.length),
      'scene-ops still arriving after Stop — the worker outlived terminate()').toBe(atStop.ops);
    expect(await page.evaluate(() => window.__pacerTicks),
      'the pacing clock is still ticking after Stop — stopVPythonPacer() did not run')
      .toBe(atStop.ticks);

    expect(pageErrors, 'uncaught page exception on the worker vpython path').toEqual([]);
  });

  // The case the test above cannot reach. ANIMATION's body is a single float
  // add, so its rate(60) always has most of the 16.7 ms period left to sleep —
  // the ordinary path. This body takes 50 ms, so EVERY call is already past its
  // deadline and the compensated rate() has no time left to wait. That branch
  // exists only because rate() now subtracts the body's cost, and the tempting
  // "optimisation" there is to return early: there is nothing to sleep for.
  //
  // What that would break is narrower than it looks, and the narrowness is the
  // reason this test is shaped the way it is. Flushing is SYNCHRONOUS —
  // _flush_if_due() postMessages from the worker without yielding — so a
  // non-yielding rate() still renders and the sphere still moves. Stop still
  // works too: it is worker.terminate() on the page side and needs nothing from
  // the worker thread. Motion and Stop therefore prove nothing here; a test
  // asserting only those passes against a build with the yield removed
  // (verified by doing exactly that).
  //
  // The half that does break is INBOUND. The host delivers browser events by
  // calling the transport's dispatch, and the worker only reaches its JS event
  // loop — where that queued message is waiting — when the running coroutine
  // gives up a turn. So the assertion with teeth is a scene.bind handler firing
  // DURING an over-period loop: mouse events reaching Python is what dies, in a
  // scene that otherwise looks perfectly healthy. Guards the unconditional
  // `await asyncio.sleep(0)` in vpython-jupyter's _async_rate.
  //
  // TO RE-PROVE IT BITES (the claim above is only worth what it can be checked
  // against). In the vpython-jupyter checkout, replace that await with
  //     if remaining <= 0.0:
  //         _last_return[0] = time.monotonic()
  //         return
  // then `VPYTHON_PURE_PYTHON=1 SETUPTOOLS_SCM_PRETEND_VERSION=7.6.5 python3 -m
  // build --wheel`, `bash scripts/sync-vpython-worker.sh` from trinket, and run
  // this spec: it fails on CLICKED after passing the movement and
  // responsiveness checks. `git checkout --` the file, rebuild, re-sync.
  // vpython-jupyter's test_rate_still_yields_when_user_code_overruns_the_period
  // fails on the same mutation and costs a second, so it is the cheaper guard;
  // this one is the guard that speaks in terms of what a student would see.
  const OVERRUN_ANIMATION = 'from vpython import *\n' +
                            'import time\n' +
                            'b = sphere()\n' +
                            'def hit(evt):\n' +
                            '    print("CLICKED")\n' +
                            'scene.bind("click", hit)\n' +
                            'while True:\n' +
                            '    rate(60)\n' +
                            '    end = time.time() + 0.05\n' +
                            '    while time.time() < end:\n' +
                            '        pass\n' +
                            '    b.pos.x += 0.05\n';

  test('a loop whose body overruns the rate() period still dispatches events, stays responsive and stops',
    async ({ page }) => {
    test.setTimeout(300_000);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await runVPython(page, OVERRUN_ANIMATION);

    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length)).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // The loop is running (~20 iterations/second at 0.05 units each). Necessary
    // but NOT sufficient — see the note above — so it is a precondition for the
    // click assertion rather than a claim in its own right.
    let x0 = null;
    await expect(async () => {
      x0 = await movingX(page);
      expect(x0, 'no object with a position ever reached the scene').not.toBeNull();
    }).toPass({ timeout: 60_000 });
    await page.waitForTimeout(2000);
    expect(Math.abs((await movingX(page)) - x0),
      'the over-period loop never even started animating — this spec would ' +
      'test nothing').toBeGreaterThan(0.05);

    // The page is still not the thing doing the work, and this body hogs the
    // worker far harder than ANIMATION's does.
    const t0 = Date.now();
    await page.evaluate(() => document.title);
    expect(Date.now() - t0, 'the page blocked while the over-period loop ran')
      .toBeLessThan(2000);

    // THE ASSERTION WITH TEETH. .last() for the same reason as the Task 9 spec:
    // glow's 2D overlay canvas sits on top of the WebGL one and carries the
    // mouse handlers.
    await page.locator('#vpython-scene canvas').last().click({ position: { x: 100, y: 100 } });
    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '')).toContain('CLICKED');
    }).toPass({ timeout: 30_000 });

    // ...and Stop still kills it.
    await expect(page.locator('.stop-it')).toBeVisible();
    await page.locator('.stop-it').first().click();
    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '')).toContain('[stopped');
    }).toPass({ timeout: 30_000 });
    const frozen = await movingX(page);
    await page.waitForTimeout(1500);
    expect(await movingX(page), 'the animation kept running after Stop').toBe(frozen);

    expect(pageErrors, 'uncaught page exception on the worker vpython path').toEqual([]);
  });

  // --- Task 9: mouse events -------------------------------------------------
  // Everything above is one-way: Python builds objects, the page draws them.
  // This is the return path — the browser's mouse reaching a Python callback.
  //
  // The program deliberately ENDS. That is the hard case, and the normal one:
  // `scene.bind(...)` then fall off the bottom of the file is what every
  // interactive VPython example looks like, and by the time the student clicks,
  // the run-scoped pacing clock (Task 7) has long since wound down. Nothing is
  // polling; the click itself has to carry the message. If the front-end only
  // queued events for a tick that never comes, this test hangs.
  const CLICK_PROGRAM = 'from vpython import *\n' +
                        's = sphere()\n' +
                        'def hit(evt):\n' +
                        '    print("CLICKED", evt.pos)\n' +
                        'scene.bind("click", hit)\n';

  test('a scene.bind click handler fires in the worker', async ({ page }) => {
    test.setTimeout(300_000);   // cold Pyodide boot + 3.5 MB wheel install
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // Two taps.
    //
    // (a) The worker channel (the shared tap), so "the clock has stopped" can be
    //     asserted on the WIRE before the click rather than assumed from a sleep.
    // (b) The front-end INSTANCE, to check that the page NOTIFIES it when the
    //     pacer stops instead of leaving it to infer that from how long ago the
    //     last tick was. The inference has a ~100 ms window after the final tick
    //     in which a click is queued for a tick that never comes; that race is
    //     not reproducible from a browser (the window closes before a test can
    //     see it opened), so what is asserted here is the notification the fix
    //     is made of. The precise timing is pinned by the unit suite.
    //
    //     Tapped through `window.__vpythonScene.frontend`, which pyodide.js
    //     assigns the moment it builds the front-end — earlier than any tick, so
    //     earlier than any stop. NOT through `window.createGlowFrontend`: that
    //     name comes from a top-level `function` declaration in a classic
    //     script, which redefines the global property as a data property and
    //     silently discards any accessor installed beforehand.
    await tapWorkerChannel(page);
    await page.addInitScript(() => {
      window.__pacingStopped = 0;
      let scene = null;
      Object.defineProperty(window, '__vpythonScene', {
        configurable: true,
        get() { return scene; },
        set(v) {
          scene = v;
          let fe = null;
          Object.defineProperty(scene, 'frontend', {
            configurable: true,
            get() { return fe; },
            set(f) {
              fe = f;
              if (f && typeof f.pacingStopped === 'function' && !f.__tapped) {
                const real = f.pacingStopped;
                f.__tapped = true;
                f.pacingStopped = function () {
                  window.__pacingStopped++;
                  return real.apply(f, arguments);
                };
              }
            },
          });
        },
      });
    });

    await runVPython(page, CLICK_PROGRAM);

    // GLOW IS LAZY: a canvas with no objects renders no <canvas> element, so the
    // element appearing is the signal that the sphere really reached the scene.
    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length)).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });
    expect(await page.evaluate(() =>
      window.__vpythonScene.frontend._objs().filter(Boolean).length)).toBeGreaterThan(1);

    // The run has settled and the pacer has drained: the stream is quiet. This
    // is what makes the click below a real test of event-driven flushing — with
    // a clock still running, a merely-queued event would go out anyway.
    await expect(async () => {
      const before = await page.evaluate(() => window.__sceneOps.length);
      await page.waitForTimeout(1000);
      expect(await page.evaluate(() => window.__sceneOps.length),
        'the pacing clock never wound down; this spec would not test what it claims')
        .toBe(before);
    }).toPass({ timeout: 60_000 });

    // ...and the front-end was TOLD, not left to work it out from a timer.
    expect(await page.evaluate(() => window.__pacingStopped),
      'stopVPythonPacer() never told the front-end its clock was gone')
      .toBeGreaterThan(0);

    // .last(), not .first(): glow stacks a 2D overlay canvas (labels, captions)
    // on top of the WebGL one and binds the mouse handlers through it, so the
    // first canvas in the DOM is the one a real click never reaches.
    await page.locator('#vpython-scene canvas').last().click({ position: { x: 100, y: 100 } });

    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '')).toContain('CLICKED');
    }).toPass({ timeout: 30_000 });

    // ...and the callback got a real event object, not an empty one: evt.pos
    // came back through list_to_vec as a vector, which prints as <x, y, z>.
    const out = await page.evaluate(() =>
      document.querySelector('#console-output')?.innerText || '');
    expect(out, 'the handler fired but evt.pos was not a vector').toMatch(/CLICKED\s+<[-\d.]+,/);

    expect(pageErrors, 'uncaught page exception on the worker vpython path').toEqual([]);
  });

  // --- Task 10: graphs ------------------------------------------------------
  // Everything above draws 3D objects onto the WebGL canvas. Graphs are a
  // separate half of glow with its own machinery, its own DOM, and its own
  // corner of the wire protocol, and it is the half a physics course actually
  // uses most (`gcurve` of energy vs. time is the standard M&I exercise).
  //
  // Three things here are specific to graphs and cannot be inferred from the
  // sphere specs:
  //
  //   1. THE SCALAR-`size` QUIRK. `size` is a vector everywhere in VPython —
  //      handle_cmds runs it through o2vec3 — EXCEPT on gcurve/gdots, where it
  //      is a dot diameter. The ported handle_cmds carries upstream's branch for
  //      that; without it a named `size=` reaches glow as vec(undefined,…) and
  //      the dots vanish (or worse, NaN propagates into the autoscale). It only
  //      fires when the student NAMES size in the constructor — which is why
  //      `gdots(size=…)` is in this program and not just a bare gcurve.
  //
  //   2. THE `graph` CFG KEY. gcurve/gdots attach to a plot by an idx that
  //      handle_cmds must resolve through the object registry, exactly like
  //      `canvas`. If that mapping is missed, glow receives the integer 4 as a
  //      graph and draws into a fresh default plot instead of the student's.
  //
  //   3. A DIFFERENT DOM. Measured, not assumed: glow builds
  //      `#vpython-scene > div#graph0.glowscript-graph`, holding `canvas.base`
  //      (the plot) and `canvas.overlay` — 2D contexts, not WebGL. Note this
  //      program creates no 3D objects at all, so GLOW'S LAZINESS means there is
  //      no 3D canvas on the page: the only `#vpython-scene canvas` elements
  //      here belong to the graph. Hence the `.glowscript-graph` in the
  //      selectors below — a bare `#vpython-scene canvas` would pass on a page
  //      where the graph never appeared and something else drew a scene.
  const GRAPH_PROGRAM = 'from vpython import *\n' +
                        'gd = graph(title="Task 10", xtitle="x", ytitle="y")\n' +
                        'c = gcurve(graph=gd, color=color.blue)\n' +
                        'd = gdots(graph=gd, color=color.red, size=8)\n' +
                        'for i in range(50):\n' +
                        '    c.plot(i*0.1, i*i*0.01)\n' +
                        'd.plot(2.0, 2.0)\n' +
                        'd.plot(3.0, 4.0)\n';

  test('gcurve/gdots plot through the worker onto a real graph canvas', async ({ page }) => {
    test.setTimeout(300_000);   // cold Pyodide boot + 3.5 MB wheel install
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    // The constructor packages, straight off the wire. The scalar-`size` claim
    // is only worth anything if `size` really arrives as a bare number — if the
    // Python side ever started sending `[8,8,8]` the front-end branch would be
    // dead code and this spec would be asserting nothing.
    await page.addInitScript(() => {
      const RealWorker = window.Worker;
      window.__graphCmds = [];
      window.Worker = function (url, options) {
        const w = new RealWorker(url, options);
        w.addEventListener('message', (e) => {
          if (!(e && e.data && e.data.type === 'scene-ops')) return;
          let pkg; try { pkg = JSON.parse(e.data.ops); } catch (err) { return; }
          for (const c of (pkg.cmds || [])) {
            if (['graph', 'gcurve', 'gdots'].includes(c.cmd)) window.__graphCmds.push(c);
          }
        });
        return w;
      };
      window.Worker.prototype = RealWorker.prototype;
    });

    await runVPython(page, GRAPH_PROGRAM);

    // The plot canvas appearing is the "the graph machinery really ran" signal.
    await expect(async () => {
      expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
      expect(await page.evaluate(() => document.querySelectorAll(
        '#vpython-scene .glowscript-graph canvas.base').length)).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // glow redraws graphs on its own schedule; give the plotted points a frame
    // or two to reach the canvas before the pixels are counted.
    await page.waitForTimeout(3000);

    const r = await page.evaluate(() => {
      const objs = window.__vpythonScene.frontend._objs();
      const graphObj = objs[4], curve = objs[5], dots = objs[6];

      // The plot canvas is a 2D context, so unlike the WebGL canary this can be
      // read straight — no rAF, no preserveDrawingBuffer.
      const base = document.querySelector('#vpython-scene .glowscript-graph canvas.base');
      const px = base.getContext('2d').getImageData(0, 0, base.width, base.height).data;
      let blue = 0, red = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        if (px[i + 2] > 100 && px[i] < 100 && px[i + 1] < 100) blue++;   // the gcurve
        if (px[i] > 100 && px[i + 1] < 100 && px[i + 2] < 100) red++;    // the gdots
      }

      // Autoscale is downstream of the data actually landing in glow: an empty
      // graph draws a 0..1 axis, so any tick well above 1 can only come from the
      // student's y values (which run to 24.01).
      const ticks = [...document.querySelectorAll('#vpython-scene .glowscript-graph .tickLabel')]
        .map((e) => parseFloat(e.textContent)).filter((n) => !isNaN(n));

      return {
        wireCmds: window.__graphCmds,
        graphCtor: graphObj && graphObj.constructor && graphObj.constructor.name,
        // `__graph` holds what handle_cmds put in cfg.graph. The identity check
        // is the point: the integer 4 off the wire had to become THIS object.
        curveAttachedToGraph: !!curve && curve.__graph === graphObj,
        dotsAttachedToGraph: !!dots && dots.__graph === graphObj,
        curveType: curve && curve.__realtype,
        dotsType: dots && dots.__realtype,
        curveLen: curve && curve.__data && curve.__data.length,
        curveLast: curve && curve.__data && curve.__data[curve.__data.length - 1],
        dotsLen: dots && dots.__data && dots.__data.length,
        // Values rather than types — see the honest account at the assertion.
        dotsSize: dots && dots.size,
        dotsRadius: dots && dots.__radius,
        // …and the neighbouring vector attribute still WAS converted, so the
        // branch is narrow rather than "graph objects skip o2vec3".
        dotsColorIsVec: !!(dots && dots.color && typeof dots.color.x === 'number'),
        dotsColor: dots && dots.color ? [dots.color.x, dots.color.y, dots.color.z] : null,
        blue, red, maxTick: ticks.length ? Math.max(...ticks) : null,
      };
    });

    // 1. The wire really carries a scalar. (Historical note: gobj.setup used to
    //    write `_size` directly, silently sending the default 6 instead of the
    //    student's 8 — fixed upstream by vpython-jupyter #290, which the pinned
    //    wheel carries, so the value assertions below became real.) What matters
    //    here is the TYPE: a bare number, not a triple.
    const dotsCmd = r.wireCmds.find((c) => c.cmd === 'gdots');
    expect(dotsCmd, 'no gdots constructor reached the page').toBeTruthy();
    expect(typeof dotsCmd.size,
      'gdots no longer sends a scalar size — the front-end branch is now dead code').toBe('number');

    // 2. …and the front-end left it a scalar instead of running it through
    //    o2vec3. READ THIS BEFORE TRUSTING THE NEXT TWO LINES: they are weaker
    //    than they look, and the mutation run says so.
    //
    //    Deleting the gcurve/gdots branch was tried. glow 3.2.3's `vec`
    //    VALIDATES its arguments, so `o2vec3(6)` — i.e.
    //    `vec(undefined, undefined, undefined)` — throws `vector(non-vector) is
    //    an error.` That throw aborts the rest of the cmds package: gdots is
    //    never constructed, the gcurve's plot() packages abort with it, and
    //    glow's graph (lazy, like the 3D canvas) renders no `.glowscript-graph`
    //    div at all. The mutant therefore dies at the CANVAS GATE above, three
    //    assertions before either line below is reached. The front-end catches
    //    the throw and writes it to the trinket console, so it never surfaces
    //    as a pageerror or a console.error either.
    //
    //    And these two cannot fully discriminate anyway: 3 and 6 are glow's
    //    DEFAULT radius/size. Because of the upstream dead-`_size` bug noted at
    //    (1), the wire USED to carry the default 6 no matter what the student
    //    asked for, making these two lines unable to separate "branch fired"
    //    from "size dropped on the floor". vpython-jupyter #290 (>= 7.6.6.dev0,
    //    the pinned wheel) fixed the dead-`_size` bug: the wire now carries the
    //    student's actual `size=8`, so 8/4 are NON-default values and these
    //    assertions are real discriminators at last — a dropped size would give
    //    the 6/3 defaults and fail here.
    //
    //    They are kept as values rather than `typeof` because a future glow
    //    whose `vec` coerces instead of throwing would let a vec through to
    //    `__radius = size/2` as NaN, and `typeof NaN` is 'number' — the type
    //    form would pass.
    expect(r.dotsRadius,
      'gdots size went through o2vec3 — the gcurve/gdots branch in handle_cmds did not fire')
      .toBe(4);
    expect(r.dotsSize).toBe(8);
    expect(r.dotsColorIsVec, 'gdots color was not converted to a glow vector').toBe(true);
    expect(r.dotsColor).toEqual([1, 0, 0]);

    // 3. The `graph` cfg key resolved through the registry, both times.
    expect(r.graphCtor).toBe('graph');
    expect(r.curveAttachedToGraph,
      'gcurve was not attached to the student\'s graph — the `graph` idx was not mapped').toBe(true);
    expect(r.dotsAttachedToGraph).toBe(true);
    expect(r.curveType).toBe('lines');
    expect(r.dotsType).toBe('points');

    // 4. Every plot() call reached glow, with its values intact.
    expect(r.curveLen).toBe(50);
    expect(r.curveLast).toEqual([4.9, 24.01]);
    expect(r.dotsLen).toBe(2);

    // 5. …and it rasterised: a blue curve and red dots on the plot canvas, with
    //    the axis scaled to the data rather than to an empty default range.
    //    The tick bound is deliberately loose — the claim is "not the 0..1 axis
    //    of an empty graph", not "glow rounds the top of the range to 25".
    expect(r.blue, 'the gcurve never reached the plot canvas').toBeGreaterThan(100);
    expect(r.red, 'the gdots never reached the plot canvas').toBeGreaterThan(0);
    expect(r.maxTick, 'the axis is still on its empty-graph default range').toBeGreaterThan(5);

    expect(pageErrors, 'uncaught page exception on the worker vpython path').toEqual([]);
    expect(consoleErrors, 'the page logged an error while plotting').toEqual([]);
  });

  // --- Task 11: lifecycle, and deferrals that are loud ----------------------
  //
  // Everything above runs a program ONCE. A student runs the same program over
  // and over, changing a number each time, and that is where the scene lifecycle
  // is actually decided.
  //
  // THE RE-RUN CONTRACT (spec V7a). A vpython run starts from a fresh
  // interpreter — worker-client discardWorker(), called from runInWorker.
  //
  // That is this host's semantics: Jupyter/Colab/VS Code keep a kernel alive
  // between runs, Web VPython and trinket do not, and Run here means "run this
  // program from the top". vpython's design makes it unavoidable besides — the
  // package builds `scene = canvas()` exactly once, at `import vpython`, so on a
  // warm worker run 2's objects attach to run 1's canvas, which the page
  // destroyed when it bumped the generation. Measured before the fix: run 2
  // reported generation 2 and drew NOTHING.
  //
  // Two specs, because a student meets the contract two ways: Run after a
  // program ended, and Run DURING one that never will.

  test('a re-run replaces the scene instead of stacking a second one', async ({ page }) => {
    // Two cold runs now that each vpython run boots its own interpreter.
    test.setTimeout(420_000);
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await tapWorkerChannel(page);
    await runVPython(page, STATIC_SPHERE);

    // GLOW IS LAZY: the <canvas> element appearing is the signal that objects
    // reached the front-end.
    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length)).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    const run1 = await page.evaluate(() => {
      const objs = window.__vpythonScene.frontend._objs().filter(Boolean);
      return {
        objs: objs.length,
        canvases: objs.filter((o) => o && o.constructor && o.constructor.name === 'canvas').length,
        // Two per scene: glow stacks a 2D overlay over the WebGL canvas.
        dom: document.querySelectorAll('#vpython-scene canvas').length,
        gen: window.__vpythonScene.generation,
      };
    });
    expect(run1.canvases, 'run 1 did not produce exactly one canvas').toBe(1);
    expect(run1.dom).toBeGreaterThan(0);

    // Re-run — and on the way through, prove the ORDER inside resetVPythonScene.
    // It drops the front-end reference BEFORE stopping the pacer, because
    // stopVPythonPacer() tells the front-end its clock has gone and the
    // front-end answers that by FLUSHING its queue. Those queued events name
    // idxs from the scene being torn down, and Python's registry would resolve
    // them against whatever the next generation puts at those idxs.
    //
    // With an empty queue the wrong order is silent, so the queue is loaded
    // first: bind a click through the front-end (capturing the handler glow is
    // given), tick so the front-end believes the host's clock is live — which is
    // what makes an event QUEUE rather than flush itself — then fire the handler
    // and hit Run. All in ONE evaluate: startRun() is synchronous from
    // resetVPythonScene() through to the worker being discarded, so nothing can
    // interleave, and the click cannot have gone out for any innocent reason.
    const armed = await page.evaluate(() => {
      const fe = window.__vpythonScene.frontend;
      const cvs = fe._objs()[0];
      let handler = null;
      const realBind = cvs.bind;
      cvs.bind = function (types, fn) { handler = fn; return realBind.call(cvs, types, fn); };
      fe.handle({ attrs: ['m0Gclick'] });     // method code G is bind, on idx 0
      cvs.bind = realBind;
      if (typeof handler !== 'function') return { bound: false };

      fe.tick();                              // ...so the clock looks live
      window.__sceneEvents.length = 0;        // baseline: nothing sent from here on
      handler({ type: 'click', canvas: cvs, pos: window.vec(1, 2, 3),
                press: false, release: true, which: 1 });
      const queued = window.__sceneEvents.length === 0;
      document.querySelector('.run-it').click();
      return { bound: true, queued };
    });
    expect(armed.bound, 'could not bind a handler on the live canvas').toBe(true);
    expect(armed.queued,
      'the click flushed itself instead of queueing — this spec cannot see the leak').toBe(true);

    // Run 2 draws. This is the whole point: before the fresh-interpreter change
    // it did not.
    await expect(async () => {
      expect(await page.evaluate(() => window.__vpythonScene.generation)).toBe(2);
      expect(await page.evaluate(() => {
        const fe = window.__vpythonScene.frontend;
        return fe ? fe._objs().filter(Boolean).length : 0;
      }), 'run 2 rendered nothing — its objects attached to run 1\'s canvas').toBeGreaterThan(1);
    }).toPass({ timeout: 180_000 });

    const run2 = await page.evaluate(() => {
      const objs = window.__vpythonScene.frontend._objs().filter(Boolean);
      const red = objs.find((o) => o && o.color && o.color.x === 1 && o.color.y === 0 && o.color.z === 0);
      return {
        objs: objs.length,
        canvases: objs.filter((o) => o && o.constructor && o.constructor.name === 'canvas').length,
        dom: document.querySelectorAll('#vpython-scene canvas').length,
        red: !!red,
      };
    });

    // ONE scene, not two. Both halves matter: a second canvas OBJECT would mean
    // the registry accumulated across runs, and extra canvas ELEMENTS would mean
    // the old scene's DOM survived underneath the new one.
    expect(run2.canvases, 'a second canvas is stacked on the first').toBe(1);
    expect(run2.dom, 'the previous run\'s canvas elements are still on the page').toBe(run1.dom);
    expect(run2.objs, 'the object registry accumulated across runs').toBe(run1.objs);
    expect(run2.red, 'run 2 drew no sphere of its own').toBe(true);

    // ...and nothing from the dying generation escaped on the way there.
    const leaked = await page.evaluate(() =>
      window.__sceneEvents.filter((e) => e.indexOf('"click"') !== -1));
    expect(leaked,
      'a queued event from the torn-down scene went out — resetVPythonScene ' +
      'stopped the pacer before dropping the front-end').toEqual([]);

    expect(pageErrors, 'uncaught page exception on the worker vpython path').toEqual([]);
  });

  test('Run during a live animation restarts it', async ({ page }) => {
    // THE SHAPE THE FEATURE EXISTS FOR. A VPython program is
    // `while True: rate(60)` — it never ends — and the student's loop is: change
    // a number, press Run. The spec above only covers Run after a program has
    // finished, which a real animation never does.
    //
    // On the main-thread bridge that click restarts the animation (cooperative
    // cancel at the next rate(), then re-run). Off-thread there is nothing to
    // cancel cooperatively, so the restart is the discard the next run was going
    // to do anyway: terminate, settle, re-run. Without it Run is simply inert
    // until the student thinks to press Stop first — a behaviour difference
    // between the two runtimes, on the commonest interaction there is.
    test.setTimeout(420_000);   // two cold interpreters
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await tapWorkerChannel(page);
    await runVPython(page, ANIMATION);

    await expect(async () => {
      expect(await page.evaluate(() =>
        document.querySelectorAll('#vpython-scene canvas').length)).toBeGreaterThan(0);
    }).toPass({ timeout: 180_000 });

    // Let it run far enough that a restart is unmistakable. `b.pos.x` starts at
    // 0 and climbs 0.01 a frame, so waiting for 2.0 units means a fresh
    // interpreter's sphere cannot be confused with this one's — and it also
    // proves the animation was genuinely LIVE at the moment Run was clicked,
    // which is the whole premise of the test.
    let preRestart = null;
    await expect(async () => {
      preRestart = await movingX(page);
      expect(preRestart, 'the animation never got going').toBeGreaterThan(2.0);
    }).toPass({ timeout: 120_000 });
    expect(await page.evaluate(() => window.__vpythonScene.generation)).toBe(1);
    await expect(page.locator('.stop-it')).toBeVisible();   // still running

    await page.locator('.run-it').first().click();

    // The first sample of the NEW scene. Read generation and position together,
    // so the position cannot belong to a scene the counter has already left.
    let xAfter = null;
    await expect(async () => {
      const s = await page.evaluate(() => {
        const fe = window.__vpythonScene.frontend;
        const objs = fe ? fe._objs().filter(Boolean) : [];
        const o = objs.find((x) => x && x.pos && typeof x.pos.x === 'number');
        return { gen: window.__vpythonScene.generation, x: o ? o.pos.x : null };
      });
      expect(s.gen, 'Run did nothing — the click was swallowed mid-run').toBe(2);
      expect(s.x, 'the restarted run drew no sphere').not.toBeNull();
      xAfter = s.x;
    }).toPass({ timeout: 180_000 });

    // It started OVER, from a fresh interpreter: had the namespace survived, `b`
    // would still be where run 1 left it and the count would carry on climbing
    // from there.
    expect(xAfter, 'the restarted animation resumed instead of starting over')
      .toBeLessThan(preRestart / 2);

    // ...and it is animating, not merely drawn: a restart that produced a frozen
    // scene would satisfy everything above.
    const a = await movingX(page);
    await page.waitForTimeout(1500);
    expect(Math.abs(await movingX(page) - a),
      'the restarted scene is not moving').toBeGreaterThan(0.05);

    // Still a run in flight (this program never ends), and the wire agrees the
    // live scene is generation 2.
    await expect(page.locator('.stop-it')).toBeVisible();
    const gens = await page.evaluate(() => window.__sceneOps.slice());
    expect(Math.max(...gens)).toBe(2);

    expect(pageErrors, 'uncaught page exception on the worker vpython path').toEqual([]);
  });

  // LOUD DEFERRALS (spec V5). scene.pause() cannot work in a worker: it spins
  // the one and only thread waiting for a browser reply that has to arrive on
  // that same thread. The failure mode we are ruling out is not "it does not
  // work" — it is "the tab appears to hang and the student is told nothing".
  //
  // The message is vpython/trinket_worker.py's _DEFER, applied to
  // `_vp.canvas.pause`. Asserted in two halves so the em dash between them is
  // not part of the contract.
  const PAUSE_PROGRAM = 'from vpython import *\n' +
                        'sphere()\n' +
                        'scene.pause()\n';

  test('scene.pause() reports the deferral clearly instead of hanging', async ({ page }) => {
    test.setTimeout(300_000);   // cold Pyodide boot + 3.5 MB wheel install

    await runVPython(page, PAUSE_PROGRAM);

    await expect(async () => {
      const out = await page.evaluate(() =>
        document.querySelector('#console-output')?.innerText || '');
      expect(out, 'the deferral never reached the console').toContain(
        'scene.pause is not supported in the worker runtime yet');
      expect(out).toContain('run without the workerVPython flag to use it');
    }).toPass({ timeout: 180_000 });

    // ...and the run SETTLED. A deferral that raised but left the page thinking
    // a program was still running would be the same hang with a message on top:
    // the Stop button stays up, the toolbar stays in its running state, and the
    // student's next Run is fighting the last one.
    await expect(page.locator('.stop-it')).toBeHidden({ timeout: 30_000 });

    // The sphere on the line before still drew: the program ran up to the
    // deferral rather than the whole run being thrown away.
    expect(await page.evaluate(() =>
      window.__vpythonScene.frontend
        ? window.__vpythonScene.frontend._objs().filter(Boolean).length : 0),
      'nothing was drawn before the deferral').toBeGreaterThan(1);
  });

  // The console-reset message must not be a LIE. Two sites say "console session
  // reset" when the worker interpreter is discarded — a VPython Run, and Stop.
  // Both are correct only when the REPL is in that same worker, and it usually
  // is NOT: the REPL follows `workerRuntime`, while a VPython run reaches the
  // worker under `workerVPython`. In the workerVPython-only config the console
  // session lives in the page's own pyodide, which terminate() never touches.
  //
  // This dev stack runs both flags, so the spec MAKES the single-flag config in
  // the page: replUsesWorker() reads window.trinket.config at CALL time, so
  // setting workerRuntime false before the Run is exactly the deploy shape. That
  // is also why this needs no second stack — the earlier claim that it did was
  // wrong.
  const CONSOLE_RESET = 'console session reset';

  test('with workerRuntime off, neither a VPython Run nor Stop claims to reset the console',
       async ({ page }) => {
    test.setTimeout(300_000);   // two cold Pyodide boots (page REPL + worker) plus the wheel

    const consoleText = () => page.evaluate(() =>
      document.querySelector('#console-output')?.innerText || '');

    await skipUnlessWorkerVPython(page);        // leaves us on /embed/python3
    await expect(page.locator('.ace_editor').first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => { window.trinket.config.workerRuntime = false; });

    // Arm the REPL — `replActive` is the precondition both messages are gated
    // on, so without this the spec would pass for the wrong reason. The banner
    // is the page's own Pyodide booting, which is the whole point: this session
    // is NOT in the worker.
    await page.evaluate(() => (window.jQuery || window.$)(document).trigger('trinket.code.console'));
    await expect(async () => {
      expect(await consoleText(), 'the page REPL never armed').toContain('on Pyodide');
    }).toPass({ timeout: 180_000 });

    const runProgram = async (src) => {
      await page.evaluate((code) => {
        document.querySelector('.ace_editor').env.editor.setValue(code, 1);
      }, src);
      await page.locator('.run-it').first().click();
    };

    const sceneUp = async () => {
      await expect(async () => {
        expect(await page.evaluate(() =>
          document.querySelectorAll('#vpython-scene canvas').length)).toBeGreaterThan(0);
      }).toPass({ timeout: 180_000 });
    };

    // Run 1 gives the page a live worker interpreter...
    await runProgram(STATIC_SPHERE);
    await sceneUp();

    // ...so run 2 is the one that DISCARDS one, which is what the Run-path
    // message is gated on (`hadInterpreter`). An animation, so Stop has
    // something to kill below.
    await runProgram(ANIMATION);
    await expect(page.locator('.stop-it')).toBeVisible({ timeout: 180_000 });
    await sceneUp();

    expect(await consoleText(),
      'the Run told the student their console session was reset — it was not, ' +
      'the REPL is on the page under workerRuntime:false').not.toContain(CONSOLE_RESET);

    // Stop discards the same interpreter and has the same duty of honesty.
    await page.locator('.stop-it').first().click();
    await expect(async () => {
      expect(await consoleText(), 'Stop said nothing at all').toContain('[stopped');
    }).toPass({ timeout: 60_000 });

    expect(await consoleText(),
      'Stop told the student their console session was reset — it was not')
      .not.toContain(CONSOLE_RESET);

    // ...and the student can still TYPE. Absence of a false line is only half
    // the contract: resetOutput() kills the armed prompt at the start of every
    // run, and this Stop is the only thing that brings one back. Without it the
    // console is dead for the rest of the session — the Console menu entry is
    // `if (!replActive) startRepl()` and `replActive` is never cleared, so
    // re-selecting it does nothing and only a reload recovers.
    await expect(page.locator('.jqconsole-prompt').first(),
      'Stop left the surviving page REPL with no prompt — the console is now dead')
      .toBeVisible({ timeout: 60_000 });
  });

  // The OTHER direction of the console/scene relationship, and the one that is
  // the point of having a REPL beside a 3D canvas: a typed statement must be
  // able to CHANGE what is on screen.
  //
  // It could not. The transport is request/reply — it flushes only when the page
  // pings it — and the clock that pings belongs to the RUN, which has ended and
  // drained. `pushRepl()` posts a plain `run` message and nothing pings
  // afterwards, so `ball.color = color.blue` executed in the worker, buffered,
  // and sat there until some unrelated browser event happened to flush it:
  // indefinitely, and invisibly, for a scene nobody touches.
  //
  // Needs BOTH flags — the REPL follows `workerRuntime`, so only then do the
  // console and the VPython run share one interpreter and the name `ball` mean
  // anything at the prompt.
  test('a console statement redraws the scene after the program has ended', async ({ page }) => {
    test.setTimeout(300_000);

    await runVPython(page, STATIC_SPHERE);
    const bothFlags = await page.evaluate(() =>
      !!(window.trinket && window.trinket.config && window.trinket.config.workerRuntime));
    test.skip(!bothFlags, 'SKIP: needs features.workerRuntime as well — with ' +
      'workerVPython alone the REPL runs on the page and cannot see the ' +
      "worker's `ball` at all.");

    const sphereColor = () => page.evaluate(() => {
      const fe = window.__vpythonScene.frontend;
      if (!fe) return null;
      // The sphere is the only object carrying a saturated primary; the canvas
      // background is black and the two default lights are greys.
      const o = fe._objs().find((x) => x && x.radius !== undefined && x.color);
      return o ? [o.color.x, o.color.y, o.color.z] : null;
    });

    await expect(async () => {
      expect(await sphereColor()).toEqual([1, 0, 0]);
    }).toPass({ timeout: 180_000 });

    // The run has to be genuinely OVER, clock and all: that is the state the bug
    // lives in. `.stop-it` hidden says the program finished; the wait covers
    // SCENE_DRAIN_MS (500 ms), after which stopVPythonPacer() has run and
    // nothing is asking the worker for anything. A real timeout, not a poll —
    // what is being waited for is the ABSENCE of further activity.
    await expect(page.locator('.stop-it')).toBeHidden({ timeout: 60_000 });
    await page.waitForTimeout(2000);

    // Open the console. Deliberately AFTER the run: `replActive` is a latch that
    // resetOutput() outlives, so a prompt armed before a Run does not survive it
    // (a pre-existing bug on every deploy, recorded in the deploy guide) — the
    // first arm has to come after.
    await page.evaluate(() => $(document).trigger('trinket.code.console'));
    await expect(page.locator('.jqconsole-prompt').first()).toBeVisible({ timeout: 90_000 });

    // Typing lands in the console, not on the canvas: no mouse or key event
    // reaches the scene, so nothing but the fix can flush this statement.
    await page.locator('#console-output').click();
    await page.keyboard.type('ball.color = color.blue');
    await page.keyboard.press('Enter');

    await expect(async () => {
      expect(await sphereColor(),
        'the statement ran in the worker but never reached the scene').toEqual([0, 0, 1]);
    }).toPass({ timeout: 60_000 });
  });
});

// #321: a program pasted from Web VPython starts with its version header. The
// main thread comments that line out before running (runVpython); the worker
// path did not, so the program died at line 1 with a SyntaxError.
test.describe('Worker VPython: the "Web VPython 3.2" header (#321)', () => {
  const consoleText = (page) => page.evaluate(() =>
    document.querySelector('#console-output')?.innerText || '');

  test('a program that starts with the header runs on the worker', async ({ page }) => {
    test.setTimeout(300_000);
    await runVPython(page, 'Web VPython 3.2\nfrom vpython import *\nsphere()\nprint("FINI")\n');

    await expect.poll(() => consoleText(page), { timeout: 180_000 })
      .toMatch(/FINI|Error/);
    const out = await consoleText(page);
    expect(out).not.toContain('SyntaxError');
    expect(out).toContain('FINI');
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
  });

  // The main thread has always handled the header; it now shares the worker's
  // helper, so pin it there too. ?runtime=main wins over workerVPython.
  test('the main thread still runs a program that starts with the header', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto('/embed/python3?runtime=main');
    await expect(page.locator('.ace_editor').first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate((code) => {
      document.querySelector('.ace_editor').env.editor.setValue(code, 1);
    }, 'Web VPython 3.2\nfrom vpython import *\nsphere()\nprint("FINI")\n');
    await page.locator('.run-it').first().click();

    await expect.poll(() => consoleText(page), { timeout: 180_000 }).toMatch(/FINI|Error/);
    const out = await consoleText(page);
    expect(out).not.toContain('SyntaxError');
    expect(out).toContain('FINI');
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('main');
  });

  test('the header keeps its line, so an error is reported on the line it is on', async ({ page }) => {
    test.setTimeout(300_000);
    await runVPython(page, 'Web VPython 3.2\nfrom vpython import *\nundefined_name_on_line_3\n');

    await expect.poll(() => consoleText(page), { timeout: 180_000 })
      .toMatch(/NameError|SyntaxError/);
    const out = await consoleText(page);
    expect(out).not.toContain('SyntaxError');
    expect(out).toContain('NameError');
    expect(out).toMatch(/line 3\b/);
    expect(await page.evaluate(() => window.__trinketRuntime)).toBe('worker');
  });
});
