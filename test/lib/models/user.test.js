const defaults = require('../../helpers/defaults');

describe('User model', () => {
  describe('hooks', () => {
    describe('pre-save encryptPassword', () => {
      let encryptPassword;
      let isModifiedFlag = false;
      let user;

      beforeAll(() => {
        // User global is not available at describe-collection time; defer.
        encryptPassword = User.hooks.pre.save.encryptPassword;
      });

      afterEach(() => vi.restoreAllMocks());

      beforeEach(() => {
        user = {
          isModified: vi.fn().mockImplementation(() => isModifiedFlag),
          password: 'foo',
        };
      });

      it('should check password for modifications before continuing', async () => {
        isModifiedFlag = false;
        await new Promise((res, rej) =>
          encryptPassword.call(user, (err) => (err ? rej(err) : res()))
        );
        expect(user.isModified).toHaveBeenCalledOnce();
        expect(user.isModified).toHaveBeenCalledWith('password');
        expect(user.password).toEqual('foo');
      });

      it('should encrypt the password if it is being set/modified', async () => {
        isModifiedFlag = true;
        await new Promise((res, rej) =>
          encryptPassword.call(user, (err) => (err ? rej(err) : res()))
        );
        expect(user.password).not.toEqual('foo');
        expect(user.password.length).toBeGreaterThan(3);
      });
    });
  });

  describe('object methods', () => {
    describe('comparePassword', () => {
      let comparePassword;
      let user;

      beforeAll(() => {
        // Defer access to User global past describe-collection time.
        comparePassword = User.objectMethods.comparePassword;
      });

      beforeEach(async () => {
        user = new User({ password: 'foo' });
        await new Promise((res, rej) =>
          User.hooks.pre.save.encryptPassword.call(user, (err) => (err ? rej(err) : res()))
        );
      });

      it('should return true when passwords match', async () => {
        const isMatch = await new Promise((res, rej) =>
          comparePassword.call(user, 'foo', (err, m) => (err ? rej(err) : res(m)))
        );
        expect(isMatch).toBe(true);
      });

      it("should return false when passwords don't match", async () => {
        const isMatch = await new Promise((res, rej) =>
          comparePassword.call(user, 'bar', (err, m) => (err ? rej(err) : res(m)))
        );
        expect(isMatch).toBe(false);
      });
    });

    describe('isAdmin', () => {
      let admin;

      // original used before/after (once); harness resets DB per-it so use beforeEach
      beforeEach(async () => {
        admin = new User(defaults.admin);
        await admin.save();
      });

      it('should return true', async () => {
        const doc = await new Promise((res, rej) =>
          User.findByLogin(defaults.admin.email, (err, d) => (err ? rej(err) : res(d)))
        );
        expect(doc.hasRole('admin', 'site')).toBe(true);
      });
    });
  });

  describe('class methods', () => {
    let user;

    beforeEach(async () => {
      user = new User(defaults.user);
      await user.save();
    });

    afterEach(async () => {
      await user.deleteOne();
    });

    describe('findByLogin', () => {
      it('should find users by username', async () => {
        const doc = await new Promise((res, rej) =>
          User.findByLogin(defaults.user.email, (err, d) => (err ? rej(err) : res(d)))
        );
        expect(doc != null).toBe(true);
        expect(doc.username).toEqual(user.username);
        expect(doc.hasRole('admin', 'site')).toBe(false);
      });
    });

    describe('findAdminList', () => {
      it('should return a list of users', async () => {
        const page = 0;
        const users = await new Promise((res, rej) =>
          User.findAdminList(page, (err, u) => (err ? rej(err) : res(u)))
        );
        expect(users != null).toBe(true);
        expect(users).toBeInstanceOf(Array);
        expect(users[0]).toHaveProperty('username');
      });
    });
  });
});
