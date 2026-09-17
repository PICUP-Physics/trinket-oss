// One trinket assignment can end up with SEVERAL LMS placements.
//
// Seen live: an instructor set an assignment up in Canvas at 15:26, it was not
// what he wanted, and he redid it at 15:32. Canvas mints a fresh
// resource_link_id every time, so trinket recorded both — same course, same
// material, both targetType 'assignment'. Only the 15:32 one was ever launched;
// all 58 student tokens sit under it, and the 15:26 row holds none.
//
// findAssignmentLink was a findOne with no ordering, so which row came back was
// down to Firestore's default document-name order. The live row happened to
// sort first ('2jIpIx…' before 'whQEh8fz…'), which is the only reason that
// assignment worked at all: had it sorted the other way, the dead placement
// would have been chosen and every one of those 83 submitters would have shown
// "nothing submitted". Pick deterministically instead.
const LtiResourceLink = require('../../../lib/models/ltiResourceLink');

const hexId = () => Array.from({ length: 24 },
  () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('LtiResourceLink.findAssignmentLink with duplicate placements', () => {
  it('returns the most recently touched placement, not whichever sorts first', async () => {
    const courseId = hexId(), materialId = hexId();
    // Saved oldest-first; the ids are chosen so the DEAD one would win a
    // document-name sort, which is exactly the case that used to break.
    const dead = new LtiResourceLink({
      platformId: 'lti11:k', resourceLinkId: 'rl-dead', targetType: 'assignment',
      targetId: materialId, courseId: courseId, lastUpdated: new Date('2026-09-03T15:26:10Z')
    });
    await dead.save();
    const live = new LtiResourceLink({
      platformId: 'lti11:k', resourceLinkId: 'rl-live', targetType: 'assignment',
      targetId: materialId, courseId: courseId, lastUpdated: new Date('2026-09-03T15:32:21Z')
    });
    await live.save();

    const got = await new Promise((r) => LtiResourceLink.findAssignmentLink(courseId, materialId, (e, l) => r(l)));
    expect(got, 'a placement should be found').toBeTruthy();
    expect(got.resourceLinkId, 'the newer placement is the live one').toBe('rl-live');
  });

  it('still returns the only placement when there is just one', async () => {
    const courseId = hexId(), materialId = hexId();
    await new LtiResourceLink({
      platformId: 'lti11:k', resourceLinkId: 'rl-solo', targetType: 'assignment',
      targetId: materialId, courseId: courseId
    }).save();

    const got = await new Promise((r) => LtiResourceLink.findAssignmentLink(courseId, materialId, (e, l) => r(l)));
    expect(got.resourceLinkId).toBe('rl-solo');
  });

  it('ignores non-assignment placements for the same material', async () => {
    const courseId = hexId(), materialId = hexId();
    await new LtiResourceLink({
      platformId: 'lti11:k', resourceLinkId: 'rl-topic', targetType: 'topic',
      targetId: materialId, courseId: courseId, lastUpdated: new Date('2027-01-01T00:00:00Z')
    }).save();
    await new LtiResourceLink({
      platformId: 'lti11:k', resourceLinkId: 'rl-assign', targetType: 'assignment',
      targetId: materialId, courseId: courseId, lastUpdated: new Date('2026-09-03T15:32:21Z')
    }).save();

    const got = await new Promise((r) => LtiResourceLink.findAssignmentLink(courseId, materialId, (e, l) => r(l)));
    expect(got.resourceLinkId, 'a newer topic link must not win').toBe('rl-assign');
  });

  it('returns nothing when the material has no assignment placement', async () => {
    const got = await new Promise((r) => LtiResourceLink.findAssignmentLink(hexId(), hexId(), (e, l) => r(l)));
    expect(got).toBeFalsy();
  });
});
