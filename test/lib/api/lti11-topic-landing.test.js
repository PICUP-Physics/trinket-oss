'use strict';

// An LTI 1.1 topic link must land on the topic's page, like 1.3 does.
//
// MIAuthors/trinket-oss#13. The 1.3 launch handles assignment, topic and page.
// The 1.1 launch handled ONLY assignment — there was no topic branch at all —
// so a topic link resolved correctly upstream (ltiTarget populates lessonSlug
// and materialSlug) and was then silently dropped, leaving the user on the bare
// course page.
//
// That is why the same link behaved differently for two people: reported against
// WileyPLUS, which is LTI 1.1 only, and NOT reproducible on Brightspace, which is
// 1.3. The reporter is an instructor, so the course landing page he arrived at was
// the hidden admin page — looking like a permissions bug rather than a routing one.
const flow        = require('../../helpers/flow.cjs');
const config      = require('config');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const ltiTarget   = require('../../../lib/util/ltiTarget');
const v           = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');

const AUTHORITY = 'localhost';
const PATH = '/lti11/launch';
const serverUrl = () => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path: PATH },
  config.app.url, publicHostname.resolve);

function baseParams(consumer, extra) {
  return Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-topic-1',
    user_id: 'student-topic-1',
    roles: 'Learner',
    lis_person_contact_email_primary: 'topic-student@example.com',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'u-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
}

async function seedConsumer() {
  const c = new LtiConsumer({ key: 'u-' + Math.random().toString(36).slice(2, 10),
                              secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'topic landing' });
  await c.save();
  return c;
}

// A resolved TOPIC, exactly as ltiTarget returns one.
// The handler enrols the launching user before redirecting, so the stub course
// needs addUser/updateRole as well as its slugs.
function stubCourse() {
  return {
    id: 'c1', ownerSlug: 'teacher', slug: 'physics-1',
    addUser:    () => Promise.resolve(),
    updateRole: () => Promise.resolve()
  };
}

function topicTarget() {
  return { course: stubCourse(), topic: { lessonSlug: 'chapter-3', materialSlug: 'momentum-intro' } };
}

describe('LTI 1.1 topic link landing (#13)', () => {
  beforeEach(() => { flow.cookies = {}; });
  afterEach(() => vi.restoreAllMocks());

  it('lands on the topic page, not the bare course page', async () => {
    vi.spyOn(ltiTarget, 'resolveTarget').mockImplementation(() => Promise.resolve(topicTarget()));
    const c = await seedConsumer();
    const body = baseParams(c);
    body.oauth_signature = v.sign('POST', serverUrl(), body, c.secret);
    await flow._inject('POST', 'http://' + AUTHORITY + PATH, body);

    expect(flow.lastResponse.statusCode).toBe(302);
    const loc = flow.lastResponse.headers.location || '';
    expect(loc, 'a 1.1 topic launch must reach the topic page like 1.3 does')
      .toContain('#/chapter-3/momentum-intro');
  });

  it('still lands an assignment on its own page', async () => {
    vi.spyOn(ltiTarget, 'resolveTarget').mockImplementation(() => Promise.resolve({
      course: stubCourse(),
      assignment: { lessonSlug: 'chapter-1', materialSlug: 'hw-1' }
    }));
    const c = await seedConsumer();
    const body = baseParams(c);
    body.oauth_signature = v.sign('POST', serverUrl(), body, c.secret);
    await flow._inject('POST', 'http://' + AUTHORITY + PATH, body);
    expect(flow.lastResponse.headers.location || '').toContain('#/chapter-1/hw-1');
  });

  it('leaves a bare course launch on the course page', async () => {
    vi.spyOn(ltiTarget, 'resolveTarget').mockImplementation(() => Promise.resolve({
      course: stubCourse()
    }));
    const c = await seedConsumer();
    const body = baseParams(c);
    body.oauth_signature = v.sign('POST', serverUrl(), body, c.secret);
    await flow._inject('POST', 'http://' + AUTHORITY + PATH, body);
    const loc = flow.lastResponse.headers.location || '';
    expect(loc).toContain('/teacher/courses/physics-1');
    expect(loc).not.toContain('#/');
  });
});
