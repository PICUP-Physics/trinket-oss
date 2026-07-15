var mongoose = require('mongoose'),
    // mongoose-schema-extend is deprecated but still used by lib/models/model.js
    // TODO: Migrate to native mongoose discriminators
    extend   = require('mongoose-schema-extend'),
    dbconfig = require('config').db;

function connect() {
  // Skip MongoDB when using a non-Mongoose db backend (e.g. Firestore)
  if (dbconfig.backend && dbconfig.backend !== 'mongoose') {
    return;
  }

  // Support a full connection URI (e.g. MongoDB Atlas mongodb+srv://...)
  // via config, env var MONGODB_URI, or fall back to host/port construction
  var connectStr = dbconfig.mongo.uri
    || process.env.MONGODB_URI;

  if (!connectStr) {
    var mongo_creds = dbconfig.mongo.user && dbconfig.mongo.pass
      ? dbconfig.mongo.user + ':' + dbconfig.mongo.pass + '@' : '';

    var read_creds = dbconfig.mongoread.user && dbconfig.mongoread.pass
      ? dbconfig.mongoread.user + ':' + dbconfig.mongoread.pass + '@' : '';

    connectStr = 'mongodb://'
      + mongo_creds
      + dbconfig.mongo.host + ':'
      + dbconfig.mongo.port + '/'
      + dbconfig.mongo.database;

    if (dbconfig.mongoread.host) {
      connectStr += ','
      + read_creds
      + dbconfig.mongoread.host + ':'
      + dbconfig.mongoread.port + '/'
      + dbconfig.mongoread.database;

      if (dbconfig.mongoread.opts) {
        connectStr += '?' + dbconfig.mongoread.opts;
      }
    }
  }

  mongoose.connect(connectStr);
}

connect();

module.exports = {
  connect : connect
};
