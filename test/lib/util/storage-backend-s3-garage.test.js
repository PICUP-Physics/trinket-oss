'use strict';
// Every S3 backend function against a real garage server (TEST_S3=garage),
// with no SDK stubs, so the contract holds whichever aws-sdk major version is
// underneath: upload (Buffer and file stream bodies), downloadStream,
// downloadBuffer, objectSize, deleteFile, and both presigned URLs fetched
// over plain HTTP.
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const config = require('config');

const S3_MODE = process.env.TEST_S3 === 'garage';

describe.skipIf(!S3_MODE)('S3 backend against real garage', () => {
  let s3, bucket;
  const key = (name) => 'backend-test/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '-' + name;
  const upload = (k, body, type, opts) => new Promise((resolve, reject) =>
    s3.upload(bucket, k, body, type, opts || {}, (err) => (err ? reject(err) : resolve())));
  const drain = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
  });

  beforeAll(() => {
    s3 = require('../../../lib/util/storage-backend-s3');
    bucket = config.aws.buckets.materials.name;
  });

  it('uploads a Buffer and reads it back as a buffer and as a stream', async () => {
    const k = key('buf.txt');
    const body = Buffer.from('hello from a buffer');
    await upload(k, body, 'text/plain');
    expect(Buffer.compare(await s3.downloadBuffer(bucket, k), body)).toBe(0);
    expect(Buffer.compare(await drain(s3.downloadStream(bucket, k)), body)).toBe(0);
    expect(await s3.objectSize(bucket, k)).toBe(body.length);
  });

  it('uploads a file read stream', async () => {
    const file = path.join(os.tmpdir(), 'garage-stream-' + process.pid + '.bin');
    const body = Buffer.alloc(200 * 1024, 7);
    fs.writeFileSync(file, body);
    const k = key('stream.bin');
    await upload(k, fs.createReadStream(file), 'application/octet-stream');
    fs.unlinkSync(file);
    expect(await s3.objectSize(bucket, k)).toBe(body.length);
    expect(Buffer.compare(await s3.downloadBuffer(bucket, k), body)).toBe(0);
  });

  it('stores Content-Disposition when asked', async () => {
    const k = key('export.zip');
    await upload(k, Buffer.from('zip'), 'application/zip', { contentDisposition: 'attachment; filename="My Export.zip"' });
    const res = await fetch(await s3.signDownloadUrl(bucket, k, 60));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="My Export.zip"');
    expect(res.headers.get('content-type')).toBe('application/zip');
  });

  it('a presigned download URL serves the object over plain HTTP', async () => {
    const k = key('signed.txt');
    await upload(k, Buffer.from('signed bytes'), 'text/plain');
    const url = await s3.signDownloadUrl(bucket, k, 60);
    expect(url).toMatch(/X-Amz-Expires=60/);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('signed bytes');
  });

  it('a presigned upload URL accepts a PUT with that content type', async () => {
    const k = key('put.zip');
    const url = await s3.signUploadUrl(bucket, k, 'application/zip', 60);
    const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/zip' }, body: Buffer.from('uploaded by the browser') });
    expect(res.status).toBe(200);
    expect((await s3.downloadBuffer(bucket, k)).toString()).toBe('uploaded by the browser');
  });

  it('deleteFile removes the object', async () => {
    const k = key('gone.txt');
    await upload(k, Buffer.from('x'), 'text/plain');
    await new Promise((resolve, reject) => s3.deleteFile(bucket, k, (err) => (err ? reject(err) : resolve())));
    await expect(s3.objectSize(bucket, k)).rejects.toBeTruthy();
  });

  it('a missing key: downloadBuffer rejects and downloadStream emits error', async () => {
    const k = key('never-written.txt');
    await expect(s3.downloadBuffer(bucket, k)).rejects.toBeTruthy();
    await expect(drain(s3.downloadStream(bucket, k))).rejects.toBeTruthy();
  });
});
