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
      if (!fe.aceInstance || typeof fe.getSession !== 'function') {
        if (typeof fe.setValue === 'function') fe.setValue(next);
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

      var now = Date.now();
      session.mergeUndoDeltas = (now - lastWriteAt) < MERGE_WINDOW_MS;
      lastWriteAt = now;

      session.replace(range, next.slice(p, next.length - s));
      lastSource = next;
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
      if (ctx.isBusy()) return Promise.reject(new Error('A program is running.'));

      var ns = null;
      try {
        ns = py.toPy({});
        return Promise.resolve(String(py.runPython(code, { globals: ns })));
      } catch (e) {
        return Promise.reject(e);
      } finally {
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
    // Trinket re-applies these before every run, so the block must not fight
    // them; plotpolish leaves keys listed here out of what it writes.
    panel.hostRcKeys = ['figure.autolayout'];

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
    // Any <canvas> is not enough: setupGlowScene() puts a #glowscript
    // container inside #graphic and Web VPython draws its 3D scene on a canvas
    // there, so matching canvases alone mounted the plot-style pill over a
    // VPython scene and offered to write matplotlib rcParams into a VPython
    // program. Only count a canvas that is not inside that container.
    var canvases = fig.querySelectorAll('canvas');
    for (var i = 0; i < canvases.length; i++) {
      if (!canvases[i].closest('#glowscript')) return true;
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

      panel.features = { livePreview: wantLive };
      if (panel.backend !== want) {
        panel.backend = want;   // the setter does not refresh on its own
      }
      // refresh() is async, so the try/catch around afterRun() in pyodide.js
      // cannot contain it: that returns before the promise settles. Swallow it
      // here instead, or a failure surfaces as an unhandled rejection.
      panel.refresh().catch(function() {});
    }
  };
})(window, document);
