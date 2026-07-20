// Regression for M&I #7 (persistent "modified in another window" conflict).
//
// getMaterial used to run normalizeEmbedUrls on serve (https://host -> //host),
// but patchContent applies the editor's diff to the RAW stored content. So the
// editor's patch base never matched storage and every save conflicted forever,
// for any imported material with an embed. Fix B: serve the editor canonical
// (un-normalized) content, so a diff computed against what the editor received
// applies cleanly to storage.
const diff = require('diff');
const flow = require('../../helpers/flow.cjs');

const EMBED = "<iframe src='https://trinket.matterandinteractions.org/embed/glowscript/560a26a065c8?start=result' width='100%'></iframe>";
const CONTENT = 'Intro line.\n\n' + EMBED + '\n\nSome text after the embed.\n';

describe('editor embed conflict (M&I #7): serve canonical content so patches apply', () => {
  let courseId, lessonId, materialId;

  beforeEach(async () => {
    flow.cookies = {};
    await flow.switchUser('user');
    await flow.createCourse();
    const course = flow.lastResponse.body.course;
    courseId = course.id;
    lessonId = course.lessons && course.lessons[0] && (course.lessons[0].id || course.lessons[0]);
    if (!lessonId) {
      await flow.addNewLesson(courseId, { name: 'L' });
      lessonId = (flow.lastResponse.body.data || flow.lastResponse.body.lesson).id;
    }
    await flow.addNewMaterial(courseId, lessonId, { name: 'M', content: CONTENT });
    materialId = (flow.lastResponse.body.material || flow.lastResponse.body.data).id;
  });

  it('getMaterial returns the embed unchanged (not rewritten to //host)', async () => {
    await flow.getMaterial(courseId, lessonId, materialId);
    const served = flow.lastResponse.body.data.content;
    expect(served).toContain("src='https://trinket.matterandinteractions.org/embed"); // canonical, as stored
    expect(served).not.toContain("src='//trinket.matterandinteractions.org/embed");   // NOT normalized
  });

  it('a patch computed against the served content applies (no phantom conflict)', async () => {
    await flow.getMaterial(courseId, lessonId, materialId);
    const served = flow.lastResponse.body.data.content;          // what the editor loads
    const edited = served + 'An edit the user made.\n';          // editor edits
    const full = diff.createPatch('m', served, edited);
    const hunk = full.slice(full.indexOf('@@'));                 // client sends just the hunk(s)

    await flow.patchMaterialContent(courseId, lessonId, materialId, { patch: hunk });

    expect(flow.lastResponse.statusCode).toBe(200);
    // success path returns the saved material; conflict would return data.message
    const body = flow.lastResponse.body;
    expect(body.material).toBeDefined();
    expect(body.data && body.data.message).toBeUndefined();
    expect(body.material.content).toContain('An edit the user made.');
  });
});
