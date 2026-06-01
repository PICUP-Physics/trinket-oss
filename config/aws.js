var AWS      = require('aws-sdk')
    , config = require('config');

var params = {
  accessKeyId       : config.aws.keyId
  , secretAccessKey : config.aws.key
  , region          : config.aws.region
};

// Support S3-compatible endpoints (MinIO for local dev, GCS S3 API, etc.)
if (config.aws.endpoint) {
  params.endpoint        = config.aws.endpoint;
  params.s3ForcePathStyle = true;
}

AWS.config.update(params);

module.exports = AWS;
