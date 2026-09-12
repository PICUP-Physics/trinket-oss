'use strict';

// ltiTarget.resolveTarget for a PAGE link. MIAuthors/trinket-oss#13.
//
// The bootstrap path classified `trinket_page` as targetType 'page' but never
// resolved it: only assignment (resolveMaterial) and topic (resolveTopic) had a
// resolution branch, so `page` fell through to {} — the persisted
// LtiResourceLink got no lessonSlug/materialSlug and the returned object had no
// `page` key. Both launch handlers check `target.page && target.page.lessonSlug`
// and fall through to the bare course. The cached path (repeat launches on the
// same resource_link_id) then returned `{ course, targetType: 'page' }` with no
// coordinates at all, so even a correctly-persisted record would not land.
//
// Live links have ALREADY persisted slug-less 'page' records, so the cached
// path must heal them by re-resolving from the stored targetId (as topic does).
const Course          = require('../../lib/models/course');
const Lesson          = require('../../lib/models/lesson');
const Material        = require('../../lib/models/material');
const LtiResourceLink = require('../../lib/models/ltiResourceLink');
const ltiTarget       = require('../../lib/util/ltiTarget');

const LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
const platform = { id: 'lti11:page-key' };

// A course whose single lesson holds two materials; m7 is the page we link.
const course    = { id: 'c1', ownerSlug: 'teacher', slug: 'physics-1', lessons: ['l1'] };
const lessons   = { l1: { id: 'l1', slug: 'chapter-3', materials: ['m6', 'm7'] } };
const materials = { m6: { id: 'm6', slug: 'intro' }, m7: { id: 'm7', slug: 'momentum-lab' } };

function claimsFor(custom, rlId) {
  const c = {};
  c[LTI + 'resource_link'] = { id: rlId };
  c[LTI + 'context'] = { id: 'ctx-1' };
  c[LTI + 'custom'] = custom;
  return c;
}

describe('ltiTarget.resolveTarget: page links (#13)', () => {
  let lessonLookups;
  beforeEach(() => {
    lessonLookups = 0;
    vi.spyOn(Course, 'findById').mockImplementation((id) => Promise.resolve(id === 'c1' ? course : null));
    vi.spyOn(Lesson, 'findById').mockImplementation((id) => { lessonLookups++; return Promise.resolve(lessons[id] || null); });
    vi.spyOn(Material, 'findById').mockImplementation((id) => Promise.resolve(materials[id] || null));
  });
  afterEach(() => vi.restoreAllMocks());

  it('bootstraps a page link to its lesson/material coordinates and persists them', async () => {
    const rlId = 'rl-page-boot-' + Math.random().toString(36).slice(2);
    vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve(null));

    const t = await ltiTarget.resolveTarget(claimsFor({ trinket_course: 'c1', trinket_page: 'm7' }, rlId), platform);

    expect(t.course).toBe(course);
    expect(t.targetType).toBe('page');
    expect(t.page, 'the resolver must return the page coordinates').toBeTruthy();
    expect(t.page.lessonSlug).toBe('chapter-3');
    expect(t.page.materialSlug).toBe('momentum-lab');

    // The record is what makes the NEXT launch skip the scan — it must carry the slugs.
    const rec = await LtiResourceLink.findOne({ platformId: platform.id, resourceLinkId: rlId });
    expect(rec, 'the mapping is persisted on first launch').toBeTruthy();
    expect(rec.targetType).toBe('page');
    expect(rec.targetId).toBe('m7');
    expect(rec.lessonSlug).toBe('chapter-3');
    expect(rec.materialSlug).toBe('momentum-lab');
  });

  it('returns the cached coordinates on a repeat launch without re-scanning', async () => {
    vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve({
      courseId: 'c1', targetType: 'page', targetId: 'm7', lessonSlug: 'chapter-3', materialSlug: 'momentum-lab'
    }));

    const t = await ltiTarget.resolveTarget(claimsFor({}, 'rl-page-cached'), platform);

    expect(t.targetType).toBe('page');
    expect(t.page).toEqual(expect.objectContaining({ lessonSlug: 'chapter-3', materialSlug: 'momentum-lab' }));
    expect(lessonLookups, 'cached slugs must not trigger a lesson scan').toBe(0);
  });

  it('heals a slug-less cached page record by re-resolving from its targetId', async () => {
    // What every page link created before the fix persisted: type + id, no slugs.
    vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve({
      courseId: 'c1', targetType: 'page', targetId: 'm7'
    }));

    const t = await ltiTarget.resolveTarget(claimsFor({}, 'rl-page-stale'), platform);

    expect(t.targetType).toBe('page');
    expect(t.page, 'a pre-fix record must still land on its page').toBeTruthy();
    expect(t.page.lessonSlug).toBe('chapter-3');
    expect(t.page.materialSlug).toBe('momentum-lab');
  });

  // Found while fixing #13: the cached ASSIGNMENT path for a pre-cache record (no
  // slugs persisted) called a resolver that does not exist, so the launch's promise
  // chain rejected instead of re-resolving from the stored targetId.
  it('heals a slug-less cached assignment record by re-resolving from its targetId', async () => {
    vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve({
      courseId: 'c1', targetType: 'assignment', targetId: 'm7'
    }));

    const t = await ltiTarget.resolveTarget(claimsFor({}, 'rl-assignment-stale'), platform);

    expect(t.targetType).toBe('assignment');
    expect(t.assignment, 'a pre-cache assignment record must still land on its page').toBeTruthy();
    expect(t.assignment.lessonSlug).toBe('chapter-3');
    expect(t.assignment.materialSlug).toBe('momentum-lab');
  });

  // A heal that stays in memory is paid for again on EVERY later launch of the link
  // (one lesson read per lesson scanned + the material read). After a successful
  // re-resolve the slugs must be written back to the record, best-effort, so the
  // next launch takes the cached branch — exactly like a freshly bootstrapped link.
  describe.each([
    ['page',       'page'],
    ['assignment', 'assignment']
  ])('persisting the heal of a slug-less cached %s record', (targetType, key) => {
    let materialLookups;
    beforeEach(() => {
      materialLookups = 0;
      Material.findById.mockImplementation((id) => { materialLookups++; return Promise.resolve(materials[id] || null); });
    });

    function staleRecord(saveImpl) {
      return { courseId: 'c1', targetType: targetType, targetId: 'm7',
               save: vi.fn(saveImpl || (() => Promise.resolve())) };
    }

    it('backfills both slugs onto the record and saves it', async () => {
      const existing = staleRecord();
      vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve(existing));

      const t = await ltiTarget.resolveTarget(claimsFor({}, 'rl-heal-' + targetType), platform);

      expect(t[key]).toEqual(expect.objectContaining({ lessonSlug: 'chapter-3', materialSlug: 'momentum-lab' }));
      expect(existing.save, 'the healed slugs must be persisted').toHaveBeenCalledTimes(1);
      expect(existing.lessonSlug).toBe('chapter-3');
      expect(existing.materialSlug).toBe('momentum-lab');
    });

    it('serves the second launch from the backfilled record without re-resolving', async () => {
      const existing = staleRecord();
      vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve(existing));
      await ltiTarget.resolveTarget(claimsFor({}, 'rl-heal-' + targetType), platform);
      lessonLookups = 0; materialLookups = 0;

      const t = await ltiTarget.resolveTarget(claimsFor({}, 'rl-heal-' + targetType), platform);

      expect(t[key]).toEqual(expect.objectContaining({ lessonSlug: 'chapter-3', materialSlug: 'momentum-lab' }));
      expect(lessonLookups,   'second launch must not scan lessons').toBe(0);
      expect(materialLookups, 'second launch must not read the material').toBe(0);
      expect(existing.save, 'nothing left to heal on the second launch').toHaveBeenCalledTimes(1);
    });

    it('still returns the coordinates when the backfill save rejects', async () => {
      const existing = staleRecord(() => Promise.reject(new Error('write failed')));
      vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve(existing));

      const t = await ltiTarget.resolveTarget(claimsFor({}, 'rl-heal-' + targetType), platform);

      expect(existing.save).toHaveBeenCalledTimes(1);
      expect(t[key]).toEqual(expect.objectContaining({ lessonSlug: 'chapter-3', materialSlug: 'momentum-lab' }));
    });

    it('does not write when the material cannot be resolved', async () => {
      const existing = staleRecord();
      existing.targetId = 'm-gone';
      vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve(existing));

      const t = await ltiTarget.resolveTarget(claimsFor({}, 'rl-heal-' + targetType), platform);

      expect(t[key] && t[key].lessonSlug).toBeFalsy();
      expect(existing.save).not.toHaveBeenCalled();
      expect(existing.lessonSlug).toBeUndefined();
    });
  });

  it('falls back to the course when the page material cannot be found', async () => {
    vi.spyOn(LtiResourceLink, 'findByLink').mockImplementation(() => Promise.resolve(null));

    const t = await ltiTarget.resolveTarget(
      claimsFor({ trinket_course: 'c1', trinket_page: 'm-gone' }, 'rl-page-missing-' + Math.random().toString(36).slice(2)),
      platform);

    expect(t.course).toBe(course);
    expect(t.targetType).toBe('page');
    // No partial coordinates: the handlers require BOTH slugs before emitting a fragment.
    expect(t.page && t.page.lessonSlug).toBeFalsy();
  });
});
