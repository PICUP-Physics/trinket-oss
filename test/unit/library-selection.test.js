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

describe('select-all over a matching set', () => {
  it('selects every matching id, not just a page', () => {
    const s = sel.create();
    const matching = ['a', 'b', 'c', 'd', 'e'];   // full filtered set, all pages
    sel.selectAll(s, matching);
    expect(sel.count(s)).toBe(5);
  });
  it('after a partial failure, only failed ids remain selected', () => {
    const s = sel.create();
    sel.selectAll(s, ['a', 'b', 'c']);
    const failedIds = ['c'];
    sel.ids(s).forEach(function(id) { if (failedIds.indexOf(id) === -1) sel.toggle(s, id); });
    expect(sel.ids(s)).toEqual(['c']);
  });
});

const fs = require('fs');
const path = require('path');
describe('library list markup', () => {
  const listHtml = () => fs.readFileSync(
    path.join(__dirname, '../../public/js/library/trinkets/list/list.html'), 'utf8');

  it('has a bulk bar gated on selection and Move/Delete actions', () => {
    const html = listHtml();
    expect(html).toContain('selectionCount()');
    expect(html).toMatch(/Move|move/);
    expect(html).toMatch(/Delete|delete/);
  });

  it('has a count-confirm delete dialog and a select-all-matching control', () => {
    const html = listHtml();
    expect(html).toContain('bulkDeleteDialog');
    expect(html).toContain('selectAllMatching');
  });

  it('offers "New folder" in the Move-to dropdown', () => {
    const html = listHtml();
    expect(html).toContain('bulkMoveToNewFolder');
  });

  it('has before/after date-range inputs behind a disclosure toggle', () => {
    const html = listHtml();
    expect(html).toContain('showFilters');                 // disclosure toggle
    expect(html).toContain('filters.updatedAfter');
    expect(html).toContain('filters.updatedBefore');
    expect(html).toMatch(/type="date"/);
  });

  it('surfaces the mod date when working by mod date', () => {
    const html = listHtml();
    expect(html).toContain('showModDate()');
    expect(html).toContain('Last updated');
  });
});
