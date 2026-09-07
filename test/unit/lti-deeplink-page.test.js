'use strict';

// Deep-linking a PAGE, not just a topic. MIAuthors/trinket-oss#13.
//
// A topic has no URL of its own: the course SPA's param routes are all
// two-segment (/:lessonSlug/:materialSlug), so a bare lesson fragment bounces to
// the course root. The launch handler works around that by landing a topic link
// on the topic's FIRST material — which is why an instructor who picks a topic
// gets a page they did not choose. Reported from a live Canvas course.
//
// A page is just a material that is not an assignment, so it can carry the same
// coordinates an assignment already does. What it must NOT carry is a line item:
// linking a page is not creating gradable work.
const dl13 = require('../../lib/util/ltiDeepLinking');
const dl11 = require('../../lib/util/lti11DeepLinking');

describe('deep-linking a page (#13)', () => {
  describe('LTI 1.3 content item', () => {
    it('carries the page id so the launch can land on it', () => {
      const item = dl13.linkContentItem({ courseId: 'c1', pageId: 'm7', title: 'Ch 3 — Momentum' });
      expect(item.custom.trinket_course).toBe('c1');
      expect(item.custom.trinket_page).toBe('m7');
    });

    it('is not a graded item — no lineItem', () => {
      const item = dl13.linkContentItem({ courseId: 'c1', pageId: 'm7', title: 'P' });
      expect(item.lineItem).toBeUndefined();
    });

    it('leaves topic and course links exactly as they were', () => {
      const topic = dl13.linkContentItem({ courseId: 'c1', lessonId: 'l1', title: 'T' });
      expect(topic.custom.trinket_topic).toBe('l1');
      expect(topic.custom.trinket_page).toBeUndefined();

      const course = dl13.linkContentItem({ courseId: 'c1', title: 'C' });
      expect(course.custom.trinket_topic).toBeUndefined();
      expect(course.custom.trinket_page).toBeUndefined();
    });
  });

  describe('LTI 1.1 content item', () => {
    // Canvas replays the stored URL verbatim and ignores custom on 1.1, so the
    // targeting has to ride in the URL as well.
    it('puts the page in the URL and in custom', () => {
      const item = dl11.linkContentItem({ courseId: 'c1', pageId: 'm7', title: 'P' });
      expect(item.url).toContain('page=m7');
      expect(item.custom.trinket_page).toBe('m7');
    });

    it('a course link still carries neither topic nor page', () => {
      const course = dl11.linkContentItem({ courseId: 'c1', title: 'C' });
      expect(course.url).not.toContain('page=');
      expect(course.url).not.toContain('topic=');
    });
  });
});
