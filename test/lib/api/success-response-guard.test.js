// Defense-in-depth for #58: request.success must never serialize a Hapi Response.
//
// This branch intentionally does NOT include the updateMaterial short-circuit
// fix, so the conflict path still returns request.fail(...) into a trailing
// .then(request.success). Without the guard that serializes the Hapi Response
// (response->request->server graph) and blows the heap (500 + big spike). With
// the isHapiResponse guard in request.success, the Response is passed straight
// through -> clean conflict, no runaway.
const flow = require('../../helpers/flow.cjs');

function mb() { return Math.round(process.memoryUsage().heapUsed / 1048576); }

describe('request.success guard: Hapi Response is not re-serialized (#58 defense-in-depth)', () => {
  it('handles a patchContent conflict cleanly even with the un-fixed handler', async () => {
    flow.cookies = {};
    await flow.switchUser('user');
    await flow.createCourse();
    const course = flow.lastResponse.body.course;
    let lessonId = course.lessons && course.lessons[0] && (course.lessons[0].id || course.lessons[0]);
    if (!lessonId) {
      await flow.addNewLesson(course.id, { name: 'Lesson 1' });
      lessonId = (flow.lastResponse.body.data || flow.lastResponse.body.lesson).id;
    }
    await flow.addNewMaterial(course.id, lessonId, { name: 'M', content: 'alpha\nbeta\ngamma\n' });
    const materialId = (flow.lastResponse.body.material || flow.lastResponse.body.data).id;

    const badPatch = '@@ -1,3 +1,3 @@\n alpha\n-XXXXX\n+delta\n gamma\n'; // context mismatch -> conflict
    const before = mb();
    await flow.patchMaterialContent(course.id, lessonId, materialId, { patch: badPatch });
    const delta = mb() - before;

    expect(flow.lastResponse.statusCode).not.toBe(500);
    const msg = (flow.lastResponse.body && flow.lastResponse.body.data && flow.lastResponse.body.data.message) || '';
    expect(msg).toMatch(/modified in another window/);
    expect(delta).toBeLessThan(20);
  });
});
