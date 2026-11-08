'use strict';
const flow = require('../../helpers/flow.cjs');
beforeEach(() => { flow.cookies = {}; });

async function make(name) {
  await flow.createTrinket();
  const id = flow.lastResponse.body.data.id;
  await flow.put('/api/trinkets/' + id + '/name', { name });
  return id;
}

describe('GET /api/trinkets filtering', () => {
  it('filters by name substring (case-insensitive)', async () => {
    await flow.switchUser('user');
    await make('Pendulum Lab');
    await make('Wave Demo');

    await flow.get('/api/trinkets?scope=all&name=pend');
    const names = flow.lastResponse.body.data.map((t) => t.name);
    expect(names).toContain('Pendulum Lab');
    expect(names).not.toContain('Wave Demo');
  });

  it('filters by updatedAfter / updatedBefore range (inclusive of the before-day)', async () => {
    await flow.switchUser('user');
    const id = await make('Ranged');
    const day = 86400000;
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const yesterday = iso(Date.now() - day);
    const tomorrow  = iso(Date.now() + day);

    // within [yesterday, tomorrow] → present
    await flow.get('/api/trinkets?scope=all&updatedAfter=' + yesterday + '&updatedBefore=' + tomorrow);
    expect(flow.lastResponse.body.data.map((t) => String(t.id))).toContain(String(id));

    // starts after tomorrow → excluded
    await flow.get('/api/trinkets?scope=all&updatedAfter=' + tomorrow);
    expect(flow.lastResponse.body.data.map((t) => String(t.id))).not.toContain(String(id));

    // ends before yesterday → excluded
    await flow.get('/api/trinkets?scope=all&updatedBefore=' + yesterday);
    expect(flow.lastResponse.body.data.map((t) => String(t.id))).not.toContain(String(id));
  });

  it('scope=all returns foldered trinkets; scope=root (default) does not', async () => {
    await flow.switchUser('user');
    const id = await make('In A Folder');
    await flow.post('/api/folders', { name: 'F' });
    await flow.get('/api/folders');
    const folderId = flow.lastResponse.body.data.find((f) => f.name === 'F').id;
    await flow.post('/api/trinkets/bulk', { action: 'move', ids: [id], folderId });

    await flow.get('/api/trinkets');                // default scope = root
    expect(flow.lastResponse.body.data.map((t) => String(t.id))).not.toContain(String(id));

    await flow.get('/api/trinkets?scope=all');
    expect(flow.lastResponse.body.data.map((t) => String(t.id))).toContain(String(id));
  });
});

describe('GET /api/trinkets q + relevance', () => {
  async function makeD(name, description) {
    const id = await make(name);
    if (description) await flow.put('/api/trinkets/' + id + '/description', { description });
    return id;
  }

  it('q matches name or description', async () => {
    await flow.switchUser('user');
    const tag = 'lq' + Date.now().toString(36);
    await makeD('Notes ' + Date.now(), 'about ' + tag);
    await makeD(tag + ' lab');
    await makeD('Unrelated');

    await flow.get('/api/trinkets?scope=all&q=' + tag);
    expect(flow.lastResponse.body.data).toHaveLength(2);
  });

  it('q and name combine by AND; name stays name-only', async () => {
    await flow.switchUser('user');
    const tag = 'la' + Date.now().toString(36);
    await makeD('Pendulum', 'about ' + tag);
    await makeD('Wave', 'about ' + tag);

    await flow.get('/api/trinkets?scope=all&q=' + tag + '&name=pend');
    expect(flow.lastResponse.body.data.map((t) => t.name)).toEqual(['Pendulum']);

    await flow.get('/api/trinkets?scope=all&name=' + tag);   // description isn't searched by name=
    expect(flow.lastResponse.body.data).toHaveLength(0);
  });

  it('sort=relevance pages by offset with no gaps or repeats, ignoring a stale from', async () => {
    await flow.switchUser('user');
    const tag = 'lr' + Date.now().toString(36);
    for (let i = 0; i < 7; i++) await makeD('X ' + tag + ' ' + i);
    await makeD(tag + ' first');

    const seen = [];
    for (let offset = 0; offset < 8; offset += 3) {
      await flow.get('/api/trinkets?scope=all&q=' + tag + '&sort=relevance&limit=3&offset=' + offset + '&from=zzz');
      expect(flow.lastResponse.statusCode).toBe(200);
      seen.push(...flow.lastResponse.body.data.map((t) => String(t.id)));
      if (offset === 0) expect(flow.lastResponse.body.data[0].name).toBe(tag + ' first');
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it('relevance without q, and an unknown sort, fall back instead of failing', async () => {
    await flow.switchUser('user');
    await makeD('Fallback ' + Date.now());

    await flow.get('/api/trinkets?scope=all&sort=relevance');
    expect(flow.lastResponse.statusCode).toBe(200);
    await flow.get('/api/trinkets?scope=all&sort=bogus');
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(flow.lastResponse.body.data.length).toBeGreaterThan(0);
  });

  it('a sort named like an Object property (toString, __proto__) falls back like any unknown sort', async () => {
    await flow.switchUser('user');
    const tag = 'lp' + Date.now().toString(36);
    for (const n of ['c', 'a', 'b']) await makeD(tag + ' ' + n);

    const ids = async (sort) => {
      // With a `from` cursor an unresolved sort key filtered out every row.
      await flow.get('/api/trinkets?scope=all&name=' + tag + '&sort=' + sort + '&from=2099-01-01');
      expect(flow.lastResponse.statusCode).toBe(200);
      return flow.lastResponse.body.data.map((t) => String(t.id));
    };
    const fallback = await ids('bogus');
    expect(fallback).toHaveLength(3);
    expect(await ids('toString')).toEqual(fallback);
    expect(await ids('__proto__')).toEqual(fallback);
  });

  it('a 1-character q is ignored (the list is not narrowed)', async () => {
    await flow.switchUser('user');
    const tag = 'l1' + Date.now().toString(36);
    await makeD(tag + ' alpha');
    await makeD(tag + ' beta');
    // The Firestore emulator is shared across files, so scope by a unique name.
    await flow.get('/api/trinkets?scope=all&name=' + tag + '&q=a');
    expect(flow.lastResponse.body.data).toHaveLength(2);
  });
});
