'use strict';

// Firebase-auth profile only (TEST_AUTH_PROVIDER=firebase): covers the
// session seam production GCP-shape deploys actually use — an Auth-emulator
// ID token exchanged at POST /api/auth/session for a yar session. This is
// the path FirebaseUI drives in a real browser.

const flow = require('../../helpers/flow.cjs');

const FB_MODE = process.env.TEST_AUTH_PROVIDER === 'firebase';

describe.skipIf(!FB_MODE)('Firebase Auth session establishment', () => {
  it('exchanges an emulator ID token for a server session', async () => {
    await flow.switchUser('user');      // mints token + posts /api/auth/session
    await flow.home();
    expect(flow.lastResponse.statusCode).toEqual(200);
  });

  it('serves authenticated API requests on the session cookie', async () => {
    // Self-contained login: the harness wipes the DB after every test, so a
    // cookie cached by an earlier test points at a deleted user. Re-login.
    delete flow.cookies['user'];
    await flow.switchUser('user');
    await flow.get('/api/trinkets');
    expect(flow.lastResponse.statusCode).toEqual(200);
  });

  it('rejects a garbage ID token', async () => {
    await flow.switchUser('');          // anonymous jar
    const r = await flow.post('/api/auth/session', { idToken: 'not-a-real-token' });
    expect(r.statusCode).toEqual(401);
  });

  it('rejects a missing ID token (framework flash-validation envelope)', async () => {
    await flow.switchUser('');
    const r = await flow.post('/api/auth/session', {});
    // Joi failures ride the app's flash-validation convention (200 + flash),
    // not a bare 400 — handler-level Booms (bad token → 401) stay real.
    expect(r.body.flash.validation.idToken).toMatch(/required/);
    expect(r.body.data).toBeUndefined();
  });
});
