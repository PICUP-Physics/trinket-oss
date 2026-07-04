'use strict';

// Firestore-backed list client implementing the Redis operations used by
// the slug stores (userStore, courseStore, trinketStore).
//
// Each logical "list" key maps to a document in the 'store_lists' collection:
//   { ids: [ id1, id2, ... ] }
//
// Ordering is maintained by the read-modify-write transactions used for
// lPush / rPush / lRem, matching Redis list semantics.

var config    = require('config');
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

// Firestore doc IDs cannot contain '/'; map ':' is fine but '/' must be encoded.
function docId(key) {
  return key.replace(/\//g, '|');
}

var FirestoreListClient = {
  // Return element at index (0 = head). Returns null if absent.
  async lIndex(key, index) {
    var doc = await getDb().collection('store_lists').doc(docId(key)).get();
    if (!doc.exists) return null;
    var ids = doc.data().ids || [];
    var i   = index < 0 ? ids.length + index : index;
    return ids[i] !== undefined ? ids[i] : null;
  },

  // Prepend value to list head (Redis LPUSH semantics).
  async lPush(key, value) {
    var db  = getDb();
    var ref = db.collection('store_lists').doc(docId(key));
    return db.runTransaction(async function(t) {
      var snap   = await t.get(ref);
      var ids    = snap.exists ? (snap.data().ids || []) : [];
      var newIds = [value].concat(ids);
      t.set(ref, { ids: newIds });
      return newIds.length;
    });
  },

  // Remove occurrences of value from list. count=0 means remove all.
  async lRem(key, count, value) {
    var db  = getDb();
    var ref = db.collection('store_lists').doc(docId(key));
    return db.runTransaction(async function(t) {
      var snap = await t.get(ref);
      if (!snap.exists) return 0;
      var ids     = snap.data().ids || [];
      var removed = 0;
      var newIds  = ids.filter(function(id) {
        if (id === value && (count === 0 || removed < Math.abs(count))) {
          removed++;
          return false;
        }
        return true;
      });
      t.set(ref, { ids: newIds });
      return removed;
    });
  },

  // Return slice of list. stop=-1 means through the end.
  async lRange(key, start, stop) {
    var doc = await getDb().collection('store_lists').doc(docId(key)).get();
    if (!doc.exists) return [];
    var ids = doc.data().ids || [];
    if (stop === -1) stop = ids.length - 1;
    return ids.slice(start, stop + 1);
  },

  // Append value to list tail (Redis RPUSH semantics).
  async rPush(key, value) {
    var db  = getDb();
    var ref = db.collection('store_lists').doc(docId(key));
    return db.runTransaction(async function(t) {
      var snap   = await t.get(ref);
      var ids    = snap.exists ? (snap.data().ids || []) : [];
      var newIds = ids.concat([value]);
      t.set(ref, { ids: newIds });
      return newIds.length;
    });
  },

  // Returns 1 if key exists and has at least one element, 0 otherwise.
  async exists(key) {
    var doc = await getDb().collection('store_lists').doc(docId(key)).get();
    if (!doc.exists) return 0;
    return (doc.data().ids || []).length > 0 ? 1 : 0;
  }
};

module.exports = FirestoreListClient;
