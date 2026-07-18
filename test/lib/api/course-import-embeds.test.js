'use strict';

// picup #51 (integration): a course imported with a shortcode-LESS trinket.io
// embed in its material must have that embed rewritten to THIS server. Exercises
// the real course-import path (parseCourseZip → resolveAllRefs → create), which
// the pure-helper unit tests bypass. Regression guard for the early-return in
// resolveAllRefs that skipped the rewrite when no *shortcoded* refs were present.

const JSZip = require('jszip');
const flow  = require('../../helpers/flow.cjs');

beforeEach(() => { flow.cookies = {}; });

// Minimal course zip in the format parseCourseZip expects:
//   course.json { lessons: [{ slug, name, materials: [{ slug, name, type }] }] }
//   <NN-lessonSlug>/<NN-materialSlug>.md   (material content)
function buildCourseZip(materialContent) {
  const zip = new JSZip();
  zip.file('course.json', JSON.stringify({
    lessons: [{
      slug: 'lesson-one', name: 'Lesson One', isDraft: false,
      materials: [{ slug: 'page-one', name: 'Page One', type: 'page' }]
    }]
  }));
  zip.file('00-lesson-one/00-page-one.md', materialContent);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function importedMaterialContent(courseId) {
  await flow.get('/api/courses/' + courseId + '?outline=true&withContent=true');
  const course  = flow.lastResponse.body.data || {};
  const lessons = course.lessons || [];
  for (const l of lessons) {
    for (const m of (l.materials || [])) {
      if (m.content) return m.content;
    }
  }
  return null;
}

describe('Course import — trinket.io embed rewrite (#51)', () => {
  it('rewrites a shortcode-less trinket.io embed in imported material', async () => {
    await flow.switchUser('user');
    const zip = await buildCourseZip('<iframe src="https://trinket.io/embed/glowscript"></iframe>');

    const r = await flow.importCourseZip(zip, { name: 'Embed Course' });
    expect(r.statusCode).toBe(200);
    expect(r.body.data.status).toBe('ok');

    const content = await importedMaterialContent(r.body.data.courseId);
    expect(content).toBeTruthy();
    // Pre-fix this FAILS: the empty-shortCodes early return in resolveAllRefs
    // skips the rewrite, so the embed still points at trinket.io.
    expect(content).not.toContain('trinket.io');
    expect(content).toContain('/embed/glowscript');
  });
});
