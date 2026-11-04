'use strict';

// Signed-URL minting for large course-archive imports (bypasses the 32 MiB
// Cloud Run ingress cap on direct POST — see FileUtil.isSignedUploadAvailable /
// FileUtil.signImportUploadUrl in lib/util/file.js). This route just mints the
// URL; it does not touch the import pipeline itself.

const config  = require('config');
const flow    = require('../../helpers/flow.cjs');
const JSZip   = require('jszip');
const crypto  = require('crypto');
// storage-backend / FileUtil are required lazily (inside the test bodies below,
// not at module top-level). With aws-sdk v2, config/aws.js snapshotted the
// credentials at require time, before vitest-setup.cjs's beforeAll wires up
// garage's (TEST_S3=garage). config/aws.js now reads config.aws per client, so
// that no longer bites, but the lazy requires are harmless and kept.

async function currentUserId() {
  const doc = await new Promise((resolve, reject) =>
    User.findByLogin('test@dummy.com', (e, d) => (e ? reject(e) : resolve(d))));
  return String(doc.id || doc._id);
}

// The DB is dropped after every test (see vitest-setup.cjs afterEach), but
// flow's cookie jar is a module-level singleton that outlives it — a cached
// session cookie from an earlier test points at a user who no longer exists.
// Force a fresh login each time, same as imports.test.js's freshLogin().
async function freshLogin(user) {
  delete flow.cookies[user];
  await flow.switchUser(user);
}

describe('POST /api/imports/upload-url', () => {
  // Signing needs credentials; the base test profile has none (garage's are
  // set under TEST_S3=garage). aws-sdk v2 signed without them and returned a
  // URL that could never work; v3 refuses, so give it fake ones.
  let savedCreds = null;
  beforeAll(() => {
    if (!config.aws.keyId) {
      savedCreds = { keyId: config.aws.keyId, key: config.aws.key };
      Object.assign(config.aws, { keyId: 'test-access-key', key: 'test-secret-key' });
    }
  });
  afterAll(() => { if (savedCreds) Object.assign(config.aws, savedCreds); });

  it('returns a signed URL + key + expiresAt for an authorized user', async () => {
    await freshLogin('user');
    const userId = await currentUserId();

    const r = await flow.post('/api/imports/upload-url');
    expect(r.statusCode).toBe(200);

    const data = r.body.data;
    expect(data.key).toMatch(new RegExp('^imports/tmp/' + userId + '/[A-Za-z0-9-]+\\.zip$'));
    expect(typeof data.url).toBe('string');

    const expiresAt = new Date(data.expiresAt);
    expect(Number.isNaN(expiresAt.getTime())).toBe(false);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  describe('when large upload is disabled', () => {
    let origImports;
    beforeEach(() => { origImports = config.imports; });
    afterEach(() => { config.imports = origImports; });

    it('returns 501', async () => {
      config.imports = { largeUpload: { enabled: false } };
      await freshLogin('user');

      const r = await flow.post('/api/imports/upload-url');
      expect(r.statusCode).toBe(501);
    });
  });
});

// Minimal valid course zip in the format parseCourseZip expects — same shape
// as course-import-embeds.test.js's buildCourseZip.
function buildCourseZip() {
  const zip = new JSZip();
  zip.file('course.json', JSON.stringify({
    lessons: [{
      slug: 'lesson-one', name: 'Lesson One', isDraft: false,
      materials: [{ slug: 'page-one', name: 'Page One', type: 'page' }]
    }]
  }));
  zip.file('00-lesson-one/00-page-one.md', 'Hello from storage import');
  return zip.generateAsync({ type: 'nodebuffer' });
}

function seedObject(key, buffer) {
  const backend = require('../../../lib/util/storage-backend');
  return new Promise((resolve, reject) => {
    backend.upload(config.aws.buckets.materials.name, key, buffer, 'application/zip',
      (err) => (err ? reject(err) : resolve()));
  });
}

const S3_MODE = process.env.TEST_S3 === 'garage';

describe('POST /api/imports/course/from-storage', () => {
  it('returns 403 when the key does not belong to the caller', async () => {
    await freshLogin('user');
    const key = 'imports/tmp/someone-else/' + crypto.randomUUID() + '.zip';

    const r = await flow.post('/api/imports/course/from-storage', { key: key });
    expect(r.statusCode).toBe(403);
  });

  describe('when large upload is disabled', () => {
    let origImports;
    beforeEach(() => { origImports = config.imports; });
    afterEach(() => { config.imports = origImports; });

    it('returns 501', async () => {
      await freshLogin('user');
      const userId = await currentUserId();
      config.imports = { largeUpload: { enabled: false } };
      const key = 'imports/tmp/' + userId + '/' + crypto.randomUUID() + '.zip';

      const r = await flow.post('/api/imports/course/from-storage', { key: key });
      expect(r.statusCode).toBe(501);
    });
  });

  describe.skipIf(!S3_MODE)('against a real object (TEST_S3=garage)', () => {
    it('returns 413 via the size preflight (without downloading) and deletes the object when it exceeds maxArchiveBytes', async () => {
      await freshLogin('user');
      const userId = await currentUserId();
      const key = 'imports/tmp/' + userId + '/' + crypto.randomUUID() + '.zip';
      const oversizeBuf = Buffer.alloc(64, 'x');   // 64 bytes, larger than the 10-byte cap below

      // The size ceiling must be enforced via a metadata/HEAD request BEFORE
      // the object is downloaded — buffering the whole object into memory
      // first would defeat maxArchiveBytes as a memory bound. Spy on
      // readImportObjectAsBuffer (the download path) to prove it is never
      // reached when the preflight (importObjectSize) already rejects.
      const FileUtil = require('../../../lib/util/file');
      const downloadSpy = vi.spyOn(FileUtil, 'readImportObjectAsBuffer');

      const origImports = config.imports;
      try {
        config.imports = { largeUpload: { enabled: true, maxArchiveBytes: 10 } };
        await seedObject(key, oversizeBuf);

        const r = await flow.post('/api/imports/course/from-storage', { key: key });
        expect(r.statusCode).toBe(413);
        expect(downloadSpy).not.toHaveBeenCalled();
      } finally {
        config.imports = origImports;
        downloadSpy.mockRestore();
      }

      await expect(FileUtil.readImportObjectAsBuffer(key)).rejects.toBeTruthy();
    });

    it('imports the course and deletes the temp object on success', async () => {
      await freshLogin('user');
      const userId = await currentUserId();
      const key = 'imports/tmp/' + userId + '/' + crypto.randomUUID() + '.zip';
      const zipBuf = await buildCourseZip();
      await seedObject(key, zipBuf);

      const r = await flow.post('/api/imports/course/from-storage', { key: key, name: 'From Storage Course' });
      expect(r.statusCode).toBe(200);
      expect(r.body.data.status).toBe('ok');
      expect(r.body.data.courseId).toBeTruthy();

      const course = await flow.get('/api/courses/' + r.body.data.courseId);
      expect(course.statusCode).toBe(200);

      const FileUtil = require('../../../lib/util/file');
      await expect(FileUtil.readImportObjectAsBuffer(key)).rejects.toBeTruthy();
    });
  });
});
