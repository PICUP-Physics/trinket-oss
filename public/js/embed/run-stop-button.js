// Page-side view of the GlowScript Stop button: morphs the toolbar's Run
// control(s) into Stop while a program runs, dimmed while it stops, and back to
// exactly what each one was, so the editor and output-only toolbars keep their
// own wording. While a program runs and the editor holds something other than what
// runs, the control offers to run the changes instead: ↻ Run (edited()). The
// control keeps the exact width it has as Run in every state and every look, so
// nothing in the toolbar moves.
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
  // Stopping shows what running shows, so the control does not change size; the
  // stylesheet dims it, and only the wording read aloud and in the tooltip says
  // that it is stopping.
  var STATES = {
    running:  { cls: 'run-state-running',  action: 'code.stop', icon: 'fa fa-stop', label: 'Stop',
                aria: 'Stop program',     title: 'Stop the program.' },
    stopping: { cls: 'run-state-stopping', action: 'code.stop', icon: 'fa fa-stop', label: 'Stop',
                aria: 'Stopping program', title: 'Stopping the program.' }
  };
  // A running control whose program is no longer what the editor holds. It keeps the
  // running state's class, which the strip's styles hang on, and adds this one; its
  // action is the plain Run's, so a click goes the way Ctrl/Cmd-Enter goes.
  var EDITED = { cls: 'run-state-edited', action: 'code.run', icon: 'fa fa-repeat', label: 'Run',
                 aria: 'Run your changes', title: 'Run your changes (restarts the program).' };

  function setAttr(el, name, value) {
    if (value === null || value === undefined) { el.removeAttribute(name); }
    else { el.setAttribute(name, value); }
  }

  // This project's Foundation 5.5 builds a control's tooltip once, at page init,
  // from its title, blanking the title as it does, and never rebuilds one. So a
  // control with a built tooltip keeps its title as Foundation left it and the
  // view rewrites the tooltip's text in place; a control without one carries
  // the wording in its title attribute. Foundation keys a tooltip by the
  // control's id, else by the data-selector it assigns.
  function tooltipOf(el) {
    var selector = el.getAttribute('id') || el.getAttribute('data-selector');
    if (!selector) { return null; }
    return el.ownerDocument.querySelector('span.tooltip[data-selector="' + selector + '"]');
  }

  // A tooltip is its text followed by Foundation's .nub (and, on touch devices,
  // a .tap-to-close); only the text in front of the nub is the wording.
  function isNub(node) {
    return node.nodeType === 1 && node.classList.contains('nub');
  }

  function tooltipText(tip) {
    var text = '';
    for (var node = tip.firstChild; node && !isNub(node); node = node.nextSibling) {
      text += node.textContent;
    }
    return text;
  }

  function setTooltipText(tip, text) {
    var nub = null;
    for (var node = tip.firstChild; node; node = node.nextSibling) {
      if (isNub(node)) { nub = node; break; }
    }
    while (tip.firstChild && tip.firstChild !== nub) { tip.removeChild(tip.firstChild); }
    tip.insertBefore(tip.ownerDocument.createTextNode(text || ''), nub);
  }

  function setTitle(el, title) {
    var tip = tooltipOf(el);
    if (tip) { setTooltipText(tip, title); }
    else { setAttr(el, 'title', title); }
  }

  function snapshot(el) {
    var icon = el.querySelector('i');
    var label = el.querySelector('label');
    var tip = tooltipOf(el);
    return {
      action: el.getAttribute('data-action'),
      // The wording to restore: a built tooltip's text, else the title.
      title: tip ? tooltipText(tip) : el.getAttribute('title'),
      aria: el.getAttribute('aria-label'),
      icon: icon ? icon.getAttribute('class') : null,
      label: label ? label.textContent : null,
      // The inline size and wrapping the markup itself carries, if any (usually
      // none), restored when the program ends: the width hold below overrides
      // width, padding and white-space while a program runs. It never writes
      // min-width; that is captured and restored defensively, in case markup
      // or an older view left one.
      width: el.style.width,
      minWidth: el.style.minWidth,
      paddingLeft: el.style.paddingLeft,
      paddingRight: el.style.paddingRight,
      whiteSpace: el.style.whiteSpace
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

  function px(value) { return parseFloat(value) || 0; }

  // The inline width that makes the control's outer width runWidth, given its side
  // paddings. Foundation 5 gives every element border-box, where width is the outer
  // width. A content-box control's width leaves out its padding and border.
  function fitWidth(style, runWidth, left, right) {
    if (style.boxSizing !== 'content-box') { return runWidth; }
    return Math.max(0, runWidth - left - right - px(style.borderLeftWidth) - px(style.borderRightWidth));
  }

  // Holds the control at runWidth, the outer width it measured as Run, now that it
  // shows Stop. Stop's icon and label come out a few pixels wider than Run's (about
  // 4 px, or 1 px where only the icon shows), so the difference comes out of the
  // control's own side padding, half from each side, which keeps the content
  // centered. A control that Stop fits in is only held. The caller has swapped in
  // Stop's content and nothing here has overridden the size yet, so the width read
  // now is Stop's natural one. Sub-pixel widths are kept: rounding them moves the
  // toolbar by a pixel. Returns what it holds the control at, as the exact values it
  // wrote: reading them back from the style would give them rounded (Blink writes
  // 76.453125px back as 76.4531px, which lays out a grid step narrower), and Stop's
  // fit has to come back exactly when ↻ Run gives way to it.
  function holdWidth(el, runWidth) {
    var stopWidth = el.getBoundingClientRect().width;
    // Live: it follows the inline style below, so everything is read before any write.
    var style = el.ownerDocument.defaultView.getComputedStyle(el);
    var squeeze = Math.max(0, stopWidth - runWidth) / 2;
    var left = Math.max(0, px(style.paddingLeft) - squeeze);
    var right = Math.max(0, px(style.paddingRight) - squeeze);
    var hold = { runWidth: runWidth, width: fitWidth(style, runWidth, left, right) + 'px',
                 left: el.style.paddingLeft, right: el.style.paddingRight };
    if (squeeze > 0) {
      hold.left = left + 'px';
      hold.right = right + 'px';
      el.style.paddingLeft = hold.left;
      el.style.paddingRight = hold.right;
    }
    el.style.width = hold.width;
    // The fit is exact, and a layout engine that rounds a length to its grid (1/64 px
    // in Blink and WebKit, 1/60 px in Gecko) can leave the content box one step short
    // of Stop's content. Then the label drops under the icon and the control grows
    // 16 px taller. One line it stays: a shortfall overflows by a step, unseen.
    el.style.whiteSpace = 'nowrap';
    return hold;
  }

  // How wide what the control shows is: its icon, its label and the gap between them,
  // from the icon's left edge to the label's right edge, or just the icon where the
  // label is hidden (below the large breakpoint). Zero for a control that is not
  // rendered. It reads the content's own boxes, which do not depend on the width the
  // control is held at, so nothing has to be released to measure.
  function contentWidth(el) {
    var left = Infinity;
    var right = -Infinity;
    ['i', 'label'].forEach(function (tag) {
      var child = el.querySelector(tag);
      var box = child && child.getBoundingClientRect();
      if (box && box.width > 0) {
        left = Math.min(left, box.left);
        right = Math.max(right, box.right);
      }
    });
    return right > left ? right - left : 0;
  }

  // The control shows ↻ Run in the width it is held at for Stop, and ↻ Run's content is
  // not Stop's (its label is shorter). The side padding takes up the difference, half
  // to each side as holdWidth does for Stop, so the content fills what the padding
  // leaves and stays centered, whatever the two widths come to. stopContent is Stop's
  // content as it measured before the swap; the padding it starts from is Stop's, which
  // is what the control carries now. A content that measures the same needs no change.
  function recenter(el, hold, stopContent) {
    var content = contentWidth(el);
    if (!(stopContent > 0 && content > 0) || content === stopContent) { return; }
    // Live: it follows the inline style below, so everything is read before any write.
    var style = el.ownerDocument.defaultView.getComputedStyle(el);
    var shift = (stopContent - content) / 2;
    var left = Math.max(0, px(style.paddingLeft) + shift);
    var right = Math.max(0, px(style.paddingRight) + shift);
    var width = fitWidth(style, hold.runWidth, left, right);
    el.style.paddingLeft = left + 'px';
    el.style.paddingRight = right + 'px';
    el.style.width = width + 'px';
  }

  // Stop's fit again, exactly the values holdWidth wrote.
  function fitStop(el, hold) {
    el.style.width = hold.width;
    el.style.paddingLeft = hold.left;
    el.style.paddingRight = hold.right;
  }

  function setAction(el, action, $) {
    setAttr(el, 'data-action', action);
    // embed.js dispatches on jQuery's .data('action'), which caches the first read.
    if ($) { $(el).data('action', action); }
  }

  // What a look does and says: its action, tooltip or title, aria-label, icon and label.
  function setLook(el, look, $) {
    var icon = el.querySelector('i');
    var label = el.querySelector('label');
    setAction(el, look.action, $);
    setTitle(el, look.title);
    setAttr(el, 'aria-label', look.aria);
    if (icon) { icon.setAttribute('class', look.icon); }
    if (label) { label.textContent = look.label; }
  }

  function create(elements, $) {
    // hold: what the control is held at while it is not idle, for ↻ Run to work from:
    // the outer width it had as Run, and the inline width and side padding that hold
    // it there as Stop. Null while idle, and for a control that is not rendered.
    var items = Array.prototype.map.call(elements, function (el) {
      return { el: el, orig: snapshot(el), hold: null };
    });
    var current = 'idle';
    var isEdited = false;

    function apply(item, next) {
      var el = item.el;
      var orig = item.orig;
      var icon = el.querySelector('i');
      var label = el.querySelector('label');
      // Leaving idle: the control exactly as it shows Run, before anything below
      // changes it. Running and stopping are the same size, so they never measure.
      var runWidth = current === 'idle' && next !== 'idle' ? el.getBoundingClientRect().width : 0;

      // Every state starts from a plain look, so setting one clears ↻ Run.
      el.classList.remove('run-state-running', 'run-state-stopping', EDITED.cls);

      if (next === 'idle') {
        setAction(el, orig.action, $);
        setTitle(el, orig.title);
        setAttr(el, 'aria-label', orig.aria);
        el.removeAttribute('aria-disabled');
        if (icon) { setAttr(icon, 'class', orig.icon); }
        if (label) { label.textContent = orig.label; }
        el.style.width = orig.width;
        el.style.minWidth = orig.minWidth;
        el.style.paddingLeft = orig.paddingLeft;
        el.style.paddingRight = orig.paddingRight;
        el.style.whiteSpace = orig.whiteSpace;
        item.hold = null;
      } else {
        var s = STATES[next];
        addTrace(el);
        el.classList.add(s.cls);
        setLook(el, s, $);
        if (next === 'stopping') { el.setAttribute('aria-disabled', 'true'); }
        else { el.removeAttribute('aria-disabled'); }
        if (runWidth > 0) {
          // A control that is not rendered (a hidden toolbar) has no width to keep.
          item.hold = holdWidth(el, runWidth);
        } else if (item.hold) {
          // Stop's content again, where ↻ Run's may have been: Stop's fit with it.
          fitStop(el, item.hold);
        }
      }
    }

    // The control shows ↻ Run (on), or is Stop again (off). The width stays held;
    // the content swaps, and the side padding follows it.
    function applyEdited(item, on) {
      var el = item.el;
      var hold = item.hold;
      // While it still shows the look it is leaving, which Stop's fit is for.
      var before = hold && on ? contentWidth(el) : 0;
      if (on) { el.classList.add(EDITED.cls); }
      else { el.classList.remove(EDITED.cls); }
      setLook(el, on ? EDITED : STATES.running, $);
      if (!hold) { return; }
      if (on) { recenter(el, hold, before); }
      else { fitStop(el, hold); }
    }

    return {
      // Setting any state clears ↻ Run.
      set: function (next) {
        if (next !== 'idle' && !STATES[next]) { throw new Error('unknown run state: ' + next); }
        items.forEach(function (item) { apply(item, next); });
        current = next;
        isEdited = false;
      },
      // ↻ Run for a running program the editor no longer matches (on), Stop again when
      // it matches once more (off). Only a running program has anything to be edited
      // from, so this does nothing in any other state, and nothing when the control
      // already shows what it is asked for.
      edited: function (on) {
        on = !!on;
        if (current !== 'running' || on === isEdited) { return; }
        items.forEach(function (item) { applyEdited(item, on); });
        isEdited = on;
      },
      state: function () { return current; }
    };
  }

  return { create: create };
}));
