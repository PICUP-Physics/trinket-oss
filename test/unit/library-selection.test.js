'use strict';
// Pure selection-model helpers used by the list controllers. Kept as plain
// functions so they are unit-testable without an Angular/DOM harness (none
// exists in this repo).
const sel = require('../../public/js/library/trinkets/list/selection-model.js');

describe('selection model', () => {
  it('toggles ids on and off', () => {
    const s = sel.create();
    sel.toggle(s, 'a'); sel.toggle(s, 'b'); sel.toggle(s, 'a');
    expect(sel.ids(s)).toEqual(['b']);
    expect(sel.count(s)).toBe(1);
  });
  it('selectAll adds every id in the matching set; clear empties it', () => {
    const s = sel.create();
    sel.selectAll(s, ['a', 'b', 'c']);
    expect(sel.count(s)).toBe(3);
    sel.clear(s);
    expect(sel.count(s)).toBe(0);
  });
});

const fs = require('fs');
const path = require('path');
describe('library list markup', () => {
  it('has a bulk bar gated on selection and Move/Delete actions', () => {
    const p = path.join(__dirname, '../../public/js/library/trinkets/list/list.html');
    const html = fs.readFileSync(p, 'utf8');
    expect(html).toContain('selectionCount()');
    expect(html).toMatch(/Move|move/);
    expect(html).toMatch(/Delete|delete/);
  });
});
