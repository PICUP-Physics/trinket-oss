'use strict';
const fs = require('fs');
const path = require('path');
const s = require('../../public/js/library/trinkets/list/search-state.js');

const fresh = () => ({ filters: { name: '', scope: 'root' }, sortBy: '-lastUpdated', saved: null });

describe('library search state', () => {
  it('enter switches to all folders, relevance, and the term', () => {
    const st = s.enter(fresh(), 'pend');
    expect(st.filters.q).toBe('pend');
    expect(st.filters.scope).toBe('all');
    expect(st.sortBy).toBe('relevance');
  });
  it('leave restores the previous sort and scope', () => {
    const st = s.leave(s.enter(fresh(), 'pend'));
    expect(st.filters.q).toBeUndefined();
    expect(st.filters.scope).toBe('root');
    expect(st.sortBy).toBe('-lastUpdated');
    expect(st.saved).toBeNull();
  });
  it('a second See all keeps the original saved sort', () => {
    const st = s.leave(s.enter(s.enter(fresh(), 'pend'), 'wave'));
    expect(st.sortBy).toBe('-lastUpdated');
  });
  it('a sort picked while searching survives leaving', () => {
    const st = s.enter(fresh(), 'pend');
    st.sortBy = 'name';
    expect(s.leave(st).sortBy).toBe('name');
  });
  it('never persists relevance', () => {
    expect(s.persistableSort('relevance', { sortBy: '-lastUpdated' })).toBe('-lastUpdated');
    expect(s.persistableSort('relevance', null)).toBe('-lastView.viewedOn');
    expect(s.persistableSort('name', null)).toBe('name');
  });
});

describe('library list wiring', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
  it('list.html shows a removable search chip', () => {
    const html = read('public/js/library/trinkets/list/list.html');
    expect(html).toContain('filters.q');
    expect(html).toContain('clearSearch()');
    expect(html).toContain('(name or instructions)');
  });
  it('only the library list passes see-all', () => {
    expect(read('public/js/library/trinkets/list/list.html')).toContain('see-all="onSeeAll"');
    for (const p of ['public/js/library/trinkets/list/folder.html',
                     'public/partials/assignment_editor.html',
                     'public/partials/material.html']) {
      expect(read(p)).not.toContain('see-all=');
    }
  });
  it('the controller sends q and never caches relevance', () => {
    const js = read('public/js/library/trinkets/list/list-controller.js');
    expect(js).toContain('params.q');
    expect(js).toContain('persistableSort');
  });
  it('search-state.js is loaded before list-controller.js', () => {
    const lines = read('config/default.yaml').split('\n');
    const i = lines.findIndex((l) => l.includes("'/js/library/trinkets/list/list-controller.js'"));
    expect(lines.slice(0, i).some((l) => l.includes("'/js/library/trinkets/list/search-state.js'"))).toBe(true);
  });
});

describe('See all clears other filters (review #2)', () => {
  const withFilters = () => ({
    filters: { name: 'pend', updatedWithin: '30d', updatedAfter: '2026-01-01', updatedBefore: '2026-02-01', scope: 'root' },
    sortBy: 'name', saved: null
  });
  it('enter clears name and date filters, so the list shows every match the dropdown counted', () => {
    const st = s.enter(withFilters(), 'wave');
    expect(st.filters.name).toBe('');
    expect(st.filters.updatedWithin).toBe('all');
    expect(st.filters.updatedAfter).toBe('');
    expect(st.filters.updatedBefore).toBe('');
  });
  it('leave puts them back', () => {
    const st = s.leave(s.enter(withFilters(), 'wave'));
    expect(st.filters).toEqual(withFilters().filters);
  });
});

describe('search survives leaving the list (review #1)', () => {
  it('carry returns an independent copy of filters and saved state', () => {
    const filters = { q: 'pend', scope: 'all', name: '' };
    const saved = { sortBy: '-lastUpdated', scope: 'root' };
    const c = s.carry(filters, saved);
    filters.q = 'changed'; saved.sortBy = 'name';
    expect(c.filters.q).toBe('pend');
    expect(c.saved.sortBy).toBe('-lastUpdated');
    expect(s.carry(filters, null).saved).toBeNull();
  });
  it('the controller stores filters on $destroy and restores them on load', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/library/trinkets/list/list-controller.js'), 'utf8');
    expect(js).toMatch(/libraryState\.listFilters\s*=\s*searchState\.carry\(/);
    expect(js).toMatch(/libraryState\.listFilters\s*&&/);
  });
});

// Copilot review on #346.
describe('a second See all after editing a filter', () => {
  it('clears the narrowing filters again, but leave restores the pre-search ones', () => {
    const st = s.enter({ filters: { name: 'orig', updatedWithin: 'all', updatedAfter: '', updatedBefore: '', scope: 'root' },
                         sortBy: 'name', saved: null }, 'pend');
    st.filters.name = 'narrow';
    st.filters.updatedWithin = '7d';
    s.enter(st, 'wave');
    expect(st.filters.name).toBe('');
    expect(st.filters.updatedWithin).toBe('all');
    s.leave(st);
    expect(st.filters.name).toBe('orig');
    expect(st.filters.updatedWithin).toBe('all');
  });
});

describe('carry keeps Date filters as Dates', () => {
  // The date inputs are type="date"; Angular throws ngModel:datefmt on a string.
  it('in the live filters and in the saved ones', () => {
    const after = new Date(2026, 0, 1), before = new Date(2026, 1, 1);
    const c = s.carry({ q: 'pend', updatedAfter: after, updatedBefore: '' },
                      { sortBy: 'name', scope: 'root', filters: { updatedBefore: before, updatedAfter: '' } });
    expect(c.filters.updatedAfter).toBeInstanceOf(Date);
    expect(c.filters.updatedAfter.getTime()).toBe(after.getTime());
    expect(c.filters.updatedAfter).not.toBe(after);           // still a copy
    expect(c.saved.filters.updatedBefore).toBeInstanceOf(Date);
    expect(c.saved.filters.updatedBefore.getTime()).toBe(before.getTime());
  });
});

describe('Back keeps the sort chosen during a search', () => {
  // The kept items and paging cursor were loaded in that sort; forcing
  // relevance on them makes later pages repeat or skip results.
  it('carry records the active sort and resumeSort returns it', () => {
    const c = s.carry({ q: 'pend' }, { sortBy: '-lastUpdated' }, 'name');
    expect(c.sortBy).toBe('name');
    expect(s.resumeSort(c)).toBe('name');
  });
  it('falls back to relevance when no sort was carried', () => {
    expect(s.resumeSort(s.carry({ q: 'pend' }, null))).toBe('relevance');
    expect(s.resumeSort(null)).toBe('relevance');
  });
  it('the controller carries $scope.sortBy and resumes it', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../public/js/library/trinkets/list/list-controller.js'), 'utf8');
    expect(js).toMatch(/searchState\.carry\(\$scope\.filters,\s*searchSaved,\s*\$scope\.sortBy\)/);
    expect(js).toMatch(/\$scope\.sortBy\s*=\s*searchState\.resumeSort\(/);
  });
});

describe('the chip clear action works from the keyboard', () => {
  it('is a link with an href, so it can be tabbed to and activated', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../public/js/library/trinkets/list/list.html'), 'utf8');
    expect(html).toMatch(/<a href="" ng-click="clearSearch\(\)"/);
  });
});
