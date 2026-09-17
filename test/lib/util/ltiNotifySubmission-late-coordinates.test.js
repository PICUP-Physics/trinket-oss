// Reporting a submission whose Basic Outcomes coordinates arrived LATE.
//
// LTI 1.1 can only tell a platform about a submission using a per-(student,
// placement) lis_result_sourcedid, and the platform hands that over only when
// THAT student launches THAT graded assignment. A student who reaches the work
// another way — through a course or topic link, or a bookmark — and submits has
// no coordinates at submit time, so notify() silently no-ops and the LMS grader
// shows "nothing submitted" while the work sits in trinket. Measured on a live
// course: 135 of 273 student-assignment pairs had no coordinates.
//
// So when coordinates finally DO arrive at a later launch, report the submission
// the student already made — and remember on the submission which token it was
// reported against, so the retry is idempotent without being blind: a student
// whose token was captured BEFORE this code existed still gets reported, and a
// student already reported against the current token does not get re-announced.
const lti11Outcomes   = require('../../../lib/util/lti11Outcomes');
const LtiResourceLink = require('../../../lib/models/ltiResourceLink');
const LtiOutcome      = require('../../../lib/models/ltiOutcome');
const LtiConsumer     = require('../../../lib/models/ltiConsumer');
const Trinket         = require('../../../lib/models/trinket');
const notify          = require('../../../lib/util/ltiNotifySubmission');

describe('ltiNotifySubmission.notifyOnCoordinates', () => {
  let posted11;

  const PLATFORM = 'lti11:key-abc';
  const RL        = 'rl-late-1';
  const USER      = 'user-late-1';
  const MATERIAL  = 'mat-late-1';

  const assignmentLink = {
    platformId: PLATFORM, resourceLinkId: RL,
    targetType: 'assignment', targetId: MATERIAL, courseId: 'course-1'
  };
  const submitted = {
    id: 'sub-late-1', _creator: USER, courseId: 'course-1',
    materialId: MATERIAL, submittedOn: new Date('2026-09-10T00:00:00Z')
  };

  function stubLinkByLink(link) {
    vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation((p, r, cb) => cb(null, link));
  }
  function stubSubmissions(list) {
    vi.spyOn(Trinket, 'findByUserAndMaterial').mockImplementation(() => Promise.resolve(list));
  }

  beforeEach(() => {
    posted11 = [];
    vi.spyOn(lti11Outcomes, 'postSubmission').mockImplementation((a) => { posted11.push(a); return Promise.resolve({ ok: true }); });
    // notify()'s own 1.1 lookups, so a heal that reaches it can complete.
    vi.spyOn(LtiResourceLink, 'findAssignmentLink').mockImplementation((c, m, cb) => cb(null, assignmentLink));
    vi.spyOn(LtiOutcome, 'findForPlacement').mockImplementation((p, r, u, cb) => cb(null, { sourcedId: 'sid-late', serviceUrl: 'https://lms.example/outcomes' }));
    vi.spyOn(LtiConsumer, 'findByKey').mockImplementation((k, cb) => cb(null, { key: 'key-abc', secret: 'sec', disabled: false }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports the submission the student already made', async () => {
    stubLinkByLink(assignmentLink);
    stubSubmissions([submitted]);

    await notify.notifyOnCoordinates(PLATFORM, RL, USER);

    expect(posted11.length, 'the late report must fire').toBe(1);
    expect(posted11[0].sourcedId).toBe('sid-late');
    expect(posted11[0].launchUrl).toMatch(/submission=sub-late-1/);
  });

  it('reports the NEWEST submission when the student has several', async () => {
    const older = Object.assign({}, submitted, { id: 'sub-older', submittedOn: new Date('2026-09-01T00:00:00Z') });
    stubLinkByLink(assignmentLink);
    stubSubmissions([submitted, older]);   // findByUserAndMaterial sorts created desc

    await notify.notifyOnCoordinates(PLATFORM, RL, USER);

    expect(posted11.length).toBe(1);
    expect(posted11[0].launchUrl).toMatch(/submission=sub-late-1/);
  });

  it('does nothing when the placement is a topic or course link, not an assignment', async () => {
    stubLinkByLink(Object.assign({}, assignmentLink, { targetType: 'topic' }));
    stubSubmissions([submitted]);

    await notify.notifyOnCoordinates(PLATFORM, RL, USER);
    expect(posted11.length).toBe(0);
  });

  it('does nothing when no resource link is on file for the placement', async () => {
    stubLinkByLink(null);
    stubSubmissions([submitted]);

    await notify.notifyOnCoordinates(PLATFORM, RL, USER);
    expect(posted11.length).toBe(0);
  });

  it('does nothing when the student has no work on that material', async () => {
    stubLinkByLink(assignmentLink);
    stubSubmissions([]);

    await notify.notifyOnCoordinates(PLATFORM, RL, USER);
    expect(posted11.length).toBe(0);
  });

  it('does nothing for work that was started but never submitted', async () => {
    stubLinkByLink(assignmentLink);
    stubSubmissions([{ id: 'draft-1', _creator: USER, materialId: MATERIAL, courseId: 'course-1' }]);  // no submittedOn

    await notify.notifyOnCoordinates(PLATFORM, RL, USER);
    expect(posted11.length).toBe(0);
  });

  it('uses the placement it resolved by resource_link_id, not an ambiguous re-lookup', async () => {
    // A material can have a dead duplicate placement alongside the live one.
    // The late-report path already knows the exact placement, so it must not
    // hand the question back to the (course, material) lookup.
    stubLinkByLink(assignmentLink);
    stubSubmissions([submitted]);

    await notify.notifyOnCoordinates(PLATFORM, RL, USER, 'sid-late');

    expect(posted11.length).toBe(1);
    expect(LtiResourceLink.findAssignmentLink,
      'the exact placement was known — no re-lookup').not.toHaveBeenCalled();
  });

  it('never throws — a launch must not fail because gradebook bookkeeping did', async () => {
    vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => { throw new Error('firestore down'); });
    stubSubmissions([submitted]);

    await expect(notify.notifyOnCoordinates(PLATFORM, RL, USER)).resolves.toBeDefined();
    expect(posted11.length).toBe(0);
  });
});

describe('ltiNotifySubmission: the reported-against marker makes the retry idempotent', () => {
  let posted11, saved;

  const PLATFORM = 'lti11:key-abc';
  const RL = 'rl-mark-1';
  const USER = 'user-mark-1';
  const MATERIAL = 'mat-mark-1';
  const TOKEN = 'sid-current';

  const assignmentLink = {
    platformId: PLATFORM, resourceLinkId: RL,
    targetType: 'assignment', targetId: MATERIAL, courseId: 'course-1'
  };

  function submission(extra) {
    return Object.assign({
      id: 'sub-mark-1', _creator: USER, courseId: 'course-1', materialId: MATERIAL,
      submittedOn: new Date('2026-09-10T00:00:00Z'),
      save: function () { saved.push({ sourcedId: this.ltiReportedSourcedId, at: this.ltiReportedAt }); return Promise.resolve(this); }
    }, extra || {});
  }

  beforeEach(() => {
    posted11 = []; saved = [];
    vi.spyOn(lti11Outcomes, 'postSubmission').mockImplementation((a) => { posted11.push(a); return Promise.resolve({ ok: true }); });
    vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation((p, r, cb) => cb(null, assignmentLink));
    vi.spyOn(LtiResourceLink, 'findAssignmentLink').mockImplementation((c, m, cb) => cb(null, assignmentLink));
    vi.spyOn(LtiOutcome, 'findForPlacement').mockImplementation((p, r, u, cb) => cb(null, { sourcedId: TOKEN, serviceUrl: 'https://lms.example/outcomes' }));
    vi.spyOn(LtiConsumer, 'findByKey').mockImplementation((k, cb) => cb(null, { key: 'key-abc', secret: 'sec', disabled: false }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('reports work whose token was captured before this code existed (no marker)', async () => {
    // The window that made gating on "is the token new" wrong: these students
    // clicked their assignment already, so nothing about the token is new.
    vi.spyOn(Trinket, 'findByUserAndMaterial').mockImplementation(() => Promise.resolve([submission()]));

    await notify.notifyOnCoordinates(PLATFORM, RL, USER, TOKEN);
    expect(posted11.length, 'an unmarked submission must be reported').toBe(1);
  });

  it('records the token it reported against', async () => {
    vi.spyOn(Trinket, 'findByUserAndMaterial').mockImplementation(() => Promise.resolve([submission()]));

    await notify.notifyOnCoordinates(PLATFORM, RL, USER, TOKEN);
    expect(saved.length, 'the marker must be persisted').toBe(1);
    expect(saved[0].sourcedId).toBe(TOKEN);
    expect(saved[0].at).toBeInstanceOf(Date);
  });

  it('does not re-announce a submission already reported against this token', async () => {
    vi.spyOn(Trinket, 'findByUserAndMaterial').mockImplementation(
      () => Promise.resolve([submission({ ltiReportedSourcedId: TOKEN, ltiReportedAt: new Date() })]));

    await notify.notifyOnCoordinates(PLATFORM, RL, USER, TOKEN);
    expect(posted11.length, 'a routine relaunch must stay quiet').toBe(0);
  });

  it('reports again when the platform reissued a different token', async () => {
    // An assignment re-created in the LMS mints new sourcedids; the old one is
    // dead, so the submission has to be re-announced against the new one.
    vi.spyOn(Trinket, 'findByUserAndMaterial').mockImplementation(
      () => Promise.resolve([submission({ ltiReportedSourcedId: 'sid-stale', ltiReportedAt: new Date() })]));

    await notify.notifyOnCoordinates(PLATFORM, RL, USER, TOKEN);
    expect(posted11.length).toBe(1);
    expect(saved[0].sourcedId).toBe(TOKEN);
  });

  it('retries after a failed post — a failure leaves no marker', async () => {
    vi.spyOn(Trinket, 'findByUserAndMaterial').mockImplementation(() => Promise.resolve([submission()]));
    lti11Outcomes.postSubmission.mockImplementation(() => Promise.reject(new Error('429 from the platform')));

    await notify.notifyOnCoordinates(PLATFORM, RL, USER, TOKEN);
    expect(saved.length, 'a failed report must not be marked as reported').toBe(0);
  });
});
