// An assignment created through the API without the four "...Enabled" date flags
// (#377). The editor always sends them, so the server assumed they were there:
//
//   setDates()            stored enabled = undefined, which Firestore drops
//   isVisible()           then threw, and the student course outline 500'd for
//                         everyone but the owner (whose view skips the check)
//   updateMySubmission    threw the same way, reported as 403
//
// No date config means no date restrictions.
const flow = require('../../helpers/flow.cjs');
const Material = require('../../../lib/models/material');

const DATE_FIELDS = ['availableOn', 'hideAfter', 'submissionsDue', 'submissionsCutoff'];

describe('assignments with no date settings (#377)', () => {
  beforeEach(() => { flow.cookies = {}; });

  it('setDates stores enabled: false when the flags are left out', () => {
    const material = new Material({ name: 'no flags', type: 'assignment' });
    material.trinket = { name: 'x', lang: 'python3' };
    material.setDates({});
    DATE_FIELDS.forEach((field) => {
      expect(material.trinket[field] && material.trinket[field].enabled,
        field + '.enabled must be a stored boolean, not undefined').toBe(false);
    });
  });

  it('isVisible treats an assignment with no date objects as visible', () => {
    const isVisible = new Material({ name: 'probe' }).isVisible;
    const dateless = { type: 'assignment', trinket: { name: 'x', lang: 'python3' } };
    expect(() => isVisible.call(dateless),
      'a missing date must not throw and take the whole course outline down').not.toThrow();
    expect(isVisible.call(dateless)).toBe(true);
  });

  it('does not 403 a resubmission to an assignment that has no date settings', async () => {
    await flow.switchUser('user');
    await flow.createCourse({ name: 'nodates ' + Math.random().toString(36).slice(2, 6) });
    const course = flow.lastResponse.body.course;
    await flow.post(`/api/courses/${course.id}/lessons`, { name: 'lesson' });
    const lb = flow.lastResponse.body;
    const lesson = lb.lesson || lb.data || lb;
    await flow.post(`/api/courses/${course.id}/lessons/${lesson.id}/materials`,
      { name: 'assignment', type: 'assignment', lang: 'python3', trinketId: '_blank_' });
    const mb = flow.lastResponse.body;
    const material = mb.material || mb.data || mb;

    await flow.post(
      `/api/courses/${course.id}/lessons/${lesson.id}/materials/${material.id}/submissions`,
      { code: { files: {} }, comments: '', parent: material.trinket.trinketId });
    expect(flow.lastResponse.statusCode).toBe(200);
    const submission = flow.lastResponse.body.submission;

    // Mongoose defaults the date objects into existence and Firestore does not, so
    // stub the Firestore shape directly to prove the guard on either backend.
    vi.spyOn(Material, 'findById').mockImplementation(() => Promise.resolve({
      id: material.id,
      trinket: { trinketId: material.trinket.trinketId, name: 'x', lang: 'python3' }
    }));
    try {
      await flow.post(`/api/submissions/${submission.id}`, { code: { files: {} }, comments: 'again' });
      expect(flow.lastResponse.statusCode,
        'no date config means no date restrictions, not a refusal').toBe(200);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
