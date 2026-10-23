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

module.exports = {
  // A new client per call, like the `new aws.S3()` calls it replaces. Tests stub
  // this to swap in a fake client.
  s3Client : function(overrides) {
    return new S3Client(clientOptions(overrides));
  },
  clientOptions : clientOptions
};
