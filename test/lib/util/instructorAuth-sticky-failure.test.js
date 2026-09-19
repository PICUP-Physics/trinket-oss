'use strict';
const instructorAuth = require('../../../lib/util/instructorAuth');

// A deploy whose service account cannot read the cross-project 'instructormi'
// Datastore (e.g. the mandi-shaped trial) logged a PERMISSION_DENIED on EVERY
// login and every LTI launch, because the lookup is retried per call and the
// error is never cached. The answer is already correct — isApprovedInstructor
// fails CLOSED — but the noise hides real errors and the query is pure waste.
//
// A permission/auth failure is a misconfiguration, not a blip: it cannot heal
// on its own. Note it once, disable the provider, and keep failing closed.
// A TRANSIENT error (unavailable, deadline) must NOT disable anything.

function fakeDs(behaviour) {
  const calls = { runQuery: 0 };
  const q = { filter() { return q; }, limit() { return q; } };
  return {
    calls,
    createQuery() { return q; },
    runQuery() { calls.runQuery += 1; return behaviour(); }
  };
}
const gErr = (code, msg) => Object.assign(new Error(msg), { code });

describe('instructorAuth — permanent Datastore failures are sticky', () => {
  afterEach(() => { instructorAuth._setDatastore(null); vi.restoreAllMocks(); });

  it('stops querying after PERMISSION_DENIED, and still fails closed', async () => {
    const ds = fakeDs(() => Promise.reject(gErr(7, 'Missing or insufficient permissions.')));
    instructorAuth._setDatastore(ds);

    expect(await instructorAuth.isApprovedInstructor('first@example.com')).toBe(false);
    const afterFirst = ds.calls.runQuery;
    expect(afterFirst).toBeGreaterThan(0);

    expect(await instructorAuth.isApprovedInstructor('second@example.com')).toBe(false);
    expect(ds.calls.runQuery).toBe(afterFirst);   // no further round trips
  });

  it('stops querying after UNAUTHENTICATED too', async () => {
    const ds = fakeDs(() => Promise.reject(gErr(16, 'Request had invalid authentication credentials.')));
    instructorAuth._setDatastore(ds);

    await instructorAuth.isApprovedInstructor('a@example.com');
    const afterFirst = ds.calls.runQuery;
    await instructorAuth.isApprovedInstructor('b@example.com');
    expect(ds.calls.runQuery).toBe(afterFirst);
  });

  it('logs the permanent failure once, not per call', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ds = fakeDs(() => Promise.reject(gErr(7, 'Missing or insufficient permissions.')));
    instructorAuth._setDatastore(ds);

    await instructorAuth.isApprovedInstructor('one@example.com');
    await instructorAuth.isApprovedInstructor('two@example.com');
    await instructorAuth.isApprovedInstructor('three@example.com');

    expect(spy.mock.calls.length).toBe(1);
  });

  it('does NOT disable on a transient error — keeps querying', async () => {
    const ds = fakeDs(() => Promise.reject(gErr(14, 'Service unavailable.')));
    instructorAuth._setDatastore(ds);

    expect(await instructorAuth.isApprovedInstructor('x@example.com')).toBe(false);
    const afterFirst = ds.calls.runQuery;
    expect(await instructorAuth.isApprovedInstructor('y@example.com')).toBe(false);
    expect(ds.calls.runQuery).toBeGreaterThan(afterFirst);
  });

  it('getInstructorRecord also stops after a permanent failure', async () => {
    const ds = fakeDs(() => Promise.reject(gErr(7, 'Missing or insufficient permissions.')));
    instructorAuth._setDatastore(ds);

    expect(await instructorAuth.getInstructorRecord('rec@example.com')).toBe(null);
    const afterFirst = ds.calls.runQuery;
    expect(await instructorAuth.getInstructorRecord('rec2@example.com')).toBe(null);
    expect(ds.calls.runQuery).toBe(afterFirst);
  });
});
