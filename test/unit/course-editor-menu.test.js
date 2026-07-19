'use strict';

// Delete Course must be reachable from the "Course" dropdown — the menu that
// already offers Edit / Copy / Download / Archive. Deletion used to live ONLY
// as an unlabelled trash icon inside the Edit-course-details modal, so a user
// looking for it in the obvious place found Archive and nothing else. Reported
// on picup 2026-07-16: he concluded delete didn't exist, archived instead, then
// deleted every trinket by hand to empty the course.
//
// These are static markup assertions (there is no Angular/DOM harness here).
// They are cheap and they cover a bug class this repo has actually shipped:
// PR #52 fixed a reveal trigger pointing at modal markup that didn't exist.

const fs   = require('fs');
const path = require('path');

const PARTIAL = path.join(__dirname, '../../public/partials/course_editor.html');
const ROOT_JS = path.join(__dirname, '../../public/js/courseEditor/controllers/root.js');

const html = fs.readFileSync(PARTIAL, 'utf8');
const js   = fs.readFileSync(ROOT_JS, 'utf8');

// The <ul id="course-actions"> ... </ul> block.
function courseActionsMenu() {
  const start = html.indexOf('id="course-actions"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</ul>', start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('course actions menu', () => {
  it('offers Delete Course alongside Archive', () => {
    const menu = courseActionsMenu();
    expect(menu).toContain('Archive Course');       // guards the slice itself
    expect(menu).toContain('Delete Course');
  });

  it('gates Delete Course on the delete permission', () => {
    const menu = courseActionsMenu();
    const item = menu.split('\n').filter((l) => l.includes('Delete Course'))[0];
    expect(item).toBeTruthy();
    expect(item).toContain('canDeleteCourse');
  });

  it('shows the menu when delete is the only permitted action', () => {
    // The <ul>'s own ng-if must admit canDeleteCourse, or a user who may delete
    // but not copy/update/manage never sees the menu that holds the item.
    const menu = courseActionsMenu();
    const ngIf = /ng-if="([^"]*)"/.exec(menu);
    expect(ngIf).toBeTruthy();
    expect(ngIf[1]).toContain('canDeleteCourse');
  });

  it('opens a dialog that actually exists in the partial', () => {
    // The PR #52 failure mode: a trigger referencing absent modal markup.
    expect(js).toContain('openDeleteCourseModal');
    const opener = /openDeleteCourseModal[\s\S]{0,200}?\$\('#([\w-]+)'\)/.exec(js);
    expect(opener).toBeTruthy();
    expect(html).toContain('id="' + opener[1] + '"');
  });
});
