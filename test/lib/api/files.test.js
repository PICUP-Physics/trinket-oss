const flow     = require('../../helpers/flow.cjs');
const defaults = require('../../helpers/defaults');
const config   = require('config');
const fs       = require('fs');
const FileUtil = require('../../../lib/util/file');

// The 2a harness drops the DB after each test, while the flow cookie jar is a
// module-level singleton. Reset it before each test so every test logs in fresh
// against the freshly-reset DB. The legacy mocha suite shared one DB across the
// whole sequence (uploading once, then downloading by a captured id in a later
// block); here each test is isolated, so the download tests upload first to
// obtain a fresh id before downloading.
beforeEach(() => {
  flow.cookies = {};
  flow.activeUser = 'user';
});

// File uploads are feature-flagged off in the test config (features.assets:false
// in default.yaml -> the controller replies 501), and the upload/download paths
// stream to/from S3 (lib/util/file.js). Enable the flag for these tests and stub
// the S3 round-trip so the multipart harness path is exercised end-to-end
// deterministically without network. (Mirrors trinket.test.js's config+mailer
// stubbing pattern; test-only, lib/ + config/ files untouched.)
let assetsWasEnabled;
beforeEach(() => {
  assetsWasEnabled = config.features.assets;
  config.features.assets = true;

  vi.spyOn(FileUtil, 'uploadMaterialFile').mockImplementation((upload, cb) => {
    cb(null, { host: 'https://files.test', path: upload.filename, hash: 'testhash', size: upload.bytes });
  });
  // The download controller derives the S3 key (`remote`) from the saved
  // file.url's last segment, which the upload stub set to the original filename.
  // Stream the matching fixture back so the response's byte count matches the
  // declared content-length (an empty stream yields a 500).
  vi.spyOn(FileUtil, 'downloadMaterialFile').mockImplementation((remote) => {
    return fs.createReadStream('test/data/' + remote);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  config.features.assets = assetsWasEnabled;
});

function findFile(id) {
  return new Promise((resolve, reject) => {
    File.findById(id, (err, file) => (err ? reject(err) : resolve(file)));
  });
}

describe('Files', () => {
  describe('As a logged out user', () => {
    describe('When I upload a file', () => {
      beforeEach(async () => {
        flow.switchUser('');
        await flow.uploadFile();
      });

      it('should redirect me to the login page', () => {
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(302);
        expect(flow.lastResponse.redirect).toBe(true);
        expect(flow.lastRedirect.pathname).toBe('/login');
      });
    });
  });

  describe('As a logged in user', () => {
    describe('When I upload a file', () => {
      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.uploadFile();
      });

      it('should create a new file document', async () => {
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        expect(flow.lastResponse.body).toHaveProperty('id');
        expect(flow.lastResponse.body).toHaveProperty('path');
        expect(flow.lastResponse.body).toHaveProperty('type');

        const file = await findFile(flow.lastResponse.body.id);
        expect(file != null).toBe(true);
        const fileId = file.id;
        expect(file.mime).toEqual(flow.lastResponse.body.mime);
        expect(
          flow.lastResponse.body.path.indexOf('/api/files/' + fileId + '/' + defaults.file.name)
        ).not.toBe(-1);
      });
    });

    describe('When I upload an ipython notebook', () => {
      beforeEach(async () => {
        await flow.switchUser('user');
        await flow.uploadIpynb();
      });

      it('should create a new file document', async () => {
        expect(flow.wasOk).toBe(true);
        expect(flow.lastResponse.statusCode).toBe(200);
        expect(flow.lastContentType).toContain('application/json');
        expect(flow.lastResponse.body).toHaveProperty('id');

        const file = await findFile(flow.lastResponse.body.id);
        expect(file != null).toBe(true);
        expect(file.mime).toEqual('text/plain');
      });
    });
  });

  describe('When accessing an uploaded file', () => {
    beforeEach(async () => {
      await flow.switchUser('user');
      await flow.uploadFile();
      await flow.downloadFile(flow.lastResponse.body.id);
    });

    it('should download the file', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);
      // Image-mime files stream inline (no attachment header) so embeds can
      // render them. The old `/^image/.test(file.type)` check could never match
      // (type is only 'embed'/'download'), so the legacy always-attach behavior
      // this assertion used to encode was a bug.
      expect(flow.lastResponse.headers['content-disposition']).toBeUndefined();
      expect(flow.lastContentType).toContain('image/gif');
    });
  });

  describe('When accessing an ipython notebook file', () => {
    beforeEach(async () => {
      await flow.switchUser('user');
      await flow.uploadIpynb();
      await flow.downloadFile(flow.lastResponse.body.id);
    });

    it('should download the file', () => {
      expect(flow.wasOk).toBe(true);
      expect(flow.lastResponse.statusCode).toBe(200);
      expect(flow.lastResponse.headers['content-disposition']).toBe('attachment; filename=test.ipynb');
      expect(flow.lastContentType).toContain('text/plain');
    });
  });
});
