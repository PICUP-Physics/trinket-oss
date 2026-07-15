'use strict';
const config         = require('config');
const instructorAuth = require('../../../lib/util/instructorAuth');

// Knob-consistency contract: auth.requireApprovedAccount decides WHO may
// create an account, identically on every auth provider. When false (stock /
// open posture) anyone may sign up — same meaning as picup's open POST /users.
// When true (instructor-run posture) unknown emails are rejected unless they
// are admins, allowlisted instructors, or course-invited.
describe('instructorAuth.isApprovedToSignup', () => {
  let prev;
  beforeEach(() => { prev = config.auth.requireApprovedAccount; });
  afterEach(() => { config.auth.requireApprovedAccount = prev; });

  it('approves any email when requireApprovedAccount is false (open deploy)', async () => {
    config.auth.requireApprovedAccount = false;
    const res = await instructorAuth.isApprovedToSignup('random-student@example.com');
    expect(res.approved).toBe(true);
  });

  it('rejects unknown emails when requireApprovedAccount is true (instructor-run deploy)', async () => {
    config.auth.requireApprovedAccount = true;
    const res = await instructorAuth.isApprovedToSignup('random-student@example.com');
    expect(res.approved).toBe(false);
  });
});
