const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

// Reset the cookie jar before each test so a cached session from one test
// does not bleed into the next (the 2a harness drops the DB after each test,
// so stale cookies would point at a dropped user).
beforeEach(() => {
  flow.cookies    = {};
  flow.activeUser = 'user';
});

describe('User Profile', () => {
  describe('As a logged in user', () => {
    it('should allow me to update my username, name and avatar', async () => {
      // Create and log in the default user.
      await flow.switchUser('user');

      // Fetch the Mongoose document so we have the _id for the PUT URL.
      const user = await new Promise((resolve, reject) => {
        User.findByLogin(defaults.login.email, (err, doc) =>
          err ? reject(err) : resolve(doc)
        );
      });

      const updates = {
        username : 'hanz',
        name     : 'hanz',
      };

      await flow.updateProfile(user.id, updates);
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
      expect(flow.lastContentType).toContain('application/json');
      for (const property in updates) {
        expect(flow.lastResponse.body).toHaveProperty('user.' + property, updates[property]);
      }
    });

    // Avatar storage is governed by User#normalizeAvatar (lib/models/user.js):
    // a full http(s) URL that is not a placeholder (does not contain
    // 'example.com') is stored verbatim. The original skip referenced a
    // config.cloud.containers.userAvatars.host stub, but no such config path
    // exists — the real contract is the normalizeAvatar pass-through, asserted
    // here with a clean CDN URL.
    it('should allow me to update my avatar', async () => {
      await flow.switchUser('user');
      const user = await new Promise((resolve, reject) => {
        User.findByLogin(defaults.login.email, (err, doc) =>
          err ? reject(err) : resolve(doc)
        );
      });
      const avatarUrl = 'https://cdn.trinket.io/avatars/franz.png';
      // username is required by the updateProfile Joi schema; send the existing
      // one so validation passes and the controller reaches the avatar update.
      await flow.updateProfile(user.id, {
        username: user.username,
        name: user.name,
        avatar: avatarUrl,
      });
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toEqual(200);
      expect(flow.lastResponse.body).toHaveProperty('user.avatar', avatarUrl);
    });
  });
});
