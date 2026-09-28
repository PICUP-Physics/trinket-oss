// Indentation help for the plain-text editor (the <textarea> that exam mode,
// the per-user "disable Ace" setting and the Accessibility toggle switch to;
// createMobileAPI in code-editor.js). Pure functions over (value, selection),
// so they can be tested without a browser; the editor applies the returned
// edit with document.execCommand('insertText') to keep the undo history.
//
// Only Enter, and Tab/Shift-Tab in exam mode, are ever handled. Copy, cut and
// paste are never touched: in Safe Exam Browser that is the whole point of
// the plain editor.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrinketPlainIndent = factory();
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // Languages whose blocks open with a trailing ':'.
  var COLON_BLOCKS = ['python', 'python3', 'pyodide', 'pygame', 'glowscript', 'console'];
  // A line that ends its block; the next line steps back out one level.
  var BLOCK_EXIT = /^(return|pass|break|continue|raise)\b/;

  function lineStart(value, pos) {
    return value.lastIndexOf('\n', pos - 1) + 1;
  }

  function lineEnd(value, pos) {
    var end = value.indexOf('\n', pos);
    return end === -1 ? value.length : end;
  }

  function spaces(n) {
    return new Array(n + 1).join(' ');
  }

  // How many leading characters one outdent removes from `text`: a single tab,
  // or up to `unit` spaces. (Enter keeps tabs, so tab-indented code happens.)
  function outdentWidth(text, unit) {
    if (text.charAt(0) === '\t') return 1;
    return Math.min(unit, /^ */.exec(text)[0].length);
  }

  // Enter: the new line starts with the current line's indentation, one level
  // deeper after a line ending in ':' (Python-like languages), one level
  // shallower after return/pass/break/continue/raise. Returns the edit that
  // replaces the selection.
  function enter(value, selStart, selEnd, opts) {
    var unit = (opts && opts.tabSize) || 2
      , start = lineStart(value, selStart)
      , before = value.slice(start, selStart)
      , indent = /^[ \t]*/.exec(before)[0]
      , code = before.trim();

    if (opts && COLON_BLOCKS.indexOf(opts.lang) >= 0) {
      if (/:$/.test(code)) {
        // Follow the line's own style: a tab-indented block goes one tab deeper.
        indent += /\t$/.test(indent) ? '\t' : spaces(unit);
      }
      else if (BLOCK_EXIT.test(code) && indent.length) {
        indent = indent.slice(0, indent.length - outdentWidth(indent.split('').reverse().join(''), unit));
      }
    }

    return { start: selStart, end: selEnd, text: '\n' + indent };
  }

  // Tab / Shift-Tab. With no multi-line selection, Tab inserts one level at
  // the caret. A selection spanning lines, or Shift-Tab, indents or outdents
  // every line it touches; the edit then replaces those whole lines, and
  // `select` says what to re-select afterwards.
  function tab(value, selStart, selEnd, opts) {
    var unit = (opts && opts.tabSize) || 2
      , outdent = !!(opts && opts.shift)
      , multi = value.slice(selStart, selEnd).indexOf('\n') >= 0;

    if (!outdent && !multi) {
      return { start: selStart, end: selEnd, text: spaces(unit) };
    }

    var start = lineStart(value, selStart)
      // a selection ending at the very start of a line does not include it
      , endPos = (multi && selEnd > selStart && value.charAt(selEnd - 1) === '\n') ? selEnd - 1 : selEnd
      , end = lineEnd(value, endPos)
      , lines = value.slice(start, end).split('\n')
      , firstShift = 0
      , total = 0
      , out = lines.map(function(line, i) {
          var change;
          if (outdent) {
            change = -outdentWidth(line, unit);
            line = line.slice(-change);
          }
          else {
            change = unit;
            line = spaces(unit) + line;
          }
          if (i === 0) firstShift = change;
          total += change;
          return line;
        }).join('\n');

    if (total === 0) return null;   // nothing to outdent

    return {
      start  : start,
      end    : end,
      text   : out,
      select : multi
        ? [start, start + out.length]
        : [Math.max(start, selStart + firstShift), Math.max(start, selEnd + firstShift)]
    };
  }

  // keydown → the edit to make, or null to let the browser handle the key.
  // Tab is claimed only in exam mode: in the screen-reader editor it must keep
  // moving focus out of the textarea, or keyboard users are trapped.
  function handleKey(e, value, selStart, selEnd, opts) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
    if (e.key === 'Enter' && !e.shiftKey) return enter(value, selStart, selEnd, opts);
    if (e.key === 'Tab' && opts && opts.examMode) {
      return tab(value, selStart, selEnd, { tabSize: opts.tabSize, shift: e.shiftKey });
    }
    return null;
  }

  return { enter: enter, tab: tab, handleKey: handleKey };
});
