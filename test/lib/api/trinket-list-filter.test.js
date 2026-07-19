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
