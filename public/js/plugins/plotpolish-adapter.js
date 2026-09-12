/**
 * plotpolish adapter: a "Plot style" panel over the Pyodide embed's figure.
 *
 * The library (public/js/vendor/plotpolish.iife.js) is host-agnostic: it asks
 * for a CodeSink (where the student's source lives) and a FigureBackend (one
 * method that runs Python and returns the last expression as a string). This
 * file is the only place that knows about Trinket, and it holds everything
 * except three small hooks in pyodide.js, which exist because that file is a
 * closure -- `api`, `editor`, `pyodide` and `running` are not reachable from
 * out here, so the hooks hand them over.
 *
 * Gated by features.plotStyle. When the flag is off this file still loads but
 * never defines window.trinketPlotpolish, so every hook in pyodide.js is a
 * no-op and nothing else here runs.
 */
(function(window, document) {
  'use strict';

  var cfg = window.trinket && window.trinket.config;
  if (!cfg || !cfg.plotStyle || !window.plotpolish) return;

  var ctx        = null;   // { api, getPyodide, isBusy }, from pyodide.js
  var panel      = null;   // the <plotpolish-panel> element
  var mounted    = false;
  var listener   = null;   // the panel's sink subscriber
  var lastSource = null;   // last main.py text we told the panel about
  var lastWriteAt = 0;     // for undo coalescing across slider ticks

  // Slider drags write on every input tick. Ace merges a delta into the
  // previous undo group when session.mergeUndoDeltas is set at the time of the
  // edit, so a whole drag collapses into one undo step instead of dozens.
  var MERGE_WINDOW_MS = 600;

  // ---------------------------------------------------------------------
  // Reaching the editor
  // ---------------------------------------------------------------------

  // pyodide.js does `editor = $('#editor').codeEditor({...})` and then calls
  // widget methods on the result, so that value is the widget instance. Fall
  // back to the jQuery data key in case that ever becomes the jQuery object.
  function widget() {
    var e = ctx && ctx.api && typeof ctx.api.getEditor === 'function' ? ctx.api.getEditor() : null;
    if (e && e._files) return e;
    var $el = window.jQuery ? window.jQuery('#editor') : null;
    if (!$el || !$el.length) return null;
    return $el.data('trinket-codeEditor') || $el.data('codeEditor') || null;
  }

  function mainFileName() {
    return (ctx && ctx.api && typeof ctx.api.getMainFile === 'function' && ctx.api.getMainFile()) || 'main.py';
  }

  // Never cache this. The widget destroys and recreates every file editor on
  // reset() and refresh(), which run on initial load, draft load and revert.
  function fileEditorFor(name) {
    var w = widget(), i;
    if (!w || !w._files) return null;
    for (i = 0; i < w._files.length; i++) {
      if (w._files[i].name === name) return w._files[i].editor;
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // CodeSink
  // ---------------------------------------------------------------------

  var sink = {
    getSource: function() {
      var w = widget();
      return w && typeof w.getFile === 'function' ? w.getFile(mainFileName()) : '';
    },

    /**
     * Replace only the range that actually differs.
     *
     * The panel regenerates one fenced block at the top of the file, so the
     * whole-document alternative (editor.setValue(text, -1)) would work -- but
     * it moves the cursor to 0,0, drops the selection, scrolls to the top and
     * loses code folds. That happens on every slider tick, while the student
     * may be typing further down. Replacing the differing range instead lets
     * Ace's anchors carry the cursor along, so someone editing line 40 stays
     * on line 40.
     */
    setSource: function(next) {
      var fe = fileEditorFor(mainFileName());
      if (!fe) return;

      // Fallback editor (disableAceEditor): a textarea, no session to splice.
      // Track lastSource here too, exactly as the Ace path below does. Without
      // it this path relied on the echo: setValue fires change, onEditorChange
      // re-reads the source and updates lastSource on the way past. That works
      // only while the panel is subscribed -- onEditorChange returns early when
      // `listener` is null, before touching lastSource -- so before the first
      // subscribe the two paths disagreed about what the file last said.
      if (!fe.aceInstance || typeof fe.getSession !== 'function') {
        if (typeof fe.setValue === 'function') {
          fe.setValue(next);
          lastSource = next;
        }
        return;
      }

      var session = fe.getSession();
      var doc     = session.getDocument();
      var prev    = doc.getValue();
      if (prev === next) return;

      // Common prefix, then common suffix over what is left of both strings.
      var max = Math.min(prev.length, next.length);
      var p = 0;
      while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
      var s = 0;
      while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;

      var Range = window.ace.require('ace/range').Range;
      var range = Range.fromPoints(doc.indexToPosition(p), doc.indexToPosition(prev.length - s));

      // Ace does manage this flag itself -- onChange sets it true after taking
      // a delta, a delayedCall resets it to false, and the editor's
      // $historyTracker overwrites it per keystroke -- so leaving it set is not
      // as consequential as it looks. Restore it anyway: relying on the
      // timing of somebody else's internal reset is how the last subtle bug in
      // this file happened, and a programmatic write that lands in the window
      // before that reset would inherit our value.
      var prevMerge = session.mergeUndoDeltas;
      var now = Date.now();
      session.mergeUndoDeltas = (now - lastWriteAt) < MERGE_WINDOW_MS;
      lastWriteAt = now;

      try {
        // Synchronous: onChange consumes the flag before this returns, so the
        // coalescing still happens and the restore below cannot undo it.
        session.replace(range, next.slice(p, next.length - s));
        lastSource = next;
      } finally {
        session.mergeUndoDeltas = prevMerge;
      }
    },

    subscribe: function(fn) {
      listener = fn;
      return function() { if (listener === fn) listener = null; };
    }
  };

  // ---------------------------------------------------------------------
  // FigureBackend
  // ---------------------------------------------------------------------

  // Mirrors Trinket's own snapshotVariables()/expandNode() idiom: run in a
  // throwaway namespace and destroy it, so nothing leaks into the student's
  // globals. plotpolish's snippet ends in a bare expression, which is what
  // runPython returns.
  var backend = {
    runPython: function(code) {
      var py = ctx && ctx.getPyodide ? ctx.getPyodide() : null;
      if (!py) return Promise.reject(new Error('Python is not loaded yet.'));
      // Guarded like getPyodide above it. init() always supplies isBusy, so
      // this is defensive rather than a known path -- but it was the one
      // member access here reaching into ctx without a check, and a host that
      // hands over a partial context should get a refusal, not a TypeError.
      if (typeof ctx.isBusy !== 'function' || ctx.isBusy()) {
        return Promise.reject(new Error('A program is running.'));
      }

      var ns = null, result = null;
      try {
        ns = py.toPy({});
        result = py.runPython(code, { globals: ns });
        return Promise.resolve(String(result));
      } catch (e) {
        return Promise.reject(e);
      } finally {
        // Defensive, not a live leak: plotpolish's snippet ends in
        // dispatch(...), which returns json.dumps(...) -- a Python str, which
        // Pyodide converts to a JS string primitive, so there is nothing to
        // free today. But String() discards whatever comes back without
        // looking, so if that contract ever returns a dict or a list instead,
        // every backend call would quietly leak one PyProxy. Freeing it costs
        // two lines and removes the dependency on a contract we do not own.
        // Safe here because String(result) has already run.
        if (result && typeof result.destroy === 'function') {
          try { result.destroy(); } catch (ignored) {}
        }
        if (ns && typeof ns.destroy === 'function') {
          try { ns.destroy(); } catch (ignored) {}
        }
      }
    }
  };

  // ---------------------------------------------------------------------
  // Mounting
  // ---------------------------------------------------------------------

  // Both the panel and its position anchor go on #graphic-wrap, not #graphic.
  // #graphic is the obvious choice -- resetOutput() empties it every run while
  // the node itself persists -- but it is also *taller* than the wrap, which
  // scrolls (overflow: auto). Anchoring to #graphic puts the pill at the
  // figure's top-right, which is above the wrap's scroll viewport and so off
  // screen. #graphic-wrap persists just as reliably and is the visible box.
  // The wrap is hidden until showGraphic(); the pill lives in the element's
  // shadow root, so it inherits that and stays invisible until a figure exists.
  function mount() {
    if (mounted) return true;
    var wrap = document.getElementById('graphic-wrap');
    var fig  = document.getElementById('graphic');
    if (!wrap || !fig) return false;

    panel = document.createElement('plotpolish-panel');
    // Trinket's embed is hard-coded light and defines no CSS custom
    // properties; without this the panel follows the student's OS dark mode.
    panel.setAttribute('theme', 'light');
    panel.sink = sink;
    panel.figureElement = wrap;
    // hostRcKeys is deliberately NOT set here: the list depends on which
    // runtime ran, and mount() is one-way. afterRun() sets it per run.

    // The panel cannot run anything itself -- it is host-agnostic, and "run"
    // means something different in every embed -- so on the worker runtime,
    // where nothing previews, its notice becomes a button and asks us instead.
    // This listener is what makes features.canRerun honest: the panel only
    // renders that button when the host has declared it will answer, and this
    // is the answer.
    //
    // Fired through jQuery on #editor rather than by clicking `a.run-it`:
    // that is exactly what this embed's own Ctrl-Enter/Cmd-Enter run command
    // does (pyodide.js:4830), and the document-level handler beside it
    // (pyodide.js:4835) is what turns the event into a run, via showResult ->
    // runCode. So a re-run from here inherits runCode's guards -- it is
    // ignored while a step-through recording is in flight and while an
    // ordinary run is still going (pyodide.js:4329) -- rather than simulating
    // a click on a control that may be hidden, mid-run or replaced by Stop.
    panel.addEventListener('plotpolish-rerun-requested', function() {
      try {
        $('#editor').trigger('trinket.code.run', { action: 'code.run' });
      } catch (e) {
        // A failed re-run is not worth breaking the panel over: the student
        // still has the toolbar's own Run button, and the notice stays up
        // because only a completed run clears it.
      }
    });

    wrap.appendChild(panel);
    mounted = true;
    return true;
  }

  // Only show the panel when the output pane actually holds a figure -- a
  // pandas HTML table or a print-only program should not get a style pill.
  function hasFigure() {
    var fig = document.getElementById('graphic');
    if (!fig) return false;
    // A worker run posts the figure back as an image.
    if (fig.querySelector('img.worker-figure')) return true;
    // Any <canvas> is not enough: Web VPython draws its 3D scene on a canvas
    // inside #graphic, so matching canvases alone mounted the plot-style pill
    // over a VPython scene and offered to write matplotlib rcParams into a
    // VPython program.
    //
    // Match the CLASS, not the id. There are TWO scene containers and they have
    // different ids: setupGlowScene() builds #glowscript for a main-thread run,
    // and the worker path builds #vpython-scene. Both set className 'glowscript',
    // so '.glowscript' is the one selector that covers the pair -- an id check
    // excluded only whichever container the author happened to be looking at,
    // and the worker scene got the pill anyway.
    var canvases = fig.querySelectorAll('canvas');
    for (var i = 0; i < canvases.length; i++) {
      if (!canvases[i].closest('.glowscript')) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------
  // Public surface, called by the hooks in pyodide.js
  // ---------------------------------------------------------------------

  window.trinketPlotpolish = {
    init: function(context) {
      ctx = context;
      lastSource = sink.getSource();
    },

    /** The editor changed (any file, any cause). Tell the panel if main.py did. */
    onEditorChange: function() {
      if (!listener) return;
      var now = sink.getSource();
      if (now === lastSource) return;
      lastSource = now;
      listener();
    },

    /**
     * A run finished. `runtime` is 'main' or 'worker'.
     *
     * Phase 1 gives worker runs no backend: there is no second Pyodide on the
     * page to introspect with, so live preview is off and the panel falls back
     * to its "re-run to see" path. refresh() still clears the pending marks.
     */
    afterRun: function(runtime) {
      if (!hasFigure()) return;
      if (!mount()) return;

      var wantLive = runtime !== 'worker';
      var want     = wantLive ? backend : null;
      var changed  = panel.backend !== want;

      // Keys this host sets through rcParams before every run. plotpolish uses
      // them twice: as set_style()'s `keep` list, so its in-process reset
      // (style.use("default"), then the chosen style) puts them back instead of
      // leaving the live figure on matplotlib's defaults; and -- since v0.3.2 --
      // in the generated block, which saves them, runs mpl.style.use(<name>),
      // and restores them, so a re-run draws what the preview showed.
      //
      // The list mirrors what each runtime actually sets, and they differ:
      //   main   pyodide.js MATPLOTLIB_SETUP_CODE -- figure.autolayout only
      //   worker pyodide-worker.js MPL_SETUP      -- autolayout AND a
      //          pane-fitting figure.figsize
      //
      // So figsize is listed on the worker only. On the main thread it would be
      // wrong rather than merely useless: nothing sets figsize there, so the
      // block would save and restore whatever happened to be current and
      // defeat a style's own figsize for no reason.
      //
      // Why it matters on the worker: 8 of matplotlib's 29 styles set
      // figure.figsize, seaborn-v0_8 among them -- and that is one of the
      // default curated buttons. Before v0.3.2 picking it threw the pane fit
      // away on every re-run while live preview went on showing it, which is
      // the live-matches-re-run promise broken. Fixed upstream, and this line
      // is what opts the host into the fix.
      //
      // Per run, not in mount(): mount() is one-way, and a session can run on
      // either runtime, so the list has to follow the run that just happened.
      panel.hostRcKeys = runtime === 'worker'
        ? ['figure.autolayout', 'figure.figsize']
        : ['figure.autolayout'];

      // canRerun follows wantLive: the button only exists in the state where
      // nothing previews, which is the only state the notice appears in at
      // all. Stated explicitly rather than left to default so that the pairing
      // is visible here, next to the listener that services it.
      panel.features = { livePreview: wantLive, canRerun: !wantLive };
      if (changed) panel.backend = want;

      // The backend setter ALREADY calls refresh() when the new backend is
      // non-null. Refreshing again here ran the whole introspection round twice
      // on every null->backend transition -- measured six helper runs where
      // three would do. Refresh explicitly only when the setter did not.
      //
      // The .catch is belt and braces, not the containment it used to claim to
      // be: refresh() records a backend failure in the panel's own state and
      // resolves, so there is no rejection to escape today. Keeping it means a
      // future refresh() that can reject still cannot reach the host, which the
      // try/catch around afterRun() in pyodide.js could never do -- that call
      // returns before the promise settles.
      if (!changed || !want) {
        panel.refresh().catch(function() {});
      }
    },

    /**
     * The figure and the interpreter behind it are gone -- "Clear memory"
     * resets the namespace, empties #graphic and hides the pane.
     *
     * Take the panel down rather than leaving it: it holds a backend pointing
     * at a namespace that has just been reset, so every control would run the
     * helper against an interpreter with no current figure. mount() is one-way,
     * so without this the next graphic to appear -- a VPython scene, a pygame
     * surface -- inherits a stale pill wired to a dead figure.
     *
     * Nothing is lost by unmounting: the settings live in the student's own
     * fenced block, and a fresh mount reads them straight back out of it.
     */
    onFigureGone: function() {
      if (!mounted) return;
      if (panel) {
        panel.backend = null;
        if (panel.parentNode) panel.parentNode.removeChild(panel);
      }
      panel   = null;
      mounted = false;
    }
  };
})(window, document);
