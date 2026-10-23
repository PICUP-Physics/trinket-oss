'use strict';
const flow = require('../../helpers/flow.cjs');
const Trinket = require('../../../lib/models/trinket');
beforeEach(() => { flow.cookies = {}; });
afterEach(() => { vi.restoreAllMocks(); });

async function make(name, description) {
  await flow.createTrinket();
  const id = flow.lastResponse.body.data.id;
  await flow.put('/api/trinkets/' + id + '/name', { name });
  if (description) await flow.put('/api/trinkets/' + id + '/description', { description });
  return id;
}

describe('GET /api/trinkets/search', () => {
  it('returns at most 20, ranked, with the total of all matches', async () => {
    await flow.switchUser('user');
    const tag = 'zq' + Date.now().toString(36);
    for (let i = 0; i < 24; i++) await make('Other ' + tag + ' ' + i);
    await make(tag + ' prefix');
    await make('Notes', 'about ' + tag);

    await flow.get('/api/trinkets/search?q=' + tag);
    const body = flow.lastResponse.body;
    expect(body.total).toBe(26);
    expect(body.limit).toBe(20);
    expect(body.data).toHaveLength(20);
    expect(body.data[0].name).toBe(tag + ' prefix');
    // id: the folder view (addToFolder) and assignment editor (trinketId) need it.
    expect(Object.keys(body.data[0]).sort()).toEqual(['id', 'lang', 'name', 'shortCode', 'snapshot']);
    expect(body.data[0].id).toBeTruthy();
  });

  it('includes description-only matches after name matches', async () => {
    await flow.switchUser('user');
    const tag = 'zd' + Date.now().toString(36);
    await make('Notes', 'see ' + tag);
    await make('A ' + tag + ' lab');

    await flow.get('/api/trinkets/search?q=' + tag);
    expect(flow.lastResponse.body.data.map((t) => t.name)).toEqual(['A ' + tag + ' lab', 'Notes']);
  });

  it('answers a short or blank term with an empty result and no database read', async () => {
    await flow.switchUser('user');
    const find = vi.spyOn(Trinket.model, 'find');

    await flow.get('/api/trinkets/search?q=p');
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(flow.lastResponse.body.data).toEqual([]);
    expect(flow.lastResponse.body.total).toBe(0);

    await flow.get('/api/trinkets/search?q=%20%20');
    expect(flow.lastResponse.body.total).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });

  it('trims a padded term', async () => {
    await flow.switchUser('user');
    const tag = 'zp' + Date.now().toString(36);
    await make(tag + ' padded');
    await flow.get('/api/trinkets/search?q=%20%20' + tag + '%20');
    expect(flow.lastResponse.body.total).toBe(1);
  });

  it('never returns deleted trinkets or another user\'s trinkets', async () => {
    await flow.switchUser('user');
    const tag = 'zx' + Date.now().toString(36);
    const gone = await make(tag + ' deleted');
    await flow.post('/api/trinkets/bulk', { action: 'delete', ids: [gone] });

    await flow.switchUser('user2');
    await make(tag + ' theirs');

    await flow.switchUser('user');
    await flow.get('/api/trinkets/search?q=' + tag);
    expect(flow.lastResponse.body.total).toBe(0);
  });
});
