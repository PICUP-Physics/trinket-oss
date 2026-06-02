var config = require('config');

module.exports = (config.storage && config.storage.backend === 'gcs')
  ? require('./storage-backend-gcs')
  : require('./storage-backend-s3');
