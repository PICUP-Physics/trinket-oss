const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

// Reset the cookie jar before each test so a cached session from one test
// does not bleed into the next (the 2a harness drops the DB after each test,
// so stale cookies would point at a dropped user).
beforeEach(() => {
  flow.cookies    = {};
  flow.activeUser = 'user';
});

describe('Admin Access', () => {
  describe('When I am not logged in', () => {
    beforeEach(() => {
      // Set the active jar to anonymous (empty string = no cookie).
      flow.switchUser('');
    });

    describe('and I access /admin', () => {
      it('should redirect me to /login', async () => {
        await flow.admin();
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toEqual(302);
        expect(flow.lastResponse.redirect).toBe(true);
        expect(flow.lastRedirect.pathname).toEqual('/login');
      });
    });
  });

  describe('When I am logged in as a non-admin', () => {
    beforeEach(async () => {
      // Create and log in the default (non-admin) user.
      await flow.switchUser('user');
    });

    describe('and I access /admin', () => {
      it('should not allow access to admin page', async () => {
        await flow.admin();
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toEqual(403);
        expect(flow.lastResponse.redirect).toBe(false);
      });
    });
  });

  describe('When I am logged in as an admin', () => {
    beforeEach(async () => {
      // switchUser('admin') creates the admin user (with site-admin roles) and
      // logs in — no separate flow.login() call needed.
      await flow.switchUser('admin');
    });

    describe('and I access /admin', () => {
      it('should allow access to admin page', async () => {
        await flow.admin();
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toEqual(200);
      });
    });
  });
});
