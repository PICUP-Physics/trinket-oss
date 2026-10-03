'use strict';
// #330: fold between `#region` and `#endregion` comments, the convention Monaco
// and VS Code use. The matching is pure, so it is tested here without ACE; the
// browser spec (specs-deploy/region-fold.spec.js) proves the editor uses it.
const { isRegionStart, isRegionEnd, findRegionEnd, wrapFoldMode } =
  require('../../public/js/plugins/region-fold.js');

const lines = (src) => src.split('\n');
const endOf = (src, row) => {
  const ls = lines(src);
  return findRegionEnd((r) => ls[r], ls.length, row);
};

describe('region markers', () => {
  it('recognises #region and #endregion, with or without a label', () => {
    expect(isRegionStart('#region')).toBe(true);
    expect(isRegionStart('#region setup')).toBe(true);
    expect(isRegionEnd('#endregion')).toBe(true);
    expect(isRegionEnd('#endregion setup')).toBe(true);
  });

  it('accepts a space after the #, and indentation', () => {
    expect(isRegionStart('# region physics')).toBe(true);
    expect(isRegionStart('    #region inner')).toBe(true);
    expect(isRegionEnd('    # endregion')).toBe(true);
  });

  it('ignores words that only start with the marker, and markers after code', () => {
    expect(isRegionStart('#regional data')).toBe(false);
    expect(isRegionEnd('#endregions')).toBe(false);
    expect(isRegionStart('x = 1  #region')).toBe(false);
    expect(isRegionStart('# a region of space')).toBe(false);
  });

  it('is case-sensitive, as Monaco and VS Code are', () => {
    expect(isRegionStart('#Region')).toBe(false);
  });
});

describe('findRegionEnd', () => {
  it('finds the matching #endregion', () => {
    expect(endOf('#region setup\na = 1\nb = 2\n#endregion\nc = 3', 0)).toBe(3);
  });

  it('pairs nested regions correctly', () => {
    const src = '#region outer\n#region inner\nx = 1\n#endregion\ny = 2\n#endregion';
    expect(endOf(src, 0)).toBe(5);
    expect(endOf(src, 1)).toBe(3);
  });

  it('returns -1 for a #region with no matching end', () => {
    expect(endOf('#region setup\na = 1\n', 0)).toBe(-1);
    expect(endOf('#region a\n#region b\n#endregion', 0)).toBe(-1);
  });

  it('returns -1 for a line that does not start a region', () => {
    expect(endOf('a = 1\n#endregion', 0)).toBe(-1);
  });
});

describe('wrapFoldMode', () => {
  // A stand-in for ACE's session and Range: just enough surface to exercise
  // the wrapper the way ACE calls it.
  function session(src) {
    const ls = lines(src);
    return { getLine: (r) => ls[r], getLength: () => ls.length };
  }
  function Range(sr, sc, er, ec) {
    this.start = { row: sr, column: sc };
    this.end = { row: er, column: ec };
  }
  const base = {
    getFoldWidget: () => 'base-widget',
    getFoldWidgetRange: () => 'base-range',
  };

  it('puts a start widget on a matched #region line', () => {
    const mode = wrapFoldMode(base, Range);
    expect(mode.getFoldWidget(session('#region s\na = 1\n#endregion'), 'markbegin', 0)).toBe('start');
  });

  it('folds from the end of the #region line through the #endregion line, as Monaco does', () => {
    const mode = wrapFoldMode(base, Range);
    const r = mode.getFoldWidgetRange(session('#region s\na = 1\n#endregion'), 'markbegin', 0);
    expect(r.start).toEqual({ row: 0, column: 9 });
    expect(r.end).toEqual({ row: 2, column: 10 });
  });

  it('leaves every other line to the base fold mode, so colon folds keep working', () => {
    const mode = wrapFoldMode(base, Range);
    const s = session('def f():\n    return 1');
    expect(mode.getFoldWidget(s, 'markbegin', 0)).toBe('base-widget');
    expect(mode.getFoldWidgetRange(s, 'markbegin', 0)).toBe('base-range');
  });

  it('gives an unmatched #region to the base mode instead of a widget that folds nothing', () => {
    const mode = wrapFoldMode(base, Range);
    expect(mode.getFoldWidget(session('#region s\na = 1'), 'markbegin', 0)).toBe('base-widget');
  });

  it('keeps the base mode itself unchanged', () => {
    wrapFoldMode(base, Range);
    expect(base.getFoldWidget()).toBe('base-widget');
  });
});
