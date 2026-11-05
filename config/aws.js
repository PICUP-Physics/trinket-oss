var S3Client = require('@aws-sdk/client-s3').S3Client
    , config = require('config');

// Options for an S3 client, read from config.aws each time (not once at
// require time), so the garage test profile and tests that adjust config.aws
// see their settings.
function clientOptions(overrides) {
  var options = {
    region : config.aws.region || 'us-east-1',
    // S3-compatible servers (garage, MinIO) don't all accept the default
    // CRC32 checksums newer SDKs add to every request, and a checksum baked
    // into a presigned PUT would reject the browser's upload. Only send one
    // when the operation requires it.
    requestChecksumCalculation  : 'WHEN_REQUIRED',
    responseChecksumValidation  : 'WHEN_REQUIRED'
  };

  if (config.aws.keyId) {
    options.credentials = {
      accessKeyId     : config.aws.keyId,
      secretAccessKey : config.aws.key
    };
  }

  if (config.aws.endpoint) {
    options.endpoint = config.aws.endpoint;
  }

  if (config.aws.s3ForcePathStyle !== undefined && config.aws.s3ForcePathStyle !== null) {
    options.forcePathStyle = !!config.aws.s3ForcePathStyle;
  }

  // config.aws.signatureVersion is no longer read: SDK v3 signs with SigV4 only.

  return Object.assign(options, overrides || {});
}

// Each S3Client owns a keep-alive connection pool, so one client is kept per
// effective configuration rather than built per call. The options are still
// read each time, so a change to config.aws gets a client of its own.
var clients = new Map();

module.exports = {
  // Tests stub this to swap in a fake client.
  s3Client : function(overrides) {
    var options = clientOptions(overrides), key = JSON.stringify(options);
    if (!clients.has(key)) clients.set(key, new S3Client(options));
    return clients.get(key);
  },
  clientOptions : clientOptions
};
