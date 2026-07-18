'use strict';

// POST /api/trinkets/bulk — batch delete/move with a per-id ownership gate.
// Ownership is enforced by intersecting the requested ids with the caller's own
// live trinkets (Trinket.findByOwner), so a foreign or unknown id is never acted
// on. Delete is soft (deletedAt), matching the single-item delete.

const flow = require('../../helpers/flow.cjs');

beforeEach(() => { flow.cookies = {}; });

async function makeTrinkets(n) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    await flow.createTrinket();
    ids.push(flow.lastResponse.body.data.id);
  }
  return ids;
}

async function liveIds(user) {
  const owner = await new Promise((res, rej) =>
    User.findByLogin(user, (e, d) => (e ? rej(e) : res(d))));
  const live = await Trinket.findByOwner(owner._id || owner.id);
  return live.map((t) => String(t._id));
}

describe('POST /api/trinkets/bulk — delete', () => {
  it('soft-deletes exactly the given ids', async () => {
    await flow.switchUser('user');
    const ids = await makeTrinkets(3);

    const r = await flow.post('/api/trinkets/bulk', { action: 'delete', ids: [ids[0], ids[1]] });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.ok.sort()).toEqual([ids[0], ids[1]].sort());
    expect(r.body.data.failed).toEqual([]);

    const remaining = await liveIds('test@dummy.com');
    expect(remaining).toContain(ids[2]);
    expect(remaining).not.toContain(ids[0]);
    expect(remaining).not.toContain(ids[1]);
  });

  it('routes a foreign id to failed and never deletes it', async () => {
    await flow.switchUser('admin');
    const foreign = (await makeTrinkets(1))[0];

    await flow.switchUser('user');
    const mine = (await makeTrinkets(1))[0];

    const r = await flow.post('/api/trinkets/bulk', { action: 'delete', ids: [mine, foreign] });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.ok).toEqual([mine]);
    expect(r.body.data.failed).toEqual([{ id: foreign, reason: 'not-owned' }]);

    // The foreign trinket is still live for its real owner.
    expect(await liveIds('admin@example.com')).toContain(foreign);
  });
});
