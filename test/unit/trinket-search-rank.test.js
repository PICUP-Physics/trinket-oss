'use strict';
const s = require('../../lib/util/trinketSearch');

const d = (iso) => new Date(iso);
const ts = (iso) => ({ toDate: () => new Date(iso) });   // Firestore Timestamp shape

describe('trinketSearch.normalize', () => {
  it('trims and lower-cases', () => {
    expect(s.normalize('  Pend ')).toBe('pend');
  });
  it('returns "" for terms under 2 characters, blanks and non-strings', () => {
    expect(s.normalize('a')).toBe('');
    expect(s.normalize('  a  ')).toBe('');
    expect(s.normalize('   ')).toBe('');
    expect(s.normalize(undefined)).toBe('');
    expect(s.normalize(42)).toBe('');
  });
});

describe('trinketSearch.matches', () => {
  it('matches name or description, case-insensitively', () => {
    expect(s.matches({ name: 'Pendulum' }, 'pend')).toBe(true);
    expect(s.matches({ name: 'x', description: 'A PENDULUM lab' }, 'pend')).toBe(true);
    expect(s.matches({ name: 'Wave' }, 'pend')).toBe(false);
  });
  it('treats regex characters literally', () => {
    expect(s.matches({ name: 'a.b test' }, 'a.b')).toBe(true);
    expect(s.matches({ name: 'axb test' }, 'a.b')).toBe(false);
    expect(s.matches({ name: 'f(x) plot' }, 'f(')).toBe(true);
  });
  it('tolerates missing name and description', () => {
    expect(s.matches({}, 'pend')).toBe(false);
    expect(s.matches({ name: null, description: 'pendulum' }, 'pend')).toBe(true);
  });
});

describe('trinketSearch.rank', () => {
  it('orders by group: name prefix, then name contains, then description only', () => {
    const out = s.rank([
      { name: 'Lab notes', description: 'pendulum', shortCode: 'c' },
      { name: 'Big pendulum', shortCode: 'b' },
      { name: 'Pendulum', shortCode: 'a' },
      { name: 'Wave', shortCode: 'z' }
    ], 'pend');
    expect(out.map((t) => t.shortCode)).toEqual(['a', 'b', 'c']);
  });
  it('orders by lastUpdated descending within a group, missing dates last', () => {
    const out = s.rank([
      { name: 'Pend old', lastUpdated: d('2025-01-01'), shortCode: 'old' },
      { name: 'Pend none', shortCode: 'none' },
      { name: 'Pend new', lastUpdated: ts('2026-10-01'), shortCode: 'new' }
    ], 'pend');
    expect(out.map((t) => t.shortCode)).toEqual(['new', 'old', 'none']);
  });
  it('breaks ties by lower-cased name, then shortCode', () => {
    const same = d('2026-01-01');
    const out = s.rank([
      { name: 'pend B', lastUpdated: same, shortCode: '2' },
      { name: 'Pend a', lastUpdated: same, shortCode: '9' },
      { name: 'pend B', lastUpdated: same, shortCode: '1' }
    ], 'pend');
    expect(out.map((t) => t.shortCode)).toEqual(['9', '1', '2']);
  });
  it('ranks an unnamed description match in group 2 without throwing', () => {
    const out = s.rank([{ name: null, description: 'pendulum', shortCode: 'u' }, { name: 'Pendulum', shortCode: 'p' }], 'pend');
    expect(out.map((t) => t.shortCode)).toEqual(['p', 'u']);
  });
  it('does not mutate its input', () => {
    const input = [{ name: 'b pend', shortCode: 'b' }, { name: 'pend a', shortCode: 'a' }];
    s.rank(input, 'pend');
    expect(input.map((t) => t.shortCode)).toEqual(['b', 'a']);
  });
});
