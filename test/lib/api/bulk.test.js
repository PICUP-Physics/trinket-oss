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

describe('POST /api/trinkets/bulk — move', () => {
  async function makeFolder(name) {
    await flow.post('/api/folders', { name });
    await flow.get('/api/folders');
    const f = flow.lastResponse.body.data.find((x) => x.name === name);
    expect(f).toBeTruthy();
    return f.id || f._id;
  }

  // Read a trinket's current folder straight from the model. (scope=all — the
  // list-based read-back — lands in Task 3; a direct read keeps this task
  // self-contained and asserts the same thing: folder set/cleared.)
  async function folderIdOf(user, id) {
    const owner = await new Promise((res, rej) =>
      User.findByLogin(user, (e, d) => (e ? rej(e) : res(d))));
    const live = await Trinket.findByOwner(owner._id || owner.id);
    const t = live.find((x) => String(x._id) === String(id));
    return t && t.folder && t.folder.folderId ? String(t.folder.folderId) : null;
  }

  it('moves the given trinkets into a folder', async () => {
    await flow.switchUser('user');
    const ids = await makeTrinkets(2);
    const folderId = await makeFolder('Fall2024');

    const r = await flow.post('/api/trinkets/bulk', { action: 'move', ids, folderId });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.ok.sort()).toEqual(ids.slice().sort());
    expect(r.body.data.failed).toEqual([]);

    expect(await folderIdOf('test@dummy.com', ids[0])).toBe(String(folderId));
    expect(await folderIdOf('test@dummy.com', ids[1])).toBe(String(folderId));
  });

  it('removes trinkets from their folder when folderId is null', async () => {
    await flow.switchUser('user');
    const ids = await makeTrinkets(1);
    const folderId = await makeFolder('Temp');
    await flow.post('/api/trinkets/bulk', { action: 'move', ids, folderId });
    expect(await folderIdOf('test@dummy.com', ids[0])).toBe(String(folderId));

    const r = await flow.post('/api/trinkets/bulk', { action: 'move', ids, folderId: null });
    expect(r.body.data.ok).toEqual(ids);
    expect(await folderIdOf('test@dummy.com', ids[0])).toBe(null);
  });

  it('fails the whole move when the target folder is not the caller\'s', async () => {
    await flow.switchUser('admin');
    const foreignFolder = await makeFolder('AdminFolder');

    await flow.switchUser('user');
    const ids = await makeTrinkets(1);
    const r = await flow.post('/api/trinkets/bulk', { action: 'move', ids, folderId: foreignFolder });
    expect(r.body.data.ok).toEqual([]);
    expect(r.body.data.failed).toEqual([{ id: ids[0], reason: 'folder-not-found' }]);
  });
});
