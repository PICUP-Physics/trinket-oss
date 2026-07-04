'use strict';

// Catbox-compatible cache engine backed by Firestore.
// Implements the @hapi/catbox engine interface for server-side session storage.
//
// Sessions are stored in the 'sessions' collection as:
//   { value: JSON.stringify(item), stored: epochMs, ttl: ms }
//
// TTL is enforced client-side on get() — Firestore has no server-side TTL index.

var config   = require('config');
var Firestore = require('@google-cloud/firestore');

var _db = null;

function getDb() {
  if (_db) return _db;
  var fsConfig = (config.db && config.db.firestore) || {};
  var opts = {};
  if (fsConfig.projectId)   opts.projectId   = fsConfig.projectId;
  if (fsConfig.keyFilename) opts.keyFilename = fsConfig.keyFilename;
  _db = new Firestore(opts);
  return _db;
}

// Firestore doc IDs cannot contain '/'; encode any that appear in the key.
function docId(key) {
  return (key.segment + ':' + key.id).replace(/\//g, '|');
}

var internals = {};

internals.Engine = class {
  constructor(options) {
    this.options = options || {};
    this._ready  = false;
    this._db     = null;
  }

  async start() {
    this._db   = getDb();
    this._ready = true;
  }

  stop() {
    this._ready = false;
  }

  isReady() {
    return this._ready;
  }

  validateSegmentName(name) {
    if (!name || typeof name !== 'string') {
      return new Error('Invalid segment name');
    }
    return null;
  }

  async get(key) {
    if (!this.isReady()) throw new Error('Cache not ready');
    var id  = docId(key);
    var doc = await this._db.collection('sessions').doc(id).get();
    if (!doc.exists) return null;

    var data = doc.data();
    if (data.ttl && (Date.now() - data.stored) > data.ttl) {
      // Expired — delete async and return cache miss
      this._db.collection('sessions').doc(id).delete().catch(function() {});
      return null;
    }

    return {
      item:   JSON.parse(data.value),
      stored: data.stored,
      ttl:    data.ttl
    };
  }

  async set(key, value, ttl) {
    if (!this.isReady()) throw new Error('Cache not ready');
    await this._db.collection('sessions').doc(docId(key)).set({
      value:  JSON.stringify(value),
      stored: Date.now(),
      ttl:    ttl
    });
  }

  async drop(key) {
    if (!this.isReady()) throw new Error('Cache not ready');
    await this._db.collection('sessions').doc(docId(key)).delete();
  }
};

module.exports = { Engine: internals.Engine };
