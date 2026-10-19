'use strict';
const fs = require('fs');
const path = require('path');
const r = require('../../public/partials/directives/trinket-search-results.js');

const items = (n) => Array.from({ length: n }, (_, i) => ({ name: 'T' + i, shortCode: 's' + i }));

describe('trinketSearchResults.rows', () => {
  it('returns just the items when everything is shown', () => {
    const out = r.rows({ data: items(3), total: 3 }, { seeAll: true });
    expect(out).toHaveLength(3);
    expect(out.some((x) => x.__footer)).toBe(false);
  });
  it('adds a footer with the count when there are more matches', () => {
    const out = r.rows({ data: items(20), total: 143 }, {});
    expect(out).toHaveLength(21);
    expect(out[20]).toEqual({ __footer: true, text: 'Showing 20 of 143, best matches first', seeAllText: null });
  });
  it('adds the See-all text only when asked', () => {
    const out = r.rows({ data: items(20), total: 143 }, { seeAll: true });
    expect(out[20].seeAllText).toBe('See all 143 results');
  });
  it('names unnamed trinkets Untitled', () => {
    expect(r.rows({ data: [{ name: '' }, { name: null }], total: 2 }, {}).map((x) => x.name)).toEqual(['Untitled', 'Untitled']);
  });
  it('tolerates a missing body or total', () => {
    expect(r.rows(undefined, {})).toEqual([]);
    expect(r.rows({ data: items(2) }, {})).toHaveLength(2);
  });
});

describe('trinket-search markup', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

  it('waits for 2 characters and renders a footer row', () => {
    const html = read('public/partials/directives/trinket-search.html');
    expect(html).toContain('typeahead-min-length="2"');
    expect(html).toContain('match.model.__footer');
    expect(html).toContain('match.model.seeAllText');
  });
  it('the helper is loaded before the directive in every bundle that has it', () => {
    const yaml = read('config/default.yaml');
    const lines = yaml.split('\n');
    lines.forEach((line, i) => {
      if (line.includes("'/partials/directives/trinket-search.js'")) {
        expect(lines[i - 1]).toContain("'/partials/directives/trinket-search-results.js'");
      }
    });
  });
  it('the API client keeps total (does not use customGETLIST for search)', () => {
    const svc = read('public/js/library/components/trinkets/trinket-service.js');
    expect(svc).not.toContain('customGETLIST("search"');
    expect(svc).toContain("'/api/trinkets/search'");
  });
});

describe('course editor toolbar search', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
  it('uses the shared directive (isolated scope, trinketsApi), not toolbarControl.searchTrinkets', () => {
    expect(read('public/partials/material.html')).toMatch(/<trinket-search[^>]*toolbar="true"/);
    const dir = read('public/partials/directives/trinket-search.js');
    expect(dir).toMatch(/scope\s*:\s*\{/);          // isolated scope
    expect(dir).toContain('trinketsApi.search(');
  });
});

describe('selected results are usable by the folder and assignment views (review)', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
  it('the API client restangularizes search results so addToFolder exists', () => {
    expect(read('public/js/library/components/trinkets/trinket-service.js'))
      .toMatch(/restangularizeElement\(null, t, 'trinkets'\)/);
  });
});
