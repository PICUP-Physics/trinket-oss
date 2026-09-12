// Per-placement PAGE targeting via the launch URL: /lti11/launch?course=<id>&page=<materialId>.
//
// MIAuthors/trinket-oss#13 (picup #241 added the page picker). lti11DeepLinking puts
// `page=` in the content-item URL on purpose — Canvas/WileyPLUS ignore `custom` on
// 1.1 items and replay the stored URL verbatim — so the launch intake must copy it
// into custom.trinket_page the same way it already copies course/assignment/topic.
// Without that, a deep-linked page lands on the bare course.
const flow     = require('../../helpers/flow.cjs');
const config   = require('config');
const LtiConsumer = require('../../../lib/models/ltiConsumer');
const ltiTarget = require('../../../lib/util/ltiTarget');
const v        = require('../../../lib/util/lti11Verify');
const publicHostname = require('../../../lib/util/publicHostname');

const LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
const AUTHORITY = 'localhost';
const PATH = '/lti11/launch';
const serverUrl = () => v.launchUrlFromRequest(
  { headers: { host: AUTHORITY }, info: { hostname: AUTHORITY }, path: PATH },
  config.app.url, publicHostname.resolve);

function baseParams(consumer, extra) {
  return Object.assign({
    lti_message_type: 'basic-lti-launch-request',
    lti_version: 'LTI-1p0',
    resource_link_id: 'rl-page-url-1',
    user_id: 'student-page-url-1',
    roles: 'Learner',
    lis_person_contact_email_primary: 'pagetarget@example.com',
    lis_person_name_full: 'Page Target',
    oauth_consumer_key: consumer.key,
    oauth_nonce: 'u-' + Math.random().toString(36).slice(2),
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_version: '1.0'
  }, extra || {});
}

async function seedConsumer() {
  const c = new LtiConsumer({ key: 'u-' + Math.random().toString(36).slice(2, 10),
                              secret: 'shhh-' + Math.random().toString(36).slice(2), name: 'page url target' });
  await c.save();
  return c;
}

describe('LTI 1.1 launch-URL page targeting (#13)', () => {
  let seenClaims;
  beforeEach(() => {
    flow.cookies = {};
    seenClaims = [];
    vi.spyOn(ltiTarget, 'resolveTarget').mockImplementation((claims) => {
      seenClaims.push(claims); return Promise.resolve({ course: null });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('passes ?course=&page= through as trinket_course + trinket_page', async () => {
    const consumer = await seedConsumer();
    const query = { course: 'c1', page: 'm7' };
    const body = baseParams(consumer);
    body.oauth_signature = v.sign('POST', serverUrl(), Object.assign({}, query, body), consumer.secret);

    await flow._inject('POST', 'http://' + AUTHORITY + PATH + '?course=c1&page=m7', body);

    expect(flow.lastResponse.statusCode).toBe(302);
    expect(seenClaims.length, 'the launch must reach target resolution').toBe(1);
    const custom = seenClaims[0][LTI + 'custom'];
    expect(custom.trinket_course).toBe('c1');
    expect(custom.trinket_page, 'the page in the deep-linked URL must survive intake').toBe('m7');
  });

  it('ignores a malformed page id rather than failing the launch', async () => {
    const consumer = await seedConsumer();
    const query = { page: '../../etc/passwd' };
    const body = baseParams(consumer);
    body.oauth_signature = v.sign('POST', serverUrl(), Object.assign({}, query, body), consumer.secret);

    await flow._inject('POST', 'http://' + AUTHORITY + PATH + '?page=' + encodeURIComponent(query.page), body);

    expect(flow.lastResponse.statusCode).toBe(302);
    expect(seenClaims[0][LTI + 'custom'].trinket_page).toBeUndefined();
  });
});
