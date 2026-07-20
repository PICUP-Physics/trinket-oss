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

  // Regression for picup #58: a circular reference (e.g. a material/doc with a
  // back-reference) used to recurse forever -> "Maximum call stack size
  // exceeded", crashing the patchContent save via request.success.
  it('does not overflow on a circular reference (issue #58)', () => {
    const a = { name: 'mat', type: 'page' };
    a.self = a;
    expect(() => serialize({ material: a })).not.toThrow();
    const out = serialize({ material: a });
    expect(out.material.name).toBe('mat');        // real data preserved
    expect(out.material.self).toBeUndefined();    // the cycle is broken, not serialized
  });

  it('handles a deeper (ancestor) cycle without overflowing', () => {
    const root = { level: 1, child: { level: 2 } };
    root.child.back = root;                        // child -> root (cycle)
    expect(() => serialize(root)).not.toThrow();
    expect(serialize(root).child.level).toBe(2);
  });

  it('preserves shared (non-circular) references — a DAG is not a cycle', () => {
    const shared = { x: 1 };
    const out = serialize({ a: shared, b: shared });
    expect(out.a).toEqual({ x: 1 });
    expect(out.b).toEqual({ x: 1 });               // both kept; not dropped as a "cycle"
  });
});
