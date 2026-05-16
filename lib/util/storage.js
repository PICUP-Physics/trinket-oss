var { Storage } = require('@google-cloud/storage');
var config      = require('config');

var _storage;

function getStorage() {
  if (!_storage) {
    _storage = new Storage({ projectId: config.db.firestore.projectId });
  }
  return _storage;
}

function snapshotUrl(filename) {
  var emulatorHost = process.env.STORAGE_EMULATOR_HOST;
  if (emulatorHost) {
    // Use STORAGE_PUBLIC_HOST if set (browser-facing URL may differ from container-internal URL)
    var publicHost = (process.env.STORAGE_PUBLIC_HOST || emulatorHost).replace(/\/$/, '');
    var bucket = config.gcs.buckets.snapshots.name;
    return publicHost + '/v0/b/' + bucket + '/o/' + encodeURIComponent(filename) + '?alt=media';
  }
  return config.gcs.buckets.snapshots.host + '/' + filename;
}

function uploadSnapshot(filename, buffer) {
  var bucketName = config.gcs.buckets.snapshots.name;
  var file = getStorage().bucket(bucketName).file(filename);

  return file.save(buffer, { metadata: { contentType: 'image/png' } })
    .then(function() {
      return snapshotUrl(filename);
    });
}

module.exports = { uploadSnapshot: uploadSnapshot };
