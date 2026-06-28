'use strict';

const defaults = require('../../../helpers/defaults');
const plugin   = require('../../../../lib/models/plugins/roles');

describe('roles plugin', () => {
  describe('class methods', () => {
    let user;

    beforeEach(async () => {
      user = new User(defaults.user);
      await user.save();
    });

    afterEach(() => vi.restoreAllMocks());

    describe('hasRole user before any explicit grant', () => {
      it('should return true', () => {
        // New users get the 'user' role by default (set in user.js pre-save hook).
        // 'trinket-code' is a legacy alias that is never granted to new users.
        expect(user.hasRole('user')).toBe(true);
        expect(user.hasRole('trinket-code')).toBe(false);
      });
    });

    describe('hasPermission create-python-trinket before grant', () => {
      // NOTE: legacy description says "should return false" but assertion was .be.true
      it('should return false', () => {
        expect(user.hasPermission('create-python-trinket')).toBe(true);
      });
    });

    describe('hasRole trinket-connect before grant', () => {
      it('should return false', () => {
        expect(user.hasRole('trinket-connect')).toBe(false);
      });
    });

    describe('grant site-wide role', () => {
      it('should grant user roles and permissions', async () => {
        // After granting trinket-connect, user retains the default 'user' role and gains
        // 'trinket-connect'. 'trinket-code' is never in play — it is a legacy alias only.
        const updated = await user.grant('trinket-connect', 'site');
        expect(updated.hasRole('user')).toBe(true);
        expect(updated.hasRole('trinket-connect')).toBe(true);
        expect(updated.hasPermission('create-python-trinket')).toBe(true);
      });
    });

    describe('getRole', () => {
      beforeEach(async () => {
        // Keep user as the in-memory modified object (grant mutates this.roles in place).
        // Do NOT reassign to the DB-returned document: the returned doc may have thru: null
        // for Object-typed fields, which breaks subsequent revoke() calls.
        await user.grant('trinket-connect', 'site');
      });

      it('should have roles', () => {
        const role = user.getRole('trinket-connect');

        expect(role).toHaveProperty('context');
        expect(role.context).toBe('site');

        // trinket-code, trinket-connect (at least 2)
        expect(role).toHaveProperty('roles');
        expect(role.roles.length).toBeGreaterThanOrEqual(2);

        expect(role).toHaveProperty('permissions');
        expect(role.permissions.length).toBeGreaterThanOrEqual(4);

        expect(user.hasPermission('create-python-trinket')).toBe(true);
        expect(role.permissions).toContain('hide-trinket-files');
        expect(role.permissions).toContain('enable-trinket-tests');
        expect(role.permissions).toContain('create-python3-trinket');
      });
    });

    describe('revoke site-wide role', () => {
      beforeEach(async () => {
        await user.grant('trinket-connect', 'site');
      });

      it('should revoke user roles and permissions', async () => {
        // After revoking trinket-connect, the default 'user' role remains and the user
        // retains create-python-trinket permission. trinket-connect is gone.
        const updated = await user.revoke('trinket-connect', 'site');
        expect(updated.hasRole('user')).toBe(true);
        expect(updated.hasRole('trinket-connect')).toBe(false);
        expect(updated.hasPermission('create-python-trinket')).toBe(true);
      });
    });

    describe('grant site-wide role with thru', () => {
      it('should allow access if thru is in the future', async () => {
        const thru = new Date();
        thru.setHours(thru.getHours() + 1);

        const updated = await user.grant('trinket-connect', 'site', { thru });
        expect(updated.roles[0]).toHaveProperty('thru');
        expect(updated.hasRole('trinket-connect')).toBe(true);
      });

      it('should restrict access if thru is in the past', async () => {
        const thru = new Date();
        thru.setHours(thru.getHours() - 1);

        const updated = await user.grant('trinket-connect', 'site', { thru });
        expect(updated.roles[0]).toHaveProperty('thru');
        expect(updated.hasRole('trinket-connect')).toBe(false);
      });
    });

    describe('grant 2 site-wide roles', () => {
      // NOTE: original had a nested before() that revoked trinket-connect to clean up from prior
      // tests; with beforeEach per test, each test starts with a fresh user — no cleanup needed.

      it('should grant user roles and permissions for trinket-connect', async () => {
        // After granting trinket-connect with a future thru, user retains the default
        // 'user' role and trinket-connect is active (thru is in the future).
        const thru = new Date();
        thru.setHours(thru.getHours() + 1);

        const updated = await user.grant('trinket-connect', 'site', { thru });
        expect(updated.hasRole('user')).toBe(true);
        expect(updated.hasRole('trinket-connect')).toBe(true);
      });

      it('should grant user roles and permissions for trinket-codeplus', async () => {
        // trinket-codeplus is an actively-checked role (trinket.js:1609). After granting
        // it with a future thru, user retains 'user' role and gains all codeplus permissions.
        const thru = new Date();
        thru.setHours(thru.getHours() + 1);

        const updated = await user.grant('trinket-codeplus', 'site', { thru });
        expect(updated.hasRole('user')).toBe(true);
        expect(updated.hasRole('trinket-codeplus')).toBe(true);
        expect(updated.hasPermission('create-python3-trinket')).toBe(true);
        expect(updated.hasPermission('create-python-trinket')).toBe(true);
      });
    });

    describe('revoke 1 of 2 site-wide roles', () => {
      beforeEach(async () => {
        const thru = new Date();
        thru.setHours(thru.getHours() + 1);
        await user.grant('trinket-connect', 'site', { thru });
        await user.grant('trinket-codeplus', 'site', { thru });
      });

      it('should revoke user roles and permissions for trinket-connect only', async () => {
        // After revoking trinket-connect (one of two granted roles), 'user' and
        // 'trinket-codeplus' remain; trinket-connect is gone and permissions are recomputed.
        const updated = await user.revoke('trinket-connect', 'site');
        expect(updated.hasRole('user')).toBe(true);
        expect(updated.hasRole('trinket-codeplus')).toBe(true);
        expect(updated.hasRole('trinket-connect')).toBe(false);
        expect(updated.hasPermission('create-python3-trinket')).toBe(true);
      });
    });

    // don't have any of these in the app yet
    // @TODO: update tests when we do
    describe('grant role with context', () => {
      it('should grant user roles and permissions', async () => {
        // made up role
        const updated = await user.grant('trinket-owner', 'trinketId');
        expect(updated.hasRole('trinket-owner', 'trinketId')).toBe(true);
      });
    });
  });
});
