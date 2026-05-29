var AWS      = require('aws-sdk')
    , config = require('config');

var awsConfig = {
  accessKeyId       : config.aws.keyId
  , secretAccessKey : config.aws.key
  , region          : config.aws.region
};

if (config.aws.endpoint) {
  awsConfig.endpoint = config.aws.endpoint;
}

if (config.aws.s3ForcePathStyle !== undefined) {
  awsConfig.s3ForcePathStyle = config.aws.s3ForcePathStyle;
}

if (config.aws.signatureVersion) {
  awsConfig.signatureVersion = config.aws.signatureVersion;
}

AWS.config.update(awsConfig);

module.exports = AWS;
