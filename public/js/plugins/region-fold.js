// #330: fold between `#region` and `#endregion` comments in ACE's Python mode.
//
// ACE folds Python on colons and brackets only (ace/mode/folding/pythonic, as
// of 1.44 too), so there was no way to collapse an arbitrary block -- a
// simulation's setup, say -- to show the big picture. Monaco and VS Code fold
// these comments; using their markers means a program folds the same way in
// trinket, beta.webvpython.org and VS Code, and the folds live in the code, so
// they survive saving and sharing.
//
// wrapFoldMode() layers the markers over the mode's own fold rules: a matched
// `#region` line gets a widget, every other line is asked of the base mode
// unchanged. The matching is pure (lines in, row out) so it is unit-tested
// without ACE; code-editor.js installs the wrapper on Python-mode sessions.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrinketRegionFold = factory();
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // The marker must open the line (indentation allowed) and be a whole word:
  // `#regional` and `x = 1  #region` are not markers. Case-sensitive, as in
  // Monaco and VS Code; a space after the `#` is accepted (VS Code's form).
  var START = /^\s*#\s*region\b/;
  var END   = /^\s*#\s*endregion\b/;

  function isRegionStart(line) { return START.test(line || ''); }
  function isRegionEnd(line)   { return END.test(line || ''); }

  // The row of the `#endregion` matching the `#region` on `row`, counting
  // nested regions; -1 when `row` is not a region start or is never closed.
  function findRegionEnd(getLine, length, row) {
    if (!isRegionStart(getLine(row))) return -1;
    var depth = 0;
    for (var r = row; r < length; r++) {
      var line = getLine(r);
      if (isRegionStart(line)) depth++;
      else if (isRegionEnd(line) && --depth === 0) return r;
    }
    return -1;
  }

  // A fold mode that answers for matched `#region` lines and defers every other
  // question to `base`. Built on a prototype link, so whatever else ACE asks of
  // a fold mode (indentation ranges, comment blocks, ...) still reaches base,
  // and base itself is not modified.
  function wrapFoldMode(base, Range) {
    var mode = Object.create(base);
    var endOf = function(session, row) {
      return findRegionEnd(function(r) { return session.getLine(r); }, session.getLength(), row);
    };

    mode.getFoldWidget = function(session, foldStyle, row) {
      if (endOf(session, row) !== -1) return 'start';
      return base.getFoldWidget.apply(base, arguments);
    };

    // Fold from the end of the `#region` line through the `#endregion` line,
    // as Monaco does: the label stays visible, the closing marker goes too.
    mode.getFoldWidgetRange = function(session, foldStyle, row) {
      var end = endOf(session, row);
      if (end !== -1) {
        return new Range(row, session.getLine(row).length, end, session.getLine(end).length);
      }
      return base.getFoldWidgetRange.apply(base, arguments);
    };

    return mode;
  }

  return {
    isRegionStart : isRegionStart,
    isRegionEnd   : isRegionEnd,
    findRegionEnd : findRegionEnd,
    wrapFoldMode  : wrapFoldMode
  };
});
