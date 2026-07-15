var config = require('config');

var _storage;
function getStorage() {
  if (!_storage) {
    var Storage = require('@google-cloud/storage').Storage;
    var projectId = (config.db.firestore && config.db.firestore.projectId) || process.env.GOOGLE_CLOUD_PROJECT;
    _storage = new Storage(projectId ? { projectId: projectId } : {});
  }
  return _storage;
}

module.exports = {
  upload: function(bucketName, key, stream, contentType, cb) {
    var writeStream = getStorage().bucket(bucketName).file(key)
      .createWriteStream({ metadata: { contentType: contentType }, resumable: false });
    writeStream.on('error', cb);
    writeStream.on('finish', function() { cb(null, {}); });
    if (Buffer.isBuffer(stream)) {
      var pass = new (require('stream').PassThrough)();
      pass.end(stream);
      pass.pipe(writeStream);
    } else {
      stream.pipe(writeStream);
    }
  },

  downloadStream: function(bucketName, key) {
    return getStorage().bucket(bucketName).file(key).createReadStream();
  },

  downloadBuffer: function(bucketName, key) {
    return getStorage().bucket(bucketName).file(key).download()
      .then(function(data) { return data[0]; });
  },

  deleteFile: function(bucketName, key, cb) {
    getStorage().bucket(bucketName).file(key).delete(cb);
  }
};
