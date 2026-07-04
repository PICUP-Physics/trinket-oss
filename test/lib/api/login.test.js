const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

// The 2a harness drops the DB after each test, while the flow cookie jar is a
// module-level singleton. Reset it before each test so every test logs in fresh
// against the freshly-reset DB (the legacy mocha suite shared one DB across the
// whole sequence; here each test is isolated).
beforeEach(() => {
  flow.cookies = {};
  flow.activeUser = 'user';
});

describe('User Login', () => {
  describe('When I enter an invalid login', () => {
    beforeEach(async () => {
      flow.switchUser('');
      // log in the user with the wrong password (and no such user in the DB)
      await flow.login({ password: 'nope' });
    });

    it('should redirect me to the login page', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastResponse.redirect).toBe(true);
      expect(flow.lastRedirect.pathname).toBe('/login');
    });

    it('should not let me visit the welcome page', async () => {
      await flow.welcome();
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastRedirect.pathname).toBe('/login');
    });
  });

  describe('When I enter a valid login', () => {
    beforeEach(async () => {
      await flow.switchUser('user');
    });

    it('should redirect to the home page', async () => {
      // log in the user
      await flow.login();
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastResponse.redirect).toBe(true);
      expect(flow.lastRedirect.pathname).toBe('/home');
    });

    it('should allow the home page to load', async () => {
      const response = await flow.home();
      expect(flow.wasOk).toBe(true);
      expect(response.statusCode).toBe(200);
    });
  });

  describe('When I enter a valid upper case email address', () => {
    beforeEach(async () => {
      // Ensure the user exists in the freshly-reset DB, then attempt an
      // anonymous login with an upper-cased email (lowerUserFields pre-handler
      // should normalise it to match).
      await flow.switchUser('user');
      flow.switchUser('');
      await flow.login({ email: defaults.login.email.toUpperCase() });
    });

    it('should redirect to the home page', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastResponse.redirect).toBe(true);
      expect(flow.lastRedirect.pathname).toBe('/home');
    });
  });
});
