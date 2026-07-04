var aws = require('../../config/aws');

module.exports = {
  upload: function(bucketName, key, stream, contentType, cb) {
    var client = new aws.S3();
    client.putObject({ Bucket: bucketName, Key: key, Body: stream, ContentType: contentType }, cb);
  },

  downloadStream: function(bucketName, key) {
    var client = new aws.S3();
    return client.getObject({ Bucket: bucketName, Key: key }).createReadStream();
  },

  downloadBuffer: function(bucketName, key) {
    var client = new aws.S3();
    return new Promise(function(resolve, reject) {
      client.getObject({ Bucket: bucketName, Key: key }, function(err, data) {
        if (err) reject(err); else resolve(data.Body);
      });
    });
  },

  deleteFile: function(bucketName, key, cb) {
    var client = new aws.S3();
    client.deleteObject({ Bucket: bucketName, Key: key }, cb);
  }
};
