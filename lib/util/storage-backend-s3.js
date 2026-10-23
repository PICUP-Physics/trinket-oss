var aws         = require('../../config/aws'),
    s3          = require('@aws-sdk/client-s3'),
    presign     = require('@aws-sdk/s3-request-presigner').getSignedUrl,
    fs          = require('fs'),
    PassThrough = require('stream').PassThrough,
    config      = require('config');

// Settle a promise into a node callback, outside the promise chain, so a throw
// in the callback surfaces as it did with the v2 SDK's callbacks rather than as
// an unhandled rejection.
function nodeify(promise, cb) {
  promise.then(
    function(result) { process.nextTick(cb, null, result); },
    function(err)    { process.nextTick(cb, err); }
  );
}

// The signers sign against the browser-reachable endpoint when there is one.
function signingClient() {
  return aws.s3Client(config.aws.publicEndpoint ? { endpoint: config.aws.publicEndpoint } : {});
}

module.exports = {
  // opts is optional and may be omitted entirely: upload(b, k, s, type, cb).
  upload: function(bucketName, key, stream, contentType, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    opts = opts || {};
    var params = { Bucket: bucketName, Key: key, Body: stream, ContentType: contentType };
    if (opts.contentDisposition) params.ContentDisposition = opts.contentDisposition;
    // A file stream's length comes from the file; S3 needs it up front.
    if (stream && typeof stream.path === 'string') {
      try { params.ContentLength = fs.statSync(stream.path).size; } catch (e) { /* let S3 report it */ }
    }
    nodeify(aws.s3Client().send(new s3.PutObjectCommand(params)), cb);
  },

  // Returns a stream at once (callers pipe it straight away); a failed fetch
  // surfaces as an 'error' on it.
  downloadStream: function(bucketName, key) {
    var out = new PassThrough();
    aws.s3Client().send(new s3.GetObjectCommand({ Bucket: bucketName, Key: key }))
      .then(function(res) {
        res.Body.on('error', function(err) { out.destroy(err); });
        res.Body.pipe(out);
      }, function(err) {
        out.destroy(err);
      });
    return out;
  },

  downloadBuffer: function(bucketName, key) {
    return aws.s3Client().send(new s3.GetObjectCommand({ Bucket: bucketName, Key: key }))
      .then(function(res) { return res.Body.transformToByteArray(); })
      .then(function(bytes) { return Buffer.from(bytes); });
  },

  deleteFile: function(bucketName, key, cb) {
    nodeify(aws.s3Client().send(new s3.DeleteObjectCommand({ Bucket: bucketName, Key: key })), cb);
  },

  objectSize: function(bucketName, key) {
    return aws.s3Client().send(new s3.HeadObjectCommand({ Bucket: bucketName, Key: key }))
      .then(function(res) { return Number(res.ContentLength); });
  },

  // Read counterpart of signUploadUrl. Same public-endpoint reasoning as the
  // upload signer below: under SigV4 the host is part of the signature, so we
  // sign against the browser-reachable endpoint rather than rewriting the host
  // afterwards.
  signDownloadUrl: function(bucketName, key, ttlSeconds) {
    return presign(signingClient(), new s3.GetObjectCommand({ Bucket: bucketName, Key: key }), { expiresIn: ttlSeconds })
      .then(function(url) {
        // Legacy host swap for deploys without publicEndpoint, carried over from
        // lib/controllers/users.js (where downloads were signed before they moved
        // behind the backend abstraction). S3_PUBLIC_HOST is an env-only knob with
        // no other reference in the tree, so a deploy could rely on it without
        // anything here saying so. With publicEndpoint set it is unused.
        if (!config.aws.publicEndpoint && process.env.S3_PUBLIC_HOST) {
          url = url.replace(/^(https?:\/\/)[^/]+/, '$1' + process.env.S3_PUBLIC_HOST);
        }
        return url;
      });
  },

  // The browser can't resolve the internal S3 endpoint (e.g. garage:3900 /
  // minio:9000), so the URL must be signed for a browser-reachable host.
  // Under SigV4 the host is part of the signature (SignedHeaders=host), so
  // we must SIGN against the public endpoint — rewriting the host afterward
  // would invalidate the signature.
  signUploadUrl: function(bucketName, key, contentType, ttlSeconds) {
    return presign(signingClient(),
      new s3.PutObjectCommand({ Bucket: bucketName, Key: key, ContentType: contentType }),
      { expiresIn: ttlSeconds });
  }
};
