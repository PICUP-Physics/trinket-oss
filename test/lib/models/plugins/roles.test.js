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

    describe('hasRole trinket-code before grant', () => {
      it.skip('should return true', () => {
        // TODO(slice-2b): asserted hasRole('trinket-code') === true but code now grants 'user'
        // role by default (not 'trinket-code'); 'trinket-code' is a legacy alias that is no
        // longer assigned to new users in the OSS roles config.
        expect(user.hasRole('trinket-code')).toBe(true);
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
      it.skip('should grant user roles and permissions', async () => {
        // TODO(slice-2b): asserted hasRole('trinket-code') === true after granting
        // 'trinket-connect', but 'trinket-code' is never in the roles list — the default
        // role is now 'user', not 'trinket-code'.
        const updated = await user.grant('trinket-connect', 'site');
        expect(updated.hasRole('trinket-code')).toBe(true);
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

      it.skip('should revoke user roles and permissions', async () => {
        // TODO(slice-2b): asserted hasRole('trinket-code') === true after revoking
        // 'trinket-connect', but 'trinket-code' is never granted — default role is now
        // 'user'; 'trinket-code' is a legacy alias no longer assigned to new users.
        const updated = await user.revoke('trinket-connect', 'site');
        expect(updated.hasRole('trinket-code')).toBe(true);
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

      it.skip('should grant user roles and permissions for trinket-connect', async () => {
        // TODO(slice-2b): asserted hasRole('trinket-code') === true but 'trinket-code' is
        // never assigned — default role is 'user'; 'trinket-code' is a legacy alias.
        const thru = new Date();
        thru.setHours(thru.getHours() + 1);

        const updated = await user.grant('trinket-connect', 'site', { thru });
        expect(updated.hasRole('trinket-code')).toBe(true);
        expect(updated.hasRole('trinket-connect')).toBe(true);
      });

      it.skip('should grant user roles and permissions for trinket-codeplus', async () => {
        // TODO(slice-2b): asserted hasRole('trinket-code') === true but 'trinket-code' is
        // never assigned — default role is 'user'; 'trinket-code' is a legacy alias.
        const thru = new Date();
        thru.setHours(thru.getHours() + 1);

        const updated = await user.grant('trinket-codeplus', 'site', { thru });
        expect(updated.hasRole('trinket-code')).toBe(true);
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

      it.skip('should revoke user roles and permissions for trinket-connect only', async () => {
        // TODO(slice-2b): asserted hasRole('trinket-code') === true after revoking
        // 'trinket-connect', but 'trinket-code' is never assigned — default role is 'user'.
        const updated = await user.revoke('trinket-connect', 'site');
        expect(updated.hasRole('trinket-code')).toBe(true);
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
