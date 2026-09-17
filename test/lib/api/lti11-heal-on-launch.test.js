// A 1.1 launch reports a submission the student had already made.
//
// The real sequence from a live course: the student enters through a course or
// topic link (which carries no per-assignment sourcedid), navigates to the
// assignment inside trinket, and submits. At that moment trinket has no way to
// tell Canvas — 1.1 can only post with a per-(student, placement) sourcedid —
// so SpeedGrader says "nothing submitted" over real work. 135 of 273
// student-assignment pairs in that course were in this state.
//
// When the student later launches the graded assignment, the coordinates
// finally arrive. That launch must report the existing submission.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const LtiConsumer     = require('../../../lib/models/ltiConsumer');
const LtiResourceLink = require('../../../lib/models/ltiResourceLink');
const Trinket         = require('../../../lib/models/trinket');
const User            = require('../../../lib/models/user');
const lti11Outcomes   = require('../../../lib/util/lti11Outcomes');
const v               = require('../../../lib/util/lti11Verify');
const publicHostname  = require('../../../lib/util/publicHostname');

const AUTHORITY = 'localhost';
const LAUNCH = '/lti11/launch';
const RL = 'rl-heal-assignment';      // the graded assignment placement
const RL_COURSE = 'rl-heal-course';   // the course link the student entered through
const STUDENT = 'student-heal-1';
const EMAIL = 'heal-student@example.com';

const serverUrl = (path) => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path },
  config.app.url, publicHostname.resolve);

function signedLaunch(consumer, extra) {
  const p = Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: RL,   // override via `extra` for the course-link entry
    user_id: STUDENT,
    roles: 'Learner',
    lis_person_contact_email_primary: EMAIL,
    lis_person_name_full: 'Heal Student',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'hl-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
  p.oauth_signature = v.sign('POST', serverUrl(LAUNCH), p, consumer.secret);
  return p;
}

// The report is fire-and-forget so bookkeeping can never fail a launch, so the
// 302 can beat it. Poll rather than race.
// A 24-hex id: a valid ObjectId for the mongo leg and an ordinary string id on
// firestore, so the same test runs on both backends.
const hexId = () => Array.from({ length: 24 },
  () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

async function waitForPost(posted, n) {
  for (let i = 0; i < 60; i++) {
    if (posted.length >= n) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

describe('LTI 1.1: a launch reports a submission made before coordinates existed', () => {
  let posted;

  beforeEach(() => {
    flow.cookies = {};
    posted = [];
    vi.spyOn(lti11Outcomes, 'postSubmission').mockImplementation((a) => {
      posted.push(a); return Promise.resolve({ ok: true });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const consumer = new LtiConsumer({
      key: 'hl-' + Math.random().toString(36).slice(2, 10),
      secret: 'shhh-' + Math.random().toString(36).slice(2),
      name: 'heal test'
    });
    await consumer.save();

    await flow.switchUser('user');
    await flow.createCourse({ name: 'Heal Course ' + Math.random().toString(36).slice(2, 7) });
    const course = flow.lastResponse.body.course;
    flow.cookies = {};

    // Launch 1: the ungraded COURSE-link entry — its own placement, as in
    // Canvas. Creates the student and captures NO coordinates (a course link
    // carries no per-assignment sourcedid).
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH,
      signedLaunch(consumer, { resource_link_id: RL_COURSE, custom_trinket_course: course.id }));
    expect(flow.lastResponse.statusCode).toBe(302);
    const student = await User.findByLogin(EMAIL);
    expect(student, 'the launch should have provisioned the student').toBeTruthy();

    // The graded assignment placement, and the work the student submitted
    // through trinket's own course UI while unreportable.
    const materialId = hexId();
    await new LtiResourceLink({
      platformId: 'lti11:' + consumer.key, resourceLinkId: RL,
      targetType: 'assignment', targetId: materialId, courseId: String(course.id)
    }).save();
    const submission = new Trinket({
      name: 'Heal Submission', lang: 'python3', _creator: String(student.id),
      _owner: String(student.id), courseId: String(course.id), materialId: materialId,
      submittedOn: new Date()
    });
    await submission.save();

    return { consumer, course, student, materialId, submission };
  }

  it('posts Basic Outcomes for the already-submitted work when the sourcedid arrives', async () => {
    const { consumer, submission } = await setup();
    expect(posted.length, 'nothing reportable before coordinates exist').toBe(0);

    // Launch 2: the student clicks the graded assignment. Coordinates arrive.
    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, {
      lis_result_sourcedid: 'sourced-heal-1',
      lis_outcome_service_url: 'https://lms.example/outcomes'
    }));
    expect(flow.lastResponse.statusCode).toBe(302);

    expect(await waitForPost(posted, 1), 'the late report should fire').toBe(true);
    expect(posted[0].sourcedId).toBe('sourced-heal-1');
    expect(posted[0].serviceUrl).toBe('https://lms.example/outcomes');
    expect(posted[0].launchUrl).toBe(config.url + '/lti11/launch?submission=' + submission.id);
    expect(posted[0].score, 'still no grade — trinket does not grade').toBeUndefined();
  });

  it('reports work whose token was captured BEFORE this code shipped', async () => {
    // The pre-deploy window: the student already clicked their assignment, so
    // the token is on file and nothing about it is new. They must still be
    // reported — this is the case that gating on token novelty would lose.
    const { consumer, submission } = await setup();
    const graded = { lis_result_sourcedid: 'sourced-preexisting',
                     lis_outcome_service_url: 'https://lms.example/outcomes' };

    // Simulate the old code: capture the token with no report.
    const LtiOutcome = require('../../../lib/models/ltiOutcome');
    await LtiOutcome.record({
      platformId: 'lti11:' + consumer.key, resourceLinkId: RL,
      userId: String(submission._creator), sourcedId: graded.lis_result_sourcedid,
      serviceUrl: graded.lis_outcome_service_url });
    expect(posted.length, 'nothing reported by the capture alone').toBe(0);

    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, graded));
    expect(flow.lastResponse.statusCode).toBe(302);
    expect(await waitForPost(posted, 1), 'the pre-existing token must still report').toBe(true);
    expect(posted[0].sourcedId).toBe('sourced-preexisting');
  });

  it('does not report again on a routine relaunch with the same coordinates', async () => {
    const { consumer } = await setup();

    const graded = { lis_result_sourcedid: 'sourced-heal-2',
                     lis_outcome_service_url: 'https://lms.example/outcomes' };
    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, graded));
    expect(await waitForPost(posted, 1)).toBe(true);
    const after = posted.length;

    // Same sourcedid again: we learned nothing new, so stay quiet.
    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, graded));
    expect(flow.lastResponse.statusCode).toBe(302);
    await new Promise(r => setTimeout(r, 400));
    expect(posted.length, 'a relaunch must not re-report').toBe(after);
  });

  it('reports again when the platform reissues a different sourcedid', async () => {
    const { consumer } = await setup();

    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, {
      lis_result_sourcedid: 'sourced-old', lis_outcome_service_url: 'https://lms.example/outcomes' }));
    expect(await waitForPost(posted, 1)).toBe(true);

    // An assignment re-created in the LMS mints new sourcedids; the old one is
    // dead, so the submission has to be re-reported against the new one.
    flow.cookies = {};
    await flow._inject('POST', 'http://' + AUTHORITY + LAUNCH, signedLaunch(consumer, {
      lis_result_sourcedid: 'sourced-new', lis_outcome_service_url: 'https://lms.example/outcomes' }));
    expect(await waitForPost(posted, 2), 'a reissued sourcedid should re-report').toBe(true);
    expect(posted[posted.length - 1].sourcedId).toBe('sourced-new');
  });
});
