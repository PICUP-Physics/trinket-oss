'use strict';

// The "Connect your LMS" bootstrap gate (GET/POST /lti/connect). LTI Dynamic
// Registration happens INSIDE trinket before any launch exists, so there's no
// LMS roles claim to trust — the gate falls back to who the deploy considers an
// instructor. Site admins can ALWAYS initiate registration: on deploys with no
// curated instructor authority (trials/VPS, instructorAuthority 'default'), the
// admins are exactly who register the tool. base.html mirrors this rule for the
// menu item: `user.isInstructor OR user.hasRole('admin')`.

const { canInitiateLtiRegistration } = require('../../../lib/util/helpers');

function fakeUser(opts) {
  opts = opts || {};
  return {
    email: opts.email || 'nobody@example.com',
    hasRole: function(role) { return role === 'admin' && !!opts.admin; }
  };
}

describe('canInitiateLtiRegistration gate (admin-OR-instructor)', () => {
  it('allows a site admin (short-circuits the instructor-authority lookup)', async () => {
    const res = await Promise.resolve(canInitiateLtiRegistration(fakeUser({ admin: true })));
    expect(res).toBe(true);
  });

  it('refuses a non-admin, non-instructor user with 403', async () => {
    await expect(
      Promise.resolve().then(() => canInitiateLtiRegistration(fakeUser({ admin: false })))
    ).rejects.toMatchObject({ isBoom: true, output: { statusCode: 403 } });
  });

  it('rejects an anonymous request with 401', () => {
    let err;
    try { canInitiateLtiRegistration(null); } catch (e) { err = e; }
    expect(err && err.isBoom).toBe(true);
    expect(err.output.statusCode).toBe(401);
  });
});
