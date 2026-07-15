var config = require('config');

var backend;

function getBackend() {
  if (backend) return backend;

  var name = (config.db && config.db.backend) || 'mongoose';

  if (name === 'firestore') {
    backend = require('./firestore-backend');
  } else {
    backend = require('./mongoose-backend');
  }

  return backend;
}

module.exports = { getBackend: getBackend };
