// The review URL we hand a 1.1 platform must be one the platform can launch.
//
// MIAuthors #14: Canvas SpeedGrader shows "Couldn't find valid settings for this
// link" and the modules list instead of the student's work — but only where a
// submission exists. Non-submitters get a correct "No Submission".
//
// That asymmetry is the tell. Canvas stores our resultData/ltiLaunchUrl as a
// basic_lti_launch submission and, when a grader opens it, matches that URL back
// to an installed tool. We advertise config.url + '/lti/review/<id>', while the
// 1.1 tool is installed at the launch URL in our config.xml — '/lti11/launch'.
// A stored URL outside the installed URL matches no tool, so Canvas declines to
// launch it. No submission -> no resultData -> no URL to decline, which is why
// only submitters see the error.
//
// Both halves are individually healthy and individually tested: the endpoint
// works when launched (lti11-review.test.js) and the notify posts the URL
// (ltiNotifySubmission-lti11.test.js pins the exact string). Nothing asserted
// the RELATIONSHIP — that what we advertise is something the tool as installed
// can serve. That is this file.
//
// 1.3 is deliberately excluded: there the URL travels as a target_link_uri claim
// on the tool's own launch and is never matched against installed tools, which is
// why Brightspace has never shown this.
const flow      = require('../../helpers/flow.cjs');
const ltiAgs    = require('../../../lib/util/ltiAgs');
const ltiReview = require('../../../lib/util/ltiReview');
const lti11Outcomes   = require('../../../lib/util/lti11Outcomes');
const LtiResourceLink = require('../../../lib/models/ltiResourceLink');
const LtiPlatform     = require('../../../lib/models/ltiPlatform');
const LtiUserIdentity = require('../../../lib/models/ltiUserIdentity');
const LtiOutcome      = require('../../../lib/models/ltiOutcome');
const LtiConsumer     = require('../../../lib/models/ltiConsumer');
const notify          = require('../../../lib/util/ltiNotifySubmission');

const submission = { _creator: 'user-1', courseId: 'c1', materialId: 'm1', id: 's1',
                     submittedOn: new Date() };
const link11 = { platformId: 'lti11:key-abc', resourceLinkId: 'rl-1' };  // 1.1 never has a line item

// The URL an admin actually installs, read from the cartridge we serve rather
// than hardcoded, so the two cannot drift apart silently.
async function installedLaunchPath() {
  const res = await flow.get('/lti11/config.xml');
  expect(res.statusCode, 'the 1.1 cartridge must be served').toBe(200);
  const m = /<blti:launch_url>([^<]+)<\/blti:launch_url>/.exec(res.text || '');
  expect(m, 'cartridge must declare a launch_url').toBeTruthy();
  return new URL(m[1]).pathname;
}

// Compare PATHS, not whole URLs: notify() builds from config.url while the
// cartridge resolves the public hostname per-request, so a host difference
// between the two would fail this for a reason that is not the bug.
async function advertisedReviewUrl() {
  const posted = [];
  vi.spyOn(lti11Outcomes, 'postSubmission').mockImplementation((a) => {
    posted.push(a); return Promise.resolve({ ok: true });
  });
  vi.spyOn(LtiResourceLink, 'findAssignmentLink').mockImplementation((c, m, cb) => cb(null, link11));
  vi.spyOn(LtiOutcome, 'findForPlacement').mockImplementation((p, r, u, cb) =>
    cb(null, { sourcedId: 'sid-9', serviceUrl: 'https://lms.example/outcomes' }));
  vi.spyOn(LtiConsumer, 'findByKey').mockImplementation((k, cb) =>
    cb(null, { key: 'key-abc', secret: 'sec' }));

  await notify.notify(submission);
  expect(posted.length, 'the 1.1 outcomes post must fire').toBe(1);
  return posted[0].launchUrl;
}

describe('LTI 1.1: the advertised review URL is launchable by the platform', () => {
  afterEach(() => vi.restoreAllMocks());

  it('advertises a URL under the tool path Canvas has installed', async () => {
    const installed = await installedLaunchPath();
    const advertised = new URL(await advertisedReviewUrl()).pathname;

    expect(advertised,
      'Canvas matches a stored basic_lti_launch URL against installed tools; a review URL '
      + 'outside the installed launch path (' + installed + ') matches nothing, and SpeedGrader '
      + 'answers "Couldn\'t find valid settings for this link"')
      .toBe(installed);
  });

  it('still lets the launch handler recover the submission id from it', async () => {
    // Moving the URL is only half a fix. Whatever shape it takes, the 1.1 launch
    // handler must still read s1 back out of it, or the grader gets a launch that
    // Canvas accepts and we then fail to route.
    const url = await advertisedReviewUrl();
    expect(ltiReview.parseTarget(url),
      'the review target must survive the round trip through the URL we advertise')
      .toBe('s1');
  });

  it('leaves the 1.3 AGS review URL alone', async () => {
    // 1.3 relaunches at the tool's own endpoint with the target in a claim, so it
    // never needs Canvas to match a path. Nothing here should perturb it.
    const posted = [];
    vi.spyOn(ltiAgs, 'postSubmission').mockImplementation((p, u, o) => {
      posted.push(o); return Promise.resolve({});
    });
    vi.spyOn(LtiResourceLink, 'findAssignmentLink').mockImplementation((c, m, cb) =>
      cb(null, { platformId: 'p-13', agsLineItemUrl: 'https://lms/line_items/5' }));
    vi.spyOn(LtiPlatform, 'findById').mockImplementation((id, cb) => cb(null, { issuer: 'https://lms.example' }));
    vi.spyOn(LtiUserIdentity, 'findByUserAndIss').mockImplementation((u, i, cb) => cb(null, { sub: 'sub-1' }));

    await notify.notify(submission);
    expect(posted.length).toBe(1);
    expect(ltiReview.parseTarget(posted[0].reviewUrl)).toBe('s1');
  });
});
