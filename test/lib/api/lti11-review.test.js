// LTI 1.1 SpeedGrader review.
//
// Canvas stores a review URL as a basic_lti_launch submission and RELAUNCHES the
// tool at that URL when a grader opens SpeedGrader (confirmed against a live
// Canvas: submission_type "basic_lti_launch", one distinct tool URL per student).
// The difference from 1.3 is where the submission id travels: a target_link_uri
// claim there, the request PATH here — so 1.1 needs a real route, which is the
// gap issue #203 describes.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const defaults = require('../../helpers/defaults');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const Trinket  = require('../../../lib/models/trinket');
const v        = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');
const ltiReview = require('../../../lib/util/ltiReview');

const AUTHORITY = 'localhost';
const serverUrl = (path) => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path },
  config.app.url, publicHostname.resolve);

// A grader's review launch: Instructor role, and the email of the course owner so
// the provisioned user is the one holding send-submission-feedback.
function signedReviewLaunch(path, consumer, extra) {
  const p = Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-review-1',
    user_id: 'grader-1',
    roles: 'Instructor',
    lis_person_contact_email_primary: defaults.user.email,
    lis_person_name_full: 'Test User',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'rev-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
  p.oauth_signature = v.sign('POST', serverUrl(path), p, consumer.secret);
  return p;
}

async function seedConsumer() {
  const c = new LtiConsumer({ key: 'rev-' + Math.random().toString(36).slice(2, 10),
                              secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'review test' });
  await c.save();
  return c;
}

describe('LTI 1.1 review launch (SpeedGrader)', () => {
  beforeEach(() => { flow.cookies = {}; });
  afterEach(() => { vi.restoreAllMocks(); });

  async function ownedCourse() {
    await flow.switchUser('user');
    await flow.createCourse({ name: 'Review Course ' + Math.random().toString(36).slice(2, 7) });
    return flow.lastResponse.body.course;
  }

  function stubSubmission(sub) {
    return vi.spyOn(Trinket, 'findById').mockImplementation(() => Promise.resolve(sub));
  }

  it('lands an authorized grader on the submission feedback view', async () => {
    const course = await ownedCourse();
    const consumer = await seedConsumer();
    stubSubmission({ id: 'sub-1', lang: 'python3', courseId: course.id });

    const path = '/lti/review/sub-1';
    await flow._inject('POST', 'http://' + AUTHORITY + path, signedReviewLaunch(path, consumer));

    expect(flow.lastResponse.statusCode,
      JSON.stringify(flow.lastResponse.body).slice(0, 200)).toBe(302);
    expect(flow.lastResponse.headers.location).toBe('/lti/review-panel/sub-1');
  });

  // #14: the URL we ADVERTISE is now the query form on the installed launch path,
  // because Canvas will not launch a stored URL it cannot match to an installed
  // tool. This is the end-to-end proof of that half — a real signed launch at the
  // real URL, including the OAuth base covering the query string.
  it('lands a grader launched at the advertised ?submission= URL', async () => {
    const course = await ownedCourse();
    const consumer = await seedConsumer();
    stubSubmission({ id: 'sub-q1', lang: 'python3', courseId: course.id });

    // Exactly what notify() posts to the platform, minus the origin.
    const advertised = ltiReview.advertisedUrl('', 'sub-q1', { version: '1.1' });
    expect(advertised, 'must ride on the installed launch path').toBe('/lti11/launch?submission=sub-q1');

    // Canvas signs body + query together; lti11Verify folds the query into the base.
    const params = signedReviewLaunch('/lti11/launch', consumer, {});
    params.oauth_signature = v.sign('POST', serverUrl('/lti11/launch'),
      Object.assign({ submission: 'sub-q1' }, params), consumer.secret);

    await flow._inject('POST', 'http://' + AUTHORITY + advertised, params);

    expect(flow.lastResponse.statusCode,
      JSON.stringify(flow.lastResponse.body).slice(0, 200)).toBe(302);
    expect(flow.lastResponse.headers.location).toBe('/lti/review-panel/sub-q1');
  });

  it('rejects a review launch whose signature omitted the ?submission= param', async () => {
    // Without this, anyone could append ?submission=<id> to a launch they hold a
    // valid signature for and read another student's work.
    const course = await ownedCourse();
    const consumer = await seedConsumer();
    stubSubmission({ id: 'sub-q2', lang: 'python3', courseId: course.id });

    const params = signedReviewLaunch('/lti11/launch', consumer, {});   // body ALONE
    await flow._inject('POST', 'http://' + AUTHORITY + '/lti11/launch?submission=sub-q2', params);

    expect(flow.lastResponse.headers.location || '').toContain('/login');
    expect(flow.lastResponse.headers.location || '').not.toContain('/lti/review-panel');
  });

  it('refuses a grader with no feedback permission on the submission course', async () => {
    await ownedCourse();                       // launcher owns THIS course...
    const consumer = await seedConsumer();
    stubSubmission({ id: 'sub-2', lang: 'python3', courseId: '5f000000000000000000000a' }); // ...not this one

    const path = '/lti/review/sub-2';
    await flow._inject('POST', 'http://' + AUTHORITY + path, signedReviewLaunch(path, consumer));

    // 403 not 404: the route ran and refused, rather than never existing.
    expect(flow.lastResponse.statusCode).toBe(403);
    expect(flow.lastResponse.headers.location || '').not.toContain('/lti/review-panel');
  });

  it('does not leak a feedback view for a submission that does not exist', async () => {
    await ownedCourse();
    const consumer = await seedConsumer();
    const spy = stubSubmission(null);

    const path = '/lti/review/sub-missing';
    await flow._inject('POST', 'http://' + AUTHORITY + path, signedReviewLaunch(path, consumer));

    // A bare 404 cannot distinguish "no such submission" from "no such route",
    // so pin the thing that differs: the handler looked the submission up.
    expect(spy).toHaveBeenCalledWith('sub-missing');
    expect(flow.lastResponse.statusCode).toBe(404);
    expect(flow.lastResponse.headers.location || '').not.toContain('/lti/review-panel');
  });

  it('still rejects a review launch signed with the wrong secret', async () => {
    const course = await ownedCourse();
    const consumer = await seedConsumer();
    stubSubmission({ id: 'sub-3', lang: 'python3', courseId: course.id });

    const path = '/lti/review/sub-3';
    const bad = signedReviewLaunch(path, { key: consumer.key, secret: 'not-the-secret' });
    await flow._inject('POST', 'http://' + AUTHORITY + path, bad);

    // Rejected at the signature check (routeParser turns the auth Boom into a
    // login redirect) — again distinct from the 404 a missing route would give.
    expect(flow.lastResponse.statusCode).toBe(302);
    expect(flow.lastResponse.headers.location).toBe('/login');
  });
});
