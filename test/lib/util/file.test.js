// FileUtil.downloadMaterialFile pipes the storage backend's read stream into a
// PassThrough with no 'error' listener on the source. In Node, an 'error'
// event with no listener is a thrown exception — so a missing object
// (NoSuchKey), a storage blip, or a network reset mid-stream CRASHED the whole
// server on every backend (garage/S3 and GCS alike). These pin the contract:
// backend stream errors must surface on the returned stream, not the process.
const { PassThrough } = require('stream');
const backend = require('../../../lib/util/storage-backend');
const FileUtil = require('../../../lib/util/file');

describe('FileUtil.downloadMaterialFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('streams backend data through to the returned stream', async () => {
    const src = new PassThrough();
    vi.spyOn(backend, 'downloadStream').mockReturnValue(src);

    const out = FileUtil.downloadMaterialFile('a.png');
    src.end('file-bytes');

    const chunks = [];
    for await (const c of out) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('file-bytes');
  });

  it('surfaces a backend stream error on the returned stream instead of crashing', async () => {
    const src = new PassThrough();
    vi.spyOn(backend, 'downloadStream').mockReturnValue(src);

    const out = FileUtil.downloadMaterialFile('missing.png');
    const seen = new Promise((resolve) => out.on('error', resolve));

    setImmediate(() => src.emit('error', new Error('NoSuchKey: object missing')));

    const err = await Promise.race([
      seen,
      new Promise((resolve) => setTimeout(() => resolve('never-surfaced'), 500)),
    ]);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('NoSuchKey');
  });
});
