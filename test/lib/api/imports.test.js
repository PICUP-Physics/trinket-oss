'use strict';

// Trinket-import ownership: the legacyShortCode dedup must be scoped PER
// IMPORTING USER. Found live on the merge trial (2026-07-06): a second user
// importing the same course zip got a course wired to the FIRST user's
// trinkets and owned nothing ("All my trinkets" empty). The import code's
// own comment states the intent: "Trinkets are owned by the importing user
// regardless of original ownership, making the import fully self-contained."

const JSZip = require('jszip');
const flow  = require('../../helpers/flow.cjs');

const CODE_A = 'print("original")';

function buildZip(code) {
  const zip = new JSZip();
  const sc  = 'abc123def0';
  zip.file('manifest.json', JSON.stringify({ trinkets: [{ shortCode: sc, lang: 'python3' }] }));
  const dir = 'python3/Imported_One_' + sc + '/';
  zip.file(dir + 'metadata.json', JSON.stringify({
    name: 'Imported One', description: 'from test zip', lang: 'python3'
  }));
  zip.file(dir + 'main.py', code || CODE_A);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function freshLogin(user) {
  delete flow.cookies[user];
  await flow.switchUser(user);
}

describe('Trinket import ownership (legacyShortCode scoping)', () => {
  it('imports a fresh copy for the first user', async () => {
    await freshLogin('user');
    const r = await flow.importTrinketsZip(await buildZip());
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);

    await flow.get('/api/trinkets');
    expect(flow.lastResponse.body.data.map((t) => t.name)).toContain('Imported One');
  });

  it('gives a SECOND importer their own copy instead of skipping', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildZip());

    await freshLogin('admin');
    const r = await flow.importTrinketsZip(await buildZip());
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);   // pre-fix: {imported: 0, skipped: 1}
    expect(r.body.data.skipped).toBe(0);

    await flow.get('/api/trinkets');
    expect(flow.lastResponse.body.data.map((t) => t.name)).toContain('Imported One');
  });

  it('replace re-imports only touch the importer\'s own copy', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildZip(CODE_A));

    // Second user re-imports the same shortCode with DIFFERENT code + replace.
    await freshLogin('admin');
    await flow.importTrinketsZip(await buildZip('print("attacker")'), { replace: true });

    // First user's copy must be untouched (pre-fix: cross-user overwrite).
    // User/Trinket are app-boot model globals, same as the other API tests.
    const owner = await new Promise((res, rej) =>
      User.findByLogin('test@dummy.com', (e, d) => (e ? rej(e) : res(d))));
    const mine = await Trinket.findByOwner(owner._id || owner.id);
    const copy = mine.filter((t) => t.legacyShortCode === 'abc123def0')[0];
    expect(copy).toBeTruthy();
    expect(copy.code).toBe(CODE_A);
  });
});

// Deleting a trinket is a soft delete (deletedAt is stamped, the row stays with
// its legacyShortCode intact). The import dedup must therefore ignore deleted
// copies, or "delete everything and re-import" — the natural way to start over —
// silently restores nothing. Reported live on picup (2026-07-16): a user deleted
// all 80 trinkets, re-imported, and got "0 imported, 16 skipped".
describe('Trinket import after delete (soft-delete dedup)', () => {
  async function myCopies(shortCode) {
    const owner = await new Promise((res, rej) =>
      User.findByLogin('test@dummy.com', (e, d) => (e ? rej(e) : res(d))));
    const all = await Trinket.findByOwner(owner._id || owner.id);
    return all.filter((t) => t.legacyShortCode === shortCode);
  }

  it('re-imports a trinket the user has deleted', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildZip());

    await flow.get('/api/trinkets');
    const mine = flow.lastResponse.body.data.filter((t) => t.name === 'Imported One');
    expect(mine).toHaveLength(1);

    const del = await flow.del('/api/trinkets/' + (mine[0].id || mine[0]._id));
    expect(del.statusCode).toBe(200);

    await flow.get('/api/trinkets');
    expect(flow.lastResponse.body.data.map((t) => t.name)).not.toContain('Imported One');

    // The deleted copy must not count as "already imported".
    const r = await flow.importTrinketsZip(await buildZip());
    expect(r.statusCode).toBe(200);
    expect(r.body.data.imported).toBe(1);   // pre-fix: {imported: 0, skipped: 1}
    expect(r.body.data.skipped).toBe(0);

    // ...and it comes back in the user's collection.
    await flow.get('/api/trinkets');
    expect(flow.lastResponse.body.data.map((t) => t.name)).toContain('Imported One');
  });

  it('leaves the deleted copy deleted rather than resurrecting it', async () => {
    await freshLogin('user');
    await flow.importTrinketsZip(await buildZip(CODE_A));

    await flow.get('/api/trinkets');
    const first = flow.lastResponse.body.data.filter((t) => t.name === 'Imported One')[0];
    await flow.del('/api/trinkets/' + (first.id || first._id));

    await flow.importTrinketsZip(await buildZip('print("second import")'));

    // A fresh row is created; the old one keeps its deletedAt stamp. Re-import is
    // not an undelete — the user asked for a clean copy, not their old one back.
    const copies = await myCopies('abc123def0');
    expect(copies).toHaveLength(1);
    expect(copies[0].code).toBe('print("second import")');
  });
});
