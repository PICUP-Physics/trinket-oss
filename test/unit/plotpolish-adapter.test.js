'use strict';
// The plot-style adapter, executed rather than read.
//
// This exists because a commit that claimed to stop the pill mounting over a
// Web VPython scene fixed exactly one of the two scene containers. hasFigure()
// excluded `#glowscript` by id, which is what setupGlowScene() builds for a
// main-thread run — but the worker path builds `#vpython-scene`, so with
// features.workerVPython on the matplotlib pill mounted over a 3D canvas and
// offered to write rcParams into a VPython program. Both containers carry
// className 'glowscript'; matching the class covers the pair. Nothing caught
// that, because nothing ran this file.
//
// The bundle is a real vendored artifact (public/js/vendor/plotpolish.iife.js),
// tracked but only present when features.plotStyle ships. Skip loudly rather
// than fail if it is missing, the same way glowcomm-host.test.js does.
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT    = path.join(__dirname, '..', '..');
const BUNDLE  = path.join(ROOT, 'public/js/vendor/plotpolish.iife.js');
const ADAPTER = path.join(ROOT, 'public/js/plugins/plotpolish-adapter.js');
const HAVE = fs.existsSync(BUNDLE) && fs.existsSync(ADAPTER);

// The embed's output pane, reduced to the nodes the adapter touches.
const PAGE = `<!doctype html><html><body>
  <div id="graphic-wrap" class="hide"><div id="graphic"></div></div>
  <div id="editor"></div>
</body></html>`;

function boot(opts) {
  const options = opts || {};
  // `url` matters, per @sspickle on #251: without an origin, jsdom treats the
  // document as opaque, and a wrong mount trips
  // "SecurityError: localStorage is not available for opaque origins" instead
  // of failing on the assertion below. Same defect either way, but the message
  // reads like a jsdom quirk rather than "the pill mounted over a VPython
  // scene", which is the whole point of the test.
  const dom = new JSDOM(PAGE, {
    url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const win = dom.window;

  win.trinket = { config: { plotStyle: options.plotStyle !== false } };
  win.ace = { require: () => ({ Range: { fromPoints: (a, b) => [a, b] } }) };

  // The embed's jQuery, reduced to the one call the re-run listener makes.
  // Recorded rather than stubbed away, because "did it ask the embed to run,
  // and through which event" is the whole assertion. `win.$throws` makes the
  // trigger fail the way a broken or absent editor would.
  win.$runs = [];
  // What the host hands back for Save PNG. Recorded, and its return value is
  // the switch the adapter reads: true means "I took it", which is the only
  // thing that may call preventDefault() on the panel's request.
  win.$saves = [];
  win.$saveResult = true;
  win.$saveThrows = false;
  win.$ = function(selector) {
    return {
      trigger: function(name, data) {
        if (win.$throws) throw new Error('no editor');
        win.$runs.push({ selector: selector, name: name, data: data });
      },
    };
  };

  win.eval(fs.readFileSync(BUNDLE, 'utf8'));
  win.eval(fs.readFileSync(ADAPTER, 'utf8'));

  if (win.trinketPlotpolish) {
    const widget = { _files: [], getFile: () => '' };
    win.trinketPlotpolish.init({
      api: { getEditor: () => widget, getMainFile: () => 'main.py' },
      getPyodide: () => null,          // no live preview; mounting is what we test
      saveFigure: (format) => {
        if (win.$saveThrows) throw new Error('no figure');
        win.$saves.push(format);
        return win.$saveResult;
      },
      isBusy: () => false,
    });
  }
  return win;
}

/** Put a <canvas> in #graphic, optionally inside a scene container. */
function addCanvas(win, id) {
  const fig = win.document.getElementById('graphic');
  let host = fig;
  if (id) {
    const div = win.document.createElement('div');
    div.id = id;
    div.className = 'glowscript';   // both containers set this
    fig.appendChild(div);
    host = div;
  }
  host.appendChild(win.document.createElement('canvas'));
}

const pill = (win) => win.document.querySelector('plotpolish-panel');

const d = HAVE ? describe : describe.skip;
if (!HAVE) {
  // eslint-disable-next-line no-console
  console.warn('plotpolish-adapter.test.js: vendored bundle not present, skipping');
}

d('plot-style adapter — mounting', () => {
  it('mounts over a real matplotlib figure', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).not.toBeNull();
  });

  it('does not mount over a main-thread VPython scene (#glowscript)', () => {
    const win = boot();
    addCanvas(win, 'glowscript');
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).toBeNull();
  });

  // The sibling the original guard missed. pyodide.js builds this container id
  // on the worker path; an id-based check let it through.
  it('does not mount over a WORKER VPython scene (#vpython-scene)', () => {
    const win = boot();
    addCanvas(win, 'vpython-scene');
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).toBeNull();
  });

  it('does not mount when the output pane holds no figure at all', () => {
    const win = boot();
    win.document.getElementById('graphic').innerHTML = '<table><tr><td>1</td></tr></table>';
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).toBeNull();
  });
});

d('plot-style adapter — runtime and teardown', () => {
  it('gives a worker run no backend, and still mounts so the block can be written', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    const panel = pill(win);
    expect(panel).not.toBeNull();
    expect(panel.backend).toBeNull();
    expect(panel.features.livePreview).toBe(false);
  });

  // hostRcKeys stopped being advisory in plotpolish v0.3.2: it is threaded into
  // the GENERATED BLOCK as well as set_style()'s keep list, so this list is what
  // decides whether a re-run keeps the host's own rcParams or lets a style throw
  // them away. All three keys are the host's on BOTH runtimes since the dpi pane
  // fit -- it gave the main thread the same fixed figure.figsize and savefig.dpi
  // the worker has.
  const HOST_RC_KEYS = ['figure.autolayout', 'figure.figsize', 'savefig.dpi'];

  // Each key earns its place against a measured failure:
  //   figure.figsize  8 of the 29 styles set it, seaborn-v0_8 among them and a
  //                   default curated button; without it, picking seaborn
  //                   rewrote the fixed 4.8x3.6 to 8x5.5.
  //   savefig.dpi     exactly one style sets it -- `classic`, to 100 -- which
  //                   is in the dropdown, so picking it dropped a 300-dpi
  //                   export to 100 silently.
  it('claims all three host rcParams on a WORKER run', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    expect(pill(win).hostRcKeys).toEqual(HOST_RC_KEYS);
  });

  // It used to be ['figure.autolayout'] here, because nothing on the main thread
  // set figsize. MATPLOTLIB_SETUP_CODE now sets figure.figsize and savefig.dpi
  // too, so withholding them would let a style defeat the pane fit on main only
  // -- exactly the kind of quiet divergence between the two matplotlib
  // integrations this work exists to close.
  it('claims the same three on a MAIN-THREAD run, which now sets them too', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win).hostRcKeys).toEqual(HOST_RC_KEYS);
  });

  // The reason the list is set in afterRun() and not mount(): mount() is
  // one-way, so assigning there would freeze the list at whichever runtime ran
  // first and silently mis-describe every later run.
  it('sets the list on EVERY run, not just the first', () => {
    const win = boot();
    addCanvas(win, null);
    // The list no longer varies by runtime, so this can no longer catch a
    // frozen list by watching it change. Assert the mechanism instead: clear it
    // between runs and check each afterRun puts it back. A list assigned in
    // mount() would come back undefined on the second run.
    win.trinketPlotpolish.afterRun('main');        // the panel only exists after a run
    expect(pill(win).hostRcKeys, 'after the first run').toEqual(HOST_RC_KEYS);
    for (const runtime of ['worker', 'main', 'worker']) {
      pill(win).hostRcKeys = undefined;
      win.trinketPlotpolish.afterRun(runtime);
      expect(pill(win).hostRcKeys, `after a later ${runtime} run`).toEqual(HOST_RC_KEYS);
    }
  });

  it('Clear memory takes the panel down, and a later figure gets a fresh one', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).not.toBeNull();

    win.document.getElementById('graphic').innerHTML = '';
    win.trinketPlotpolish.onFigureGone();
    expect(pill(win)).toBeNull();

    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win)).not.toBeNull();
  });

  it('onFigureGone is a no-op when nothing was mounted', () => {
    const win = boot();
    expect(() => win.trinketPlotpolish.onFigureGone()).not.toThrow();
  });
});

// plotpolish v0.3.4's notice turns into a BUTTON when the host says it will
// answer, and clicking it emits `plotpolish-rerun-requested`. Nothing else in
// this repo services that event, so if these break, the button silently does
// nothing and the student is told to re-run by a control that will not.
d('plot-style adapter — the re-run notice', () => {
  it('declares canRerun on a worker run, where nothing previews', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    expect(pill(win).features.livePreview).toBe(false);
    expect(pill(win).features.canRerun).toBe(true);
  });

  // The pairing is the point: the notice only exists where live preview does
  // not, so offering a re-run button beside a working live preview would be a
  // second control for something already happening on its own.
  it('does NOT declare canRerun on a main-thread run, which previews live', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win).features.canRerun).toBe(false);
  });

  it('follows the runtime across successive runs, like hostRcKeys does', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    expect(pill(win).features.canRerun).toBe(true);
    win.trinketPlotpolish.afterRun('main');
    expect(pill(win).features.canRerun).toBe(false);
  });

  // Through the embed's own run event rather than a click on `a.run-it`, so it
  // inherits runCode()'s guards instead of poking a control that may be
  // hidden, mid-run or showing Stop.
  it('asks the embed to run, through trinket.code.run on #editor', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');

    pill(win).dispatchEvent(new win.CustomEvent('plotpolish-rerun-requested'));

    expect(win.$runs).toHaveLength(1);
    expect(win.$runs[0].selector).toBe('#editor');
    expect(win.$runs[0].name).toBe('trinket.code.run');
    expect(win.$runs[0].data).toEqual({ action: 'code.run' });
  });

  // Copilot on #281, and it was right: every assertion above dispatches the
  // event by hand, so all of them pass even if the RENDERED button is not
  // wired to it, or if plotpolish renames the event in a later release. That
  // is the failure this whole PR exists to prevent -- the student is told to
  // press a button that does nothing -- so it needs a test that presses the
  // real button.
  //
  // The panel renders its full shadow DOM under jsdom (81 buttons, the two
  // re-run surfaces, 13 range inputs), so no browser is needed for this.
  it('runs when the STUDENT clicks the rendered button, not just on a hand-fired event', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    const sr = pill(win).shadowRoot;

    const stale = () => [...sr.querySelectorAll('button.stall.stale')];
    expect(stale().length).toBeGreaterThan(0);
    // Starts inert: there is nothing for a re-run to pick up yet.
    expect(stale().every((b) => b.disabled)).toBe(true);

    // Move a real control, the way a student would, so a change is pending.
    const range = sr.querySelector('input[type=range]');
    range.value = String(Number(range.value) + 4);
    range.dispatchEvent(new win.Event('input', { bubbles: true }));
    range.dispatchEvent(new win.Event('change', { bubbles: true }));

    const live = stale().filter((b) => !b.disabled);
    expect(live.length).toBeGreaterThan(0);

    live[0].click();

    expect(win.$runs).toHaveLength(1);
    expect(win.$runs[0].selector).toBe('#editor');
    expect(win.$runs[0].name).toBe('trinket.code.run');
  });

  it('does not run anything until the panel actually asks', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    expect(win.$runs).toHaveLength(0);
  });

  // A throw here escapes into the panel's own dispatch, where plotpolish is
  // what reports it. The student still has the toolbar's Run button and the
  // notice stays up (only a completed run clears it), so swallowing is right
  // -- but it has to actually swallow.
  //
  // Asserted on the window's error event, NOT on dispatchEvent throwing:
  // dispatchEvent never rethrows a listener's exception, it reports it to the
  // window instead. A `.not.toThrow()` here passes with the try/catch deleted,
  // which is a test that cannot fail.
  it('survives a re-run that cannot be started', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');

    const escaped = [];
    win.addEventListener('error', (e) => escaped.push(e.message));
    win.$throws = true;

    pill(win).dispatchEvent(new win.CustomEvent('plotpolish-rerun-requested'));
    expect(escaped).toEqual([]);

    // And the panel is still live afterwards: a second request, with the
    // editor working again, still reaches the embed.
    win.$throws = false;
    pill(win).dispatchEvent(new win.CustomEvent('plotpolish-rerun-requested'));
    expect(win.$runs).toHaveLength(1);
  });
});

// plotpolish v0.3.5 stopped answering "Run your code first" on a host with no
// backend and started ASKING instead (plotpolish #30). Nothing else in this
// repo services `plotpolish-save-requested`, so if these break, Save PNG is
// once again a button that cannot save on the runtime most students are on.
d('plot-style adapter — Save PNG on the worker', () => {
  /** Open the Save tab and return the rendered Save PNG button + its message. */
  function saveSurface(win) {
    const sr = pill(win).shadowRoot;
    const tab = sr.querySelector('.pill button.tab[data-group="save"]');
    if (tab) tab.click();
    const row = sr.querySelector('.row[data-control="save_png"]');
    return {
      button: row.querySelector('button.save-fig'),
      said: () => row.querySelector('.copy-said').textContent,
    };
  }

  // The one that matters. Every other assertion here could pass with the
  // rendered button unwired, exactly as Copilot pointed out for the re-run
  // button on #281 -- so this one presses what the student presses.
  it('asks the host when the STUDENT clicks the rendered button', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    expect(pill(win).backend).toBeNull();   // the state the whole bug lived in

    const { button, said } = saveSurface(win);
    button.click();

    expect(win.$saves).toEqual(['png']);
    expect(said()).toBe('Saved');
  });

  // The regression guard proper. This exact string is what the button answered
  // on every worker run before v0.3.5, forever, however many times the student
  // ran their code -- and plotpolish's own suite asserted it, which is how it
  // survived. If it ever comes back here, the bug is back.
  it('never tells the student to run their code first', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');

    const { button, said } = saveSurface(win);
    button.click();
    expect(said()).not.toContain('Run your code first');
  });

  // preventDefault() is the contract, so it has to be conditional: a host that
  // could not take the request must leave the event alone, or the panel claims
  // a save that never happened. `saveFigure` returns false when there is no
  // live figure to ask and no fallback image.
  it('does not claim a save the host declined', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    win.$saveResult = false;

    const { button, said } = saveSurface(win);
    button.click();

    expect(win.$saves).toEqual(['png']);
    expect(said()).not.toBe('Saved');
    expect(said()).toContain('available');
  });

  // Same reasoning as the re-run listener's: asserted on the window's error
  // event, not on dispatchEvent throwing, because dispatchEvent never rethrows
  // a listener's exception -- a `.not.toThrow()` here would pass with the
  // try/catch deleted, which is a test that cannot fail.
  it('survives a host save that throws, and does not claim one either', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    win.$saveThrows = true;

    const escaped = [];
    win.addEventListener('error', (e) => escaped.push(e.message));

    const { button, said } = saveSurface(win);
    button.click();

    expect(escaped).toEqual([]);
    expect(said()).not.toBe('Saved');
  });

  // No duplicate-click guard in the adapter: every click is forwarded, and the
  // host decides. There WAS one here, on a 1-second timer, and it returned
  // before ctx.saveFigure was called -- so a click within a second of a Stop
  // never reached the no-worker check and the panel said "Saved". Deduping
  // belongs next to the reply that ends the save, which is in pyodide.js;
  // worker-figure-save.test.js executes it there.
  //
  // (There was also a test here asserting the host is not asked when it
  // declines. It was byte-identical to "does not claim a save the host
  // declined" above -- coverage-shaped, adding none -- and is gone.)
  it('forwards every click and lets the host decide about duplicates', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');

    const { button } = saveSurface(win);
    button.click();
    button.click();
    button.click();

    expect(win.$saves).toEqual(['png', 'png', 'png']);
  });

  it('does not ask the host for anything until the button is pressed', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('worker');
    expect(win.$saves).toHaveLength(0);
  });

  // On the main thread the panel HAS a backend, so it runs savefig itself and
  // must never route through the host. If it did, the Save tab's savefig keys
  // would stop applying on the runtime where they already worked.
  it('is not used on a main-thread run, where the panel saves for itself', () => {
    const win = boot();
    addCanvas(win, null);
    win.trinketPlotpolish.afterRun('main');

    const { button } = saveSurface(win);
    button.click();
    expect(win.$saves).toHaveLength(0);
  });
});

d('plot-style adapter — the flag', () => {
  it('defines no global at all when features.plotStyle is false', () => {
    const win = boot({ plotStyle: false });
    expect(win.trinketPlotpolish).toBeUndefined();
  });

  it('so every hook in pyodide.js is a no-op when the flag is off', () => {
    const win = boot({ plotStyle: false });
    // This is the shape of all four call sites in pyodide.js.
    expect(() => { if (win.trinketPlotpolish) win.trinketPlotpolish.afterRun('main'); }).not.toThrow();
    expect(pill(win)).toBeNull();
  });
});
