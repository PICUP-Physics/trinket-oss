const userUtil = require('../../../lib/util/user');

describe('User Utilities', () => {
  describe('Generating Usernames', () => {
    describe('generate username from an email address', () => {
      it('should replace certain characters and ensure lowercase', async () => {
        const username = userUtil.generate_username('testuser@Dummy.com');

        expect(username).not.toContain('@');
        expect(username).not.toContain('.');
        expect(username).not.toMatch(/[A-Z]/);
      });
    });

    describe('generate username from a fullname', () => {
      it('should replace certain characters, not include spaces, and ensure lowercase', async () => {
        const username = userUtil.generate_username('Test X. User');

        expect(username).not.toContain('@');
        expect(username).not.toContain('.');
        expect(username).not.toMatch(/[A-Z\s]/);
      });
    });

    describe('generate username with a suffix', () => {
      it('should include a suffix', async () => {
        const username = userUtil.generate_username_with_suffix('testuser');

        expect(username).toMatch(/\d{4}$/);
      });
    });
  });
});
