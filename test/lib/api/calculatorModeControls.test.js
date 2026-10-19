'use strict';

// Calculator mode (?runMode=calculator) is meant to be self-contained: what the
// student sees is what the trinket contains. Two controls survived it:
//
//  - Download. In Safe Exam Browser it saves a .zip of the exam code to the
//    machine's Downloads folder, where the next student to sit the exam on that
//    machine can find it (reported for PICUP prod, 2026-10-13).
//  - The account menu (#291): the guest Log In form, and for a signed-in
//    student the "View on trinket" and "My Trinkets" links into the library.
//
// Server-render checks, like examModePlainEditor.test.js: each one also checks
// the ordinary embed still has the control, so a renamed attribute can't make
// the calculator assertion pass vacuously.

const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

const DOWNLOAD   = /data-action="mode\.download"/;
const LOGIN_FORM = /id="accountForm"/;
const LIBRARY    = /href="\/library\/trinkets"/;

beforeEach(() => {
  flow.cookies = {};
});

async function createTrinket(lang, code) {
  await flow.switchUser('user');
  await flow.post('/api/trinkets', defaults.extend({ lang, code }, 'trinket'));
  expect(flow.lastResponse.statusCode).toBe(200);
  return flow.lastResponse.body.data;
}

async function embedPage(lang, id, query) {
  await flow.get('/embed/' + lang + '/' + id + (query ? '?' + query : ''));
  expect(flow.lastResponse.statusCode).toBe(200);
  return flow.lastResponse.text;
}

describe('calculator mode drops Download', () => {
  it('for a python3 trinket, which is otherwise downloadable', async () => {
    const t = await createTrinket('python3', 'print(1)\n');
    await flow.switchUser('');
    expect(await embedPage('python3', t.id)).toMatch(DOWNLOAD);
    expect(await embedPage('python3', t.id, 'runMode=calculator')).not.toMatch(DOWNLOAD);
  });

  it('for a signed-in student too', async () => {
    const t = await createTrinket('python3', 'print(1)\n');
    await flow.switchUser('user2');
    expect(await embedPage('python3', t.id, 'runMode=calculator')).not.toMatch(DOWNLOAD);
  });
});

describe('calculator mode drops the account menu (#291)', () => {
  it('no Log In form for a signed-out student', async () => {
    const t = await createTrinket('glowscript', 'GlowScript 3.2 VPython\nbox()\n');
    await flow.switchUser('');
    expect(await embedPage('glowscript', t.id)).toMatch(LOGIN_FORM);
    expect(await embedPage('glowscript', t.id, 'runMode=calculator')).not.toMatch(LOGIN_FORM);
  });

  it('no links into the library for a signed-in student', async () => {
    const t = await createTrinket('glowscript', 'GlowScript 3.2 VPython\nbox()\n');
    await flow.switchUser('user2');
    expect(await embedPage('glowscript', t.id)).toMatch(LIBRARY);
    expect(await embedPage('glowscript', t.id, 'runMode=calculator')).not.toMatch(LIBRARY);
  });

  it('on pyodide as well as glowscript', async () => {
    const t = await createTrinket('pyodide', 'print(1)\n');
    await flow.switchUser('user2');
    const html = await embedPage('pyodide', t.id, 'runMode=calculator');
    expect(html).not.toMatch(LIBRARY);
    expect(html).not.toMatch(LOGIN_FORM);
  });
});
