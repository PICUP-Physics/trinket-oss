const { pull, serialize } = require('../../lib/util/objectUtils');

describe('objectUtils.pull', () => {
  it('copies fields flagged true/1', () => {
    expect(pull({ a: true, b: 1 }, { a: 'x', b: 'y', c: 'z' })).toEqual({ a: 'x', b: 'y' });
  });

  it('renames via a string mapping', () => {
    expect(pull({ name: 'fullName' }, { fullName: 'Ada' })).toEqual({ name: 'Ada' });
  });

  it('recurses into nested object specs', () => {
    expect(pull({ owner: { id: true } }, { owner: { id: 7, secret: 'no' } }))
      .toEqual({ owner: { id: 7 } });
  });

  it('throws on an unrecognized field spec', () => {
    expect(() => pull({ a: 99 }, { a: 1 })).toThrow(/unrecognized field value/);
  });
});

describe('objectUtils.serialize', () => {
  it('returns primitives unchanged', () => {
    expect(serialize(42)).toBe(42);
  });

  it('calls .serialize() when present', () => {
    expect(serialize({ serialize: () => 'custom' })).toBe('custom');
  });

  it('drops null/undefined keys and deep-serializes the rest', () => {
    expect(serialize({ a: 1, b: null, c: undefined, d: { e: 2 } }))
      .toEqual({ a: 1, d: { e: 2 } });
  });
});
