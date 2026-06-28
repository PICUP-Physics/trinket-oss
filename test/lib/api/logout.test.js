const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

// The 2a harness drops the DB after each test, while the flow cookie jar is a
// module-level singleton that would otherwise persist a stale session across
// tests. Reset the jar before each test so every test logs in fresh against the
// freshly-reset DB.
beforeEach(() => {
  flow.cookies = {};
  flow.activeUser = 'user';
});

describe('User Logout', () => {
  describe('When I log out', () => {
    beforeEach(async () => {
      await flow.switchUser('user');
      await flow.logout();
    });

    it('should redirect me to the splash page', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastResponse.redirect).toBe(true);
      expect(flow.lastRedirect.pathname).toBe('/');
    });

    it('should not allow me to go to the home page', async () => {
      await flow.home();
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastRedirect.pathname).toBe('/login');
    });
  });
});
