// Choosing the right reporting channel per LTI version.
//
// notify() used to bail whenever a link had no agsLineItemUrl, which is always
// true for LTI 1.1 — 1.1 has no AGS at all. It must now fall through to Basic
// Outcomes instead of silently doing nothing. See #203.
const config          = require('config');
const ltiAgs          = require('../../../lib/util/ltiAgs');
const lti11Outcomes   = require('../../../lib/util/lti11Outcomes');
const LtiResourceLink = require('../../../lib/models/ltiResourceLink');
const LtiPlatform     = require('../../../lib/models/ltiPlatform');
const LtiUserIdentity = require('../../../lib/models/ltiUserIdentity');
const LtiOutcome      = require('../../../lib/models/ltiOutcome');
const LtiConsumer     = require('../../../lib/models/ltiConsumer');
const notify          = require('../../../lib/util/ltiNotifySubmission');

describe('ltiNotifySubmission: LTI 1.1 Basic Outcomes path', () => {
  let posted11, postedAgs;

  function stubLink(link) {
    vi.spyOn(LtiResourceLink, 'findAssignmentLink').mockImplementation((c, m, cb) => cb(null, link));
  }
  function stubOutcome(rec) {
    vi.spyOn(LtiOutcome, 'findForPlacement').mockImplementation((p, r, u, cb) => cb(null, rec));
  }
  function stubConsumer(c) {
    vi.spyOn(LtiConsumer, 'findByKey').mockImplementation((k, cb) => cb(null, c));
  }

  beforeEach(() => {
    posted11 = []; postedAgs = [];
    vi.spyOn(lti11Outcomes, 'postSubmission').mockImplementation((a) => { posted11.push(a); return Promise.resolve({ ok: true }); });
    vi.spyOn(ltiAgs, 'postSubmission').mockImplementation((p, u, o) => { postedAgs.push(o); return Promise.resolve({}); });
    vi.spyOn(LtiPlatform, 'findById').mockImplementation((id, cb) => cb(null, { issuer: 'https://lms.example' }));
    vi.spyOn(LtiUserIdentity, 'findByUserAndIss').mockImplementation((u, i, cb) => cb(null, { sub: 'sub-1' }));
  });
  afterEach(() => vi.restoreAllMocks());

  const submission = { _creator: 'user-1', courseId: 'c1', materialId: 'm1', id: 's1', submittedOn: new Date() };
  const link11 = { platformId: 'lti11:key-abc', resourceLinkId: 'rl-1' };   // no agsLineItemUrl, ever

  it('posts Basic Outcomes for a 1.1 link, carrying the review URL', async () => {
    stubLink(link11);
    stubOutcome({ sourcedId: 'sid-9', serviceUrl: 'https://lms.example/outcomes' });
    stubConsumer({ key: 'key-abc', secret: 'sec', disabled: false });

    await notify.notify(submission);

    expect(posted11.length, 'the 1.1 post must fire').toBe(1);
    expect(posted11[0].serviceUrl).toBe('https://lms.example/outcomes');
    expect(posted11[0].sourcedId).toBe('sid-9');
    expect(posted11[0].secret).toBe('sec');
    // Under the INSTALLED launch path, not a path of its own: Canvas matches a
    // stored basic_lti_launch URL back to an installed tool before launching it
    // (#14). Pinned against the tool path rather than a literal so the two move
    // together; test/lib/api/lti11-review-url-reachable.test.js reads the real
    // path out of the served cartridge.
    expect(posted11[0].launchUrl).toBe(config.url + '/lti11/launch?submission=s1');
  });

  it('sends no score — trinket has no concept of a grade', async () => {
    stubLink(link11);
    stubOutcome({ sourcedId: 'sid-9', serviceUrl: 'https://lms.example/outcomes' });
    stubConsumer({ key: 'key-abc', secret: 'sec' });

    await notify.notify(submission);
    expect(posted11[0].score).toBeUndefined();
  });

  it('no-ops when the launch never carried outcome coordinates', async () => {
    stubLink(link11);
    stubOutcome(null);
    stubConsumer({ key: 'key-abc', secret: 'sec' });

    await notify.notify(submission);
    expect(posted11.length).toBe(0);
  });

  it('no-ops for a disabled consumer rather than posting with a dead key', async () => {
    stubLink(link11);
    stubOutcome({ sourcedId: 'sid-9', serviceUrl: 'https://lms.example/outcomes' });
    stubConsumer({ key: 'key-abc', secret: 'sec', disabled: true });

    await notify.notify(submission);
    expect(posted11.length).toBe(0);
  });

  it('does not misfire on a 1.3 link that simply has no line item', async () => {
    stubLink({ platformId: 'p-13', resourceLinkId: 'rl-1' });   // not an lti11: platform
    stubOutcome({ sourcedId: 'sid-9', serviceUrl: 'https://lms.example/outcomes' });
    stubConsumer({ key: 'key-abc', secret: 'sec' });

    await notify.notify(submission);
    expect(posted11.length).toBe(0);
    expect(postedAgs.length).toBe(0);
  });

  it('still prefers AGS when a line item exists', async () => {
    stubLink({ platformId: 'p-13', resourceLinkId: 'rl-1', agsLineItemUrl: 'https://lms/line_items/5' });
    stubOutcome({ sourcedId: 'sid-9', serviceUrl: 'https://lms.example/outcomes' });
    stubConsumer({ key: 'key-abc', secret: 'sec' });

    await notify.notify(submission);
    expect(postedAgs.length, 'AGS is the 1.3 channel').toBe(1);
    expect(posted11.length, 'must not double-report').toBe(0);
  });

  it('never throws to the caller when the platform rejects the post', async () => {
    stubLink(link11);
    stubOutcome({ sourcedId: 'sid-9', serviceUrl: 'https://lms.example/outcomes' });
    stubConsumer({ key: 'key-abc', secret: 'sec' });
    lti11Outcomes.postSubmission.mockImplementation(() => Promise.reject(new Error('resultScore is required')));

    await expect(notify.notify(submission)).resolves.toBeDefined();
  });
});
