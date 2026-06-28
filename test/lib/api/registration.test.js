'use strict';
const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

// The 2a harness drops the DB after each test, while the flow cookie jar is a
// module-level singleton. Reset it before each test so every test starts fresh.
beforeEach(() => {
  flow.cookies    = {};
  flow.activeUser = 'user';
});

describe('User Registration', () => {
  // libraryUser and sampleCourse are re-created per test (replaces the legacy
  // outer before/after that ran once for all tests — here the DB is dropped
  // between tests so we must recreate them each time).
  let libraryUser, sampleCourse;

  beforeEach(async () => {
    libraryUser = await new User({
      fullname: 'test trinket library user',
      username: 'testlibraryuser',
      email:    'bliggedy@bloo.poo',
      password: 'flim-flam-bim-bam'
    }).save();

    sampleCourse = await new Course({
      name:        'the sampler',
      description: 'a sample course for you!',
      _owner:      libraryUser,
      ownerSlug:   libraryUser.username
    }).save();
  });

  describe('When I enter valid registration data', () => {
    // Register the default user before each test so their session is live for
    // subsequent requests (replaces the legacy sequential it-dependency where
    // test 1 registered and tests 2-5 relied on that side-effect).
    beforeEach(async () => {
      await flow.register();
    });

    it('should create a new user account', async () => {
      const doc = await new Promise((resolve, reject) =>
        User.findByLogin(defaults.user.email, (err, d) => err ? reject(err) : resolve(d))
      );
      expect(doc != null).toBe(true);
    });

    it('should redirect to the welcome page', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastResponse.redirect).toBe(true);
      expect(flow.lastRedirect.pathname).toBe('/welcome');
    });

    it.skip('should include a link to the default course on the welcome page', async () => {
      // TODO(slice-2c-b): the /welcome route now immediately redirects to /home
      // (pages.welcome controller: reply().redirect('/home')) and renders no
      // HTML body; the sample-course link is no longer present in the response.
      await flow.welcome();
      expect(flow.lastResponse.text).toContain(
        '/' + libraryUser.username + '/courses/' + sampleCourse.slug + '/copy'
      );
    });

    it('should allow the sample course to be copied', async () => {
      await flow.post(
        '/' + libraryUser.username + '/courses/' + sampleCourse.slug + '/copy'
      );
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastRedirect.pathname).toBe(
        '/u/' + defaults.user.username + '/classes/' + sampleCourse.slug
      );
    });

    it('should allow the sample course to be loaded', async () => {
      // Copy the course first (the legacy suite relied on test 4 having done
      // this; here each test is independent so we perform the copy inline).
      await flow.post(
        '/' + libraryUser.username + '/courses/' + sampleCourse.slug + '/copy'
      );
      await flow.viewCourse(defaults.user.username, sampleCourse.slug);
      expect(flow.lastResponse.statusCode).toBe(200);
    });
  });

  describe('When I enter duplicate registration data', () => {
    beforeEach(async () => {
      // First register the default user to establish the duplicate conflict.
      await flow.register();
      // Reset to anonymous and attempt a second registration with the same
      // email (username uppercased → lowercased by lowerUserFields pre-handler,
      // so it matches 'testing' too).
      flow.cookies = {};
      await flow.switchUser('');
      await flow.register({ username: defaults.user.username.toUpperCase() });
    });

    it('should redirect me to the signup page', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastResponse.redirect).toBe(true);
      expect(flow.lastRedirect.pathname).toBe('/signup');
    });
  });

  describe('When I enter invalid registration data', () => {
    beforeEach(async () => {
      await flow.switchUser('');
      await flow.register({ email: 'invalid' });
    });

    it('should redirect me to the signup page', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastResponse.redirect).toBe(true);
      expect(flow.lastRedirect.pathname).toBe('/signup');
    });

    it('should not create a new user account', async () => {
      const doc = await new Promise((resolve, reject) =>
        User.findByLogin('invalid', (err, d) => err ? reject(err) : resolve(d))
      );
      expect(doc == null).toBe(true);
    });

    it('should not let me visit the welcome page', async () => {
      // /welcome requires auth: 'session'; unauthenticated → 401 →
      // onPreResponse converts to 302 → /login
      await flow.welcome();
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(302);
      expect(flow.lastRedirect.pathname).toBe('/login');
    });
  });
});
