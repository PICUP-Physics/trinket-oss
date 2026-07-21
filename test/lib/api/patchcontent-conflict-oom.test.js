// Regression: patchContent conflict must NOT re-serialize the Hapi Response.
//
// Bug (picup #58 / M&I #7): on a non-applying patch, updateMaterial returned
// `request.fail(...)` from inside the promise chain, but a trailing
// `.then(savedMaterial => request.success({material: savedMaterial}))` then ran
// with `savedMaterial` = the Hapi Response object. request.success →
// ObjectUtils.serialize walked the whole response→request→server graph (huge,
// circular) → heap runaway → OOM/SIGABRT crash loop in production (the client's
// autosave retried the same conflicting patch every ~10s). The fix nests
// request.success inside material.save() so the conflict short-circuits.
const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

function mb() { return Math.round(process.memoryUsage().heapUsed / 1048576); }

describe('patchContent conflict does not blow up the heap (issue #58/#7)', () => {
  let courseId, lessonId, materialId;

  beforeEach(async () => {
    flow.cookies = {};
    await flow.switchUser('user');
    await flow.createCourse();
    const course = flow.lastResponse.body.course;
    courseId = course.id;
    lessonId = course.lessons && course.lessons[0] && (course.lessons[0].id || course.lessons[0]);
    if (!lessonId) {
      await flow.addNewLesson(courseId, { name: 'Lesson 1' });
      lessonId = (flow.lastResponse.body.data || flow.lastResponse.body.lesson).id;
    }
    await flow.addNewMaterial(courseId, lessonId, { name: 'Introduction', content: 'alpha\nbeta\ngamma\n' });
    materialId = (flow.lastResponse.body.material || flow.lastResponse.body.data).id;
  });

  it('returns the conflict message (not a 500) on a non-applying patch', async () => {
    // A patch whose context (line 2 = 'XXXXX') does not match the material
    // (line 2 = 'beta') → diff.applyPatch returns false → conflict path.
    const badPatch = '@@ -1,3 +1,3 @@\n alpha\n-XXXXX\n+delta\n gamma\n';
    const before = mb();
    await flow.patchMaterialContent(courseId, lessonId, materialId, { patch: badPatch });
    const delta = mb() - before;

    // Before the fix this threw a 500 (the Hapi Response was serialized through
    // request.success) and spiked the heap tens of MB.
    expect(flow.lastResponse.statusCode).not.toBe(500);
    const body = flow.lastResponse.body;
    const msg = (body && body.data && body.data.message) || '';
    expect(msg).toMatch(/modified in another window/);
    expect(delta).toBeLessThan(20); // no runaway allocation on one conflict
  });

  it('still applies a valid patch (success path intact)', async () => {
    // Inserts a line after 'beta' — context matches, so it applies cleanly.
    const goodPatch = '@@ -1,3 +1,4 @@\n alpha\n beta\n+inserted\n gamma\n';
    await flow.patchMaterialContent(courseId, lessonId, materialId, { patch: goodPatch });
    expect(flow.wasOk).toBe(true);
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(flow.lastResponse.body.material.content).toContain('inserted');
  });
});
