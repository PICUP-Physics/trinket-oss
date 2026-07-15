'use strict';

// Real-S3 round-trip (TEST_S3=garage): pushes actual bytes through
// lib/util/storage-backend into a real garage server and reads them back.
// files.test.js stubs FileUtil entirely (and the old mocha suite never
// touched S3 at all) — this is the first test where upload/download hit a
// live S3 API: multipart POST /file → garage object → streamed download.

const fs       = require('fs');
const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');

const S3_MODE = process.env.TEST_S3 === 'garage';

describe.skipIf(!S3_MODE)('S3 storage round-trip (real garage)', () => {
  beforeEach(async () => {
    // Self-contained login each test — the harness wipes the DB after every
    // test, so cached cookies point at deleted users.
    delete flow.cookies['user'];
    await flow.switchUser('user');
  });

  it('uploads a material file through the app into garage', async () => {
    await flow.uploadFile();
    expect(flow.lastResponse.statusCode).toBe(200);
    expect(flow.lastResponse.body.id).toBeTruthy();
  });

  it('round-trips the exact bytes back out of garage', async () => {
    await flow.uploadFile();
    const id = flow.lastResponse.body.id;
    expect(id).toBeTruthy();

    await flow.downloadFile(id);
    expect(flow.lastResponse.statusCode).toBe(200);

    const original = fs.readFileSync(defaults.file.upload);
    expect(flow.lastResponse.raw.length).toBe(original.length);
    expect(Buffer.compare(flow.lastResponse.raw, original)).toBe(0);
  });
});
