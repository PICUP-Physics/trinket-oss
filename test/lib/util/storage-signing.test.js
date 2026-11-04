describe('storage signUploadUrl', () => {
  const config = require('config');
  let savedCreds = null;
  function useFakeCredentials() {
    if (config.aws.keyId) return;
    savedCreds = savedCreds || { keyId: config.aws.keyId, key: config.aws.key };
    Object.assign(config.aws, { keyId: 'test-access-key', key: 'test-secret-key' });
  }
  afterAll(() => { if (savedCreds) Object.assign(config.aws, savedCreds); });

  it('s3 backend returns a presigned PUT url string', async () => {
    // Signing needs credentials, and the base test profile ships empty
    // aws.key/keyId (config/default.yaml). useFakeCredentials() supplies fake
    // ones, unless garage has already wired up real ones (TEST_S3=garage, see
    // test/helpers/vitest-setup.cjs), so the round-trip test keeps them.
    useFakeCredentials();
    const s3 = require('../../../lib/util/storage-backend-s3');
    const url = await s3.signUploadUrl('some-bucket', 'imports/tmp/u1/abc.zip', 'application/zip', 900);
    expect(typeof url).toBe('string');
    expect(url).toMatch(/some-bucket/);
    expect(url).toMatch(/imports\/tmp\/u1\/abc\.zip/);
    expect(url).toMatch(/X-Amz-Expires=900|Expires=/);   // presigned params present
  });

  it('s3 backend signs against config.aws.publicEndpoint when set (browser-reachable host)', async () => {
    // The browser can't resolve an internal S3 endpoint (garage:3900 /
    // minio:9000), and under SigV4 the host is part of the signature — so a
    // signed PUT URL must be SIGNED against the public endpoint, not
    // rewritten afterward. Same requirement as the signed-GET precedent at
    // lib/controllers/users.js:1184-1198.
    useFakeCredentials();
    const config = require('config');
    const s3 = require('../../../lib/util/storage-backend-s3');

    const original = config.aws.publicEndpoint;
    let signedUrl;
    try {
      config.aws.publicEndpoint = 'http://localhost:9999';
      signedUrl = await s3.signUploadUrl('some-bucket', 'imports/tmp/u1/abc.zip', 'application/zip', 900);
    } finally {
      config.aws.publicEndpoint = original;
    }
    expect(signedUrl).toMatch(/localhost:9999/);

    // Unset: falls back to the default (non-public) endpoint — no leftover
    // localhost host from the previous case.
    const defaultUrl = await s3.signUploadUrl('some-bucket', 'imports/tmp/u1/abc.zip', 'application/zip', 900);
    expect(defaultUrl).not.toMatch(/localhost:9999/);
  });

  it.skipIf(!process.env.GCS_TEST)('gcs backend returns a v4 write url', async () => {
    const gcs = require('../../../lib/util/storage-backend-gcs');
    const url = await gcs.signUploadUrl('some-bucket', 'imports/tmp/u1/abc.zip', 'application/zip', 900);
    expect(typeof url).toBe('string');
    expect(url).toMatch(/X-Goog-Algorithm|GoogleAccessId/);
  });

  it.skipIf(process.env.TEST_S3 !== 'garage')('FileUtil read/delete round-trip against garage', async () => {
    const FileUtil = require('../../../lib/util/file');
    const backend = require('../../../lib/util/storage-backend');
    const config = require('config');
    const key = 'imports/tmp/u1/roundtrip.zip';
    await new Promise((res, rej) => backend.upload(config.aws.buckets.materials.name, key, Buffer.from('zipbytes'), 'application/zip', (e) => e ? rej(e) : res()));
    const buf = await FileUtil.readImportObjectAsBuffer(key);
    expect(buf.toString()).toBe('zipbytes');
    await new Promise((res) => FileUtil.deleteImportObject(key, res));
  });
});
