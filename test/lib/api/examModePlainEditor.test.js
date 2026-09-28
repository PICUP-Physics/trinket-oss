'use strict';

// Exam mode: a per-trinket switch (settings.plainEditor) that gives EVERY
// viewer of the trinket the plain-text editor instead of ACE — logged in or
// not, and on the student copies made from it. Written for Safe Exam Browser,
// where copy and paste inside ACE is unreliable; the plain editor is the same
// one the per-user "disable Ace" preference and the toolbar Accessibility
// toggle already switch to, so this only decides WHO gets it.
//
// Every editor type reads one switch at startup — window.userSettings.
// disableAceEditor — and every embed route renders through embed/base.html,
// so the server-render half below is the whole mechanism. That the plain
// editor then actually appears is the browser half (exam-mode.spec.js).
//
// Deliberately independent of calculator mode (?runMode=calculator): that is a
// URL choice about the layout, this is a stored choice about the editor, and
// the two combine.

const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const config   = require('config');
const Trinket  = require('../../../lib/models/trinket');
const { sanitizeSettings } = require('../../../lib/util/sanitizeSettings');

// The line base.html renders when the trinket is in exam mode. Asserting the
// exact statement (not just the substring "disableAceEditor") matters: the
// logged-in user's own settings JSON already contains "disableAceEditor":false.
const FORCED = /userSettings = Object\.assign\(\{\}, window\.userSettings, \{ disableAceEditor: true \}\);/;

beforeEach(() => {
  flow.cookies = {};
});

async function createTrinket(overrides) {
  await flow.post('/api/trinkets', defaults.extend(overrides || {}, 'trinket'));
  expect(flow.lastResponse.statusCode).toBe(200);
  return flow.lastResponse.body.data;
}

async function autosave(id, payload) {
  await flow.post('/api/trinkets/' + id + '/autosave', payload);
  expect(flow.lastResponse.statusCode).toBe(200);
}

async function getTrinket(id) {
  await flow.get('/api/trinkets/' + id);
  return flow.lastResponse.body.data;
}

async function embedPage(lang, id, query) {
  await flow.get('/embed/' + lang + '/' + id + (query ? '?' + query : ''));
  expect(flow.lastResponse.statusCode).toBe(200);
  return flow.lastResponse.text;
}

// A glowscript trinket owned by 'user', optionally already in exam mode.
async function glowscriptTrinket(plainEditor) {
  await flow.switchUser('user');
  const t = await createTrinket({ lang: 'glowscript', code: 'GlowScript 3.2 VPython\nbox()' });
  if (plainEditor) await autosave(t.id, { settings: { plainEditor: true } });
  return t;
}

describe('sanitizeSettings: plainEditor', () => {
  it('keeps a real boolean', () => {
    expect(sanitizeSettings({ plainEditor: true }).plainEditor).toBe(true);
    expect(sanitizeSettings({ plainEditor: false }).plainEditor).toBe(false);
  });

  it('reads the form-encoded "true"/"false" a flattened payload carries', () => {
    expect(sanitizeSettings({ plainEditor: 'true' }).plainEditor).toBe(true);
    expect(sanitizeSettings({ plainEditor: 'false' }).plainEditor).toBe(false);
  });

  it('turns anything else into false rather than storing it verbatim', () => {
    expect(sanitizeSettings({ plainEditor: 'yes please' }).plainEditor).toBe(false);
    expect(sanitizeSettings({ plainEditor: { $ne: null } }).plainEditor).toBe(false);
    expect(sanitizeSettings({ plainEditor: 1 }).plainEditor).toBe(false);
  });

  it('does not add the key when the caller did not send it', () => {
    expect(sanitizeSettings({ runtime: 'worker' })).not.toHaveProperty('plainEditor');
  });
});

describe('settings.plainEditor is stored per trinket', () => {
  it('defaults to off', async () => {
    const t = await glowscriptTrinket(false);
    expect((await getTrinket(t.id)).settings.plainEditor).toBe(false);
  });

  it('an autosave turns it on, and other settings survive', async () => {
    const t = await glowscriptTrinket(false);
    await autosave(t.id, { settings: { plainEditor: true, autofocusEnabled: false } });
    const s = (await getTrinket(t.id)).settings;
    expect(s.plainEditor).toBe(true);
    expect(s.autofocusEnabled).toBe(false);
  });
});

describe('the embed forces the plain editor in exam mode', () => {
  it('for a logged-out viewer, who has no userSettings of their own', async () => {
    const t = await glowscriptTrinket(true);
    await flow.switchUser('');
    expect(await embedPage('glowscript', t.id)).toMatch(FORCED);
  });

  it('for a logged-in viewer whose own preference is ACE', async () => {
    const t = await glowscriptTrinket(true);
    const html = await embedPage('glowscript', t.id);
    expect(html).toMatch(/"disableAceEditor":false/);   // their own setting, untouched
    expect(html).toMatch(FORCED);                        // ...and overridden after it
    expect(html.search(FORCED)).toBeGreaterThan(html.search(/"disableAceEditor":false/));
  });

  it('on the student assignment view', async () => {
    const t = await glowscriptTrinket(true);
    await flow.get('/assignment-embed/glowscript/' + t.id);
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(flow.lastResponse.text).toMatch(FORCED);
  });

  it('combined with calculator mode', async () => {
    const t = await glowscriptTrinket(true);
    await flow.switchUser('');
    const html = await embedPage('glowscript', t.id, 'runMode=calculator');
    expect(html).toMatch(FORCED);
    expect(html).toMatch(/class="mode-toggle\b/);        // still the calculator layout
  });

  it('for a pyodide trinket too (one switch for every editor type)', async () => {
    await flow.switchUser('user');
    const t = await createTrinket({ lang: 'pyodide', code: 'print(1)' });
    await autosave(t.id, { settings: { plainEditor: true } });
    await flow.switchUser('');
    expect(await embedPage('pyodide', t.id)).toMatch(FORCED);
  });

  it('and does nothing when exam mode is off', async () => {
    const t = await glowscriptTrinket(false);
    expect(await embedPage('glowscript', t.id)).not.toMatch(FORCED);
    await flow.switchUser('');
    expect(await embedPage('glowscript', t.id)).not.toMatch(FORCED);
  });

  it("the owner's unsaved draft decides for the owner", async () => {
    const t = await glowscriptTrinket(false);
    await flow.post('/api/trinkets/' + t.id + '/draft', { code: t.code, settings: { plainEditor: true } });
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(await embedPage('glowscript', t.id)).toMatch(FORCED);
    await flow.switchUser('');                            // everyone else still sees the saved trinket
    expect(await embedPage('glowscript', t.id)).not.toMatch(FORCED);
  });
});

describe('the Accessibility toggle is hidden in exam mode', () => {
  let was;
  beforeEach(() => { was = config.features.accessibilityToggle; config.features.accessibilityToggle = true; });
  afterEach(()  => { config.features.accessibilityToggle = was; });

  it('so nobody can switch ACE back on mid-exam', async () => {
    const t = await glowscriptTrinket(true);
    await flow.switchUser('');
    expect(await embedPage('glowscript', t.id)).not.toMatch(/id="toolbarEditorToggle"/);
  });

  it('but still offered on an ordinary trinket', async () => {
    const t = await glowscriptTrinket(false);
    await flow.switchUser('');
    expect(await embedPage('glowscript', t.id)).toMatch(/id="toolbarEditorToggle"/);
  });
});

describe('copies keep exam mode', () => {
  it('Trinket#copy — the path behind remixes and course-material copies', async () => {
    const t = await glowscriptTrinket(true);
    const stored = await Trinket.findById(t.id);
    expect(stored.copy(stored._owner).settings.plainEditor).toBe(true);
  });

  it('the /forks route keeps the setting the client sends', async () => {
    const t = await glowscriptTrinket(true);
    const parent = await getTrinket(t.id);
    await flow.post('/api/trinkets/' + t.id + '/forks', { code: parent.code, settings: parent.settings });
    expect(flow.lastResponse.statusCode).toBe(200);
    expect((await getTrinket(flow.lastResponse.body.data.id)).settings.plainEditor).toBe(true);
  });
});

describe('the Trinket Settings modal offers the switch', () => {
  it('unchecked by default, checked in exam mode', async () => {
    const off = await glowscriptTrinket(false);
    expect(await embedPage('glowscript', off.id))
      .toMatch(/<input id="plainEditor" type="checkbox" name="plainEditor"\s+data-trinket-settings>/);
    const on = await glowscriptTrinket(true);
    expect(await embedPage('glowscript', on.id))
      .toMatch(/<input id="plainEditor" type="checkbox" name="plainEditor" checked="checked"\s+data-trinket-settings>/);
  });
});

// Review follow-ups on #317 (Copilot).
describe('create and fork sanitize settings too', () => {
  // These two construct a Trinket straight from the payload. Mongo's Boolean
  // cast rejects "yes please" and fails the whole create; Firestore casts
  // nothing and stores the string, which base.html reads as truthy.
  it('create stores a real boolean whatever the caller sends', async () => {
    await flow.switchUser('user');
    const t = await createTrinket({ lang: 'glowscript', code: 'box()', settings: { plainEditor: 'yes please' } });
    expect((await getTrinket(t.id)).settings.plainEditor).toBe(false);
    const u = await createTrinket({ lang: 'glowscript', code: 'box()', settings: { plainEditor: 'true' } });
    expect((await getTrinket(u.id)).settings.plainEditor).toBe(true);
  });

  it('fork stores a real boolean whatever the caller sends', async () => {
    const t = await glowscriptTrinket(false);
    await flow.post('/api/trinkets/' + t.id + '/forks', { code: 'box()', settings: { plainEditor: 'yes please' } });
    expect(flow.lastResponse.statusCode).toBe(200);
    expect((await getTrinket(flow.lastResponse.body.data.id)).settings.plainEditor).toBe(false);
  });
});

describe("only the owner's draft decides", () => {
  // Any logged-in viewer can hold a draft of someone else's trinket, and the
  // embed loads it. A student must not be able to switch exam mode off for
  // themselves by saving a draft (or the settings switch) with it off.
  it("a non-owner's draft does not switch exam mode off", async () => {
    const t = await glowscriptTrinket(true);
    await flow.switchUser('user2');
    await flow.post('/api/trinkets/' + t.id + '/draft', { code: t.code, settings: { plainEditor: false } });
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(await embedPage('glowscript', t.id)).toMatch(FORCED);
  });

  it("a non-owner's draft does not switch exam mode on either", async () => {
    const t = await glowscriptTrinket(false);
    await flow.switchUser('user2');
    await flow.post('/api/trinkets/' + t.id + '/draft', { code: t.code, settings: { plainEditor: true } });
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(await embedPage('glowscript', t.id)).not.toMatch(FORCED);
  });

  it('the settings switch is offered only to the owner', async () => {
    const t = await glowscriptTrinket(true);
    expect(await embedPage('glowscript', t.id)).toMatch(/id="plainEditor"/);
    await flow.switchUser('user2');
    expect(await embedPage('glowscript', t.id)).not.toMatch(/id="plainEditor"/);
  });
});
