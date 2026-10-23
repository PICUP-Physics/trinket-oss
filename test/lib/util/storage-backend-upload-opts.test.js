'use strict';
// The export archive must upload through the deploy's STORAGE BACKEND, not a
// raw aws.S3 client.
//
// It used aws.S3 directly, which only ever worked on compose deploys (garage,
// S3-compatible). Cloud Run runs storage.backend 'gcs' with no S3 endpoint or
// credentials, so the upload could not succeed there at all — one of the
// reasons exports never worked on Cloud Run.
//
// These pin the interface the export path depends on: an optional opts argument
// carrying contentDisposition, and backward compatibility for the callers that
// pass a callback in its place.
const s3Backend = require('../../../lib/util/storage-backend-s3');
const gcsBackend = require('../../../lib/util/storage-backend-gcs');

describe('storage backend upload(opts) contract', () => {
  // A fake S3 client: send() receives the SDK v3 command, whose input is the
  // PutObject params.
  const aws = require('../../../config/aws');
  const fakeClient = (onSend) => vi.spyOn(aws, 's3Client').mockImplementation(() => ({
    send: (command) => Promise.resolve(onSend(command.input))
  }));

  it('s3: still accepts a callback in the opts position (existing callers)', async () => {
    const spy = fakeClient(() => ({}));
    const err = await new Promise((resolve) =>
      s3Backend.upload('b', 'k', Buffer.from('x'), 'text/plain', resolve));
    expect(err).toBe(null);
    spy.mockRestore();
  });

  it('s3: passes contentDisposition through as ContentDisposition', async () => {
    let seen = null;
    const spy = fakeClient((params) => { seen = params; return {}; });
    await new Promise((resolve) => s3Backend.upload('b', 'k', Buffer.from('x'), 'application/zip',
      { contentDisposition: 'attachment; filename="student-work.zip"' }, resolve));
    expect(seen.ContentDisposition).toBe('attachment; filename="student-work.zip"');
    expect(seen.ContentType).toBe('application/zip');
    spy.mockRestore();
  });

  it('gcs: exposes the same upload arity, so the export path is backend-agnostic', () => {
    // Guards against the two drifting apart — the export upload picks whichever
    // the deploy configures and must not care which it got.
    expect(typeof gcsBackend.upload).toBe('function');
    expect(gcsBackend.upload.length).toBe(s3Backend.upload.length);
  });
});
