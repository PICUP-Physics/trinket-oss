// Firestore Native backend.
//
// Presents the same interface as a Mongoose model so existing class methods
// (bound to {model: <this>}) work without changes (Option A architecture).
//
// Connection is configured via:
//   config.db.firestore.projectId  (or GOOGLE_CLOUD_PROJECT env var)
//   config.db.firestore.keyFilename (or Application Default Credentials)
//   FIRESTORE_EMULATOR_HOST env var (for local emulator)

'use strict';

var config  = require('config');
var Firestore = require('@google-cloud/firestore');

// ---------------------------------------------------------------------------
// Singleton Firestore client
// ---------------------------------------------------------------------------

var _db = null;

function getDb() {
  if (_db) return _db;

  var fsConfig = (config.db && config.db.firestore) || {};
  var opts = {};

  if (fsConfig.projectId) opts.projectId = fsConfig.projectId;
  if (fsConfig.keyFilename) opts.keyFilename = fsConfig.keyFilename;
  opts.ignoreUndefinedProperties = true;

  _db = new Firestore(opts);
  return _db;
}

// ---------------------------------------------------------------------------
// Query translator: MongoDB-style query → Firestore constraints
//
// Supported operators:
//   { field: value }            equality
//   { field: { $ne: v } }      !=
//   { field: { $in: [...] } }  in
//   { field: { $gt/$lt/$gte/$lte: v } }  range
//   { field: { $exists: true/false } }   != null / == null
//   { $or: [ {...}, {...} ] }   Firestore OR (native in Native mode)
// ---------------------------------------------------------------------------

// Convert values with custom prototypes (e.g. Mongoose ObjectId) to plain
// primitives so Firestore's serializer doesn't reject them.
function serializeValue(val) {
  if (val === null || val === undefined) return val;
  if (val instanceof Date) return val;
  if (Array.isArray(val)) return val.map(serializeValue);
  if (typeof val === 'object' && val.constructor !== Object) return val.toString();
  return val;
}

// True when `key` is an array-typed path in the model schema. Mongoose treats
// `{ arrayField: { $in: [...] } }` as "matches any element"; Firestore's `in`
// operator only does scalar equality, so array fields need `array-contains-any`.
// modelSchema is the lightweight object built in createModel, so we rely on the
// _array_paths set extracted there (the raw mongoose schema is not kept around).
function isArrayPath(modelSchema, key) {
  return !!(modelSchema && modelSchema._array_paths && modelSchema._array_paths[key]);
}

// Picks the Firestore operator for a $in, depending on whether the field is an array.
function inOperator(modelSchema, key) {
  return isArrayPath(modelSchema, key) ? 'array-contains-any' : 'in';
}

function applyConstraints(query, filter, modelSchema) {
  if (!filter || typeof filter !== 'object') return query;

  Object.keys(filter).forEach(function(key) {
    if (key === '$or') {
      // Firestore Native supports OR queries via Filter.or()
      var orFilters = filter.$or.map(function(clause) {
        return buildFirestoreFilter(clause, modelSchema);
      });
      query = query.where(Firestore.Filter.or.apply(null, orFilters));
      return;
    }

    var val = filter[key];

    if (val === null || typeof val !== 'object' || val instanceof Date) {
      query = query.where(key, '==', serializeValue(val));
      return;
    }

    if ('$ne' in val) {
      query = query.where(key, '!=', serializeValue(val.$ne));
    } else if ('$in' in val) {
      query = query.where(key, inOperator(modelSchema, key), serializeValue(val.$in));
    } else if ('$gt' in val) {
      query = query.where(key, '>', serializeValue(val.$gt));
    } else if ('$gte' in val) {
      query = query.where(key, '>=', serializeValue(val.$gte));
    } else if ('$lt' in val) {
      query = query.where(key, '<', serializeValue(val.$lt));
    } else if ('$lte' in val) {
      query = query.where(key, '<=', serializeValue(val.$lte));
    } else if ('$exists' in val) {
      query = query.where(key, val.$exists ? '!=' : '==', null);
    } else {
      // nested object equality
      query = query.where(key, '==', serializeValue(val));
    }
  });

  return query;
}

// Build a Firestore Filter object (used for $or)
function buildFirestoreFilter(clause, modelSchema) {
  var filters = Object.keys(clause).map(function(key) {
    var val = clause[key];
    if (val === null || typeof val !== 'object' || val instanceof Date) {
      return Firestore.Filter.where(key, '==', serializeValue(val));
    }
    if ('$ne' in val)  return Firestore.Filter.where(key, '!=', serializeValue(val.$ne));
    if ('$in' in val)  return Firestore.Filter.where(key, inOperator(modelSchema, key), serializeValue(val.$in));
    if ('$gt' in val)  return Firestore.Filter.where(key, '>', serializeValue(val.$gt));
    if ('$gte' in val) return Firestore.Filter.where(key, '>=', serializeValue(val.$gte));
    if ('$lt' in val)  return Firestore.Filter.where(key, '<', serializeValue(val.$lt));
    if ('$lte' in val) return Firestore.Filter.where(key, '<=', serializeValue(val.$lte));
    return Firestore.Filter.where(key, '==', serializeValue(val));
  });

  return filters.length === 1 ? filters[0] : Firestore.Filter.and.apply(null, filters);
}

// ---------------------------------------------------------------------------
// Update translator: MongoDB-style update → plain data patch
//
// Supported:
//   { $set: { field: val } }
//   { $inc: { field: n } }   → FieldValue.increment(n)
//   { $push: { field: v } }  → FieldValue.arrayUnion(v)
//   { $pull: { field: v } }  → FieldValue.arrayRemove(v)
//   { field: val }           bare field update (treated as $set)
// ---------------------------------------------------------------------------

function translateUpdate(update) {
  var patch = {};

  Object.keys(update).forEach(function(op) {
    if (op === '$set') {
      Object.assign(patch, update.$set);
    } else if (op === '$inc') {
      Object.keys(update.$inc).forEach(function(field) {
        patch[field] = Firestore.FieldValue.increment(update.$inc[field]);
      });
    } else if (op === '$push') {
      Object.keys(update.$push).forEach(function(field) {
        var v = update.$push[field];
        // $push with $each: push multiple values
        var values = (v && v.$each) ? v.$each : [v];
        patch[field] = Firestore.FieldValue.arrayUnion.apply(null, values);
      });
    } else if (op === '$pull') {
      Object.keys(update.$pull).forEach(function(field) {
        patch[field] = Firestore.FieldValue.arrayRemove(update.$pull[field]);
      });
    } else if (op === '$addToSet') {
      Object.keys(update.$addToSet).forEach(function(field) {
        var v = update.$addToSet[field];
        patch[field] = Firestore.FieldValue.arrayUnion(v);
      });
    } else if (!op.startsWith('$')) {
      // bare field
      patch[op] = update[op];
    }
  });

  return patch;
}

// set()-based writes (upserts) need dotted keys expanded into nested maps:
// unlike update(), set() treats 'metrics.forks' as a LITERAL field name, so a
// patch like { 'metrics.forks': increment(1) } would create a field called
// "metrics.forks" instead of incrementing metrics.forks. (This was exactly the
// bug that made fork/run counts vanish on the firestore backend.)
function expandDottedKeys(patch) {
  var out = {};
  Object.keys(patch).forEach(function(key) {
    if (key.indexOf('.') === -1) { out[key] = patch[key]; return; }
    var parts = key.split('.');
    var obj = out;
    for (var i = 0; i < parts.length - 1; i++) {
      if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = patch[key];
  });
  return out;
}

// ---------------------------------------------------------------------------
// Sort translator: Mongoose sort string/object → Firestore orderBy calls
// ---------------------------------------------------------------------------

function applySort(query, sort) {
  if (!sort) return query;

  if (typeof sort === 'string') {
    var parts = sort.trim().split(/\s+/);
    parts.forEach(function(part) {
      var dir = 'asc';
      if (part.startsWith('-')) { dir = 'desc'; part = part.slice(1); }
      query = query.orderBy(part, dir);
    });
    return query;
  }

  if (typeof sort === 'object') {
    Object.keys(sort).forEach(function(field) {
      var dir = sort[field] === -1 || sort[field] === 'desc' ? 'desc' : 'asc';
      query = query.orderBy(field, dir);
    });
  }

  return query;
}

// ---------------------------------------------------------------------------
// FirestoreDocument — wraps a Firestore document, looks like a Mongoose doc
// ---------------------------------------------------------------------------

// Add Mongoose-compatible .pull() to a plain JS array so callers can use
// arr.pull(id) regardless of which backend is active.
function augmentArray(arr) {
  if (!Array.isArray(arr) || typeof arr.pull === 'function') return arr;
  Object.defineProperty(arr, 'pull', {
    value: function() {
      var toRemove = Array.prototype.slice.call(arguments).map(function(v) {
        return String(v && (v._id || v.id || v));
      });
      for (var i = arr.length - 1; i >= 0; i--) {
        var el = arr[i];
        if (toRemove.indexOf(String(el && (el._id || el.id || el))) !== -1) {
          arr.splice(i, 1);
        }
      }
      return arr;
    },
    enumerable: false, configurable: true, writable: true
  });
  return arr;
}

// Add a non-enumerable toJSON() shim to any plain nested object that lacks one.
// Templates (nunjucks) call subdoc.toJSON() expecting a plain-object back —
// Mongoose subdocuments have this; Firestore plain objects do not.
function shimToJSON(val) {
  if (val === null || typeof val !== 'object' || Array.isArray(val) || val instanceof Date) return;
  if (typeof val.toJSON !== 'function') {
    Object.defineProperty(val, 'toJSON', {
      value: function() { return Object.assign({}, this); },
      enumerable: false, configurable: true, writable: true
    });
  }
  Object.keys(val).forEach(function(k) { shimToJSON(val[k]); });
}

function isFirestoreTimestamp(val) {
  return val !== null && typeof val === 'object' && typeof val.toDate === 'function' &&
    (typeof val._seconds === 'number' || typeof val.seconds === 'number');
}

function convertTimestamps(val) {
  if (val === null || val === undefined) return val;
  if (isFirestoreTimestamp(val)) return val.toDate();
  if (Array.isArray(val)) return val.map(convertTimestamps);
  if (typeof val === 'object' && !(val instanceof Date) && val.constructor === Object) {
    var result = {};
    Object.keys(val).forEach(function(k) { result[k] = convertTimestamps(val[k]); });
    return result;
  }
  return val;
}

function FirestoreDocument(data, collectionRef, modelSchema) {
  var self = this;
  // Convert Firestore Timestamp objects to JS Dates on read so callers get
  // real Date instances (instead of {_seconds, _nanoseconds} plain objects).
  var _data = convertTimestamps(Object.assign({}, data));
  var _original;   // snapshotted below, after schema defaults are applied
  var _modified = {};
  var _isNew = !data._id;

  self._id = _data._id || getDb().collection('_').doc().id;
  self.id = self._id.toString();
  self._collectionRef = collectionRef;

  // Copy data fields to the document (so code can access doc.email, doc.name, etc.)
  Object.keys(_data).forEach(function(k) {
    if (k !== '_id') self[k] = Array.isArray(_data[k]) ? augmentArray(_data[k]) : _data[k];
  });

  // Apply schema defaults for fields not present in the incoming data
  var schemaDefaults = (modelSchema && modelSchema._defaults) || {};
  Object.keys(schemaDefaults).forEach(function(k) {
    if (!(k in _data) || _data[k] === undefined) {
      var defVal = schemaDefaults[k];
      _data[k] = Array.isArray(defVal) ? augmentArray([]) : defVal;
      self[k] = _data[k];
    }
  });

  // Apply subdocument defaults for array fields (e.g. users[].hideFrom, users[].roles)
  var subdocDefaults = (modelSchema && modelSchema._subdoc_defaults) || {};
  Object.keys(subdocDefaults).forEach(function(k) {
    if (!Array.isArray(self[k])) return;
    var fieldDefaults = subdocDefaults[k];
    self[k].forEach(function(element) {
      if (!element || typeof element !== 'object') return;
      Object.keys(fieldDefaults).forEach(function(subKey) {
        if (!(subKey in element) || element[subKey] === undefined) {
          var defVal = fieldDefaults[subKey];
          element[subKey] = Array.isArray(defVal) ? [] : defVal;
        }
      });
    });
  });

  // Shim toJSON() onto any nested plain objects so templates can call subdoc.toJSON()
  // Must run AFTER schema defaults so that default-provided objects also get shimmed.
  Object.keys(self).forEach(function(k) { if (!k.startsWith('_')) shimToJSON(self[k]); });

  // Snapshot AFTER defaults so default-filled fields don't read as "modified".
  _original = Object.assign({}, _data);

  self.isNew = _isNew;

  // Modification tracking has two sources:
  //  - _modified: fields written through set()/markModified()
  //  - reference/value drift vs _original: catches DIRECT property assignment
  //    (`user.password = x`), which pre-save hooks like encryptPassword rely on.
  //    (In-place mutation of nested objects still needs markModified(), same
  //    as Mongoose Mixed paths.)
  function assignedSince(field) {
    return self[field] !== _original[field];
  }

  self.isModified = function(field) {
    // New documents: all populated fields are considered modified (matches Mongoose behavior)
    if (_isNew) return field ? (field in _data) : Object.keys(_data).length > 0;
    if (field) return (field in _modified) || assignedSince(field);
    if (Object.keys(_modified).length > 0) return true;
    return Object.keys(self).some(function(k) {
      if (k in _INTERNAL || k in _SKIP || typeof self[k] === 'function') return false;
      return assignedSince(k);
    });
  };

  self.set = function(field, value) {
    if (field && typeof field === 'object') {
      Object.keys(field).forEach(function(k) { self.set(k, field[k]); });
      return;
    }
    var val = Array.isArray(value) ? augmentArray(value) : value;
    self[field] = val;
    _data[field] = val;
    _modified[field] = true;
  };

  self.get = function(field) {
    return _data[field];
  };

  // Names that are always on the instance but are not data fields
  // Properties on `self` that are never data fields
  var _INTERNAL = { _id: 1, _collectionRef: 1 };
  var _SKIP = { id: 1, isNew: 1, __v: 1,
                isModified: 1, set: 1, get: 1, toObject: 1, toJSON: 1,
                save: 1, remove: 1, markModified: 1, modifiedPaths: 1,
                populated: 1, serialize: 1 };

  // Coerce a value for Firestore storage. Mongoose-style document refs are
  // stored as their string ID (mirrors ObjectId coercion in Mongoose).
  function coerceForStorage(val) {
    if (val && typeof val === 'object' && typeof val._id !== 'undefined' && typeof val.save === 'function') {
      return val._id.toString();
    }
    return val;
  }

  // Scan own enumerable properties so fields written by pre-save hooks
  // (e.g. `this.slug = '...'`) are included, not just the original _data keys.
  // NOTE: _owner, _creator etc. (Mongoose-convention data fields) must NOT be skipped.
  self.toObject = function() {
    var obj = {};
    Object.keys(self).forEach(function(k) {
      if (k in _INTERNAL) return;         // truly internal: _id (added below), _collectionRef
      if (k in _SKIP) return;             // non-data instance methods/properties
      if (typeof self[k] === 'function') return; // instance methods
      obj[k] = coerceForStorage(self[k]);
    });
    // Also pull any _data fields not yet promoted to self (e.g. loaded from Firestore)
    Object.keys(_data).forEach(function(k) {
      if (k !== '_id' && !(k in obj)) obj[k] = _data[k];
    });
    obj._id = self._id;
    obj.id  = self.id;   // Restangular and frontend code expect 'id' alongside '_id'
    return obj;
  };

  self.toJSON = self.toObject;

  // Run pre-save hooks then write to Firestore, then run post-save hooks
  self.save = function(cb) {
    return new Promise(function(resolve, reject) {
      var preHooks  = (modelSchema && modelSchema._pre_save_hooks)  || [];
      var postHooks = (modelSchema && modelSchema._post_save_hooks) || [];
      var i = 0;

      function runNext(err) {
        if (err) return cb ? cb(err) : reject(err);
        if (i >= preHooks.length) return persist();
        var hook = preHooks[i++];
        try {
          hook.call(self, runNext);
        } catch (e) {
          runNext(e);
        }
      }

      function runPostHooks() {
        var j = 0;
        function nextPost() {
          if (j >= postHooks.length) {
            if (cb) cb(null, self);
            resolve(self);
            return;
          }
          var hook = postHooks[j++];
          try {
            hook.call(self);
            nextPost();
          } catch (e) {
            // Post-save hook errors are non-fatal; log and continue
            console.error('post-save hook error:', e);
            nextPost();
          }
        }
        nextPost();
      }

      function persist() {
        var docData = self.toObject();
        // Timestamps
        var now = new Date();
        if (_isNew) docData.created = docData.created || now;
        docData.lastUpdated = now;
        _isNew = false;

        collectionRef.doc(self._id).set(docData)
          .then(function() {
            _original = Object.assign({}, docData);
            _modified = {};
            runPostHooks();
          })
          .catch(function(err) {
            if (cb) cb(err);
            reject(err);
          });
      }

      runNext();
    });
  };

  self.remove = function(cb) {
    return collectionRef.doc(self._id).delete()
      .then(function() { if (cb) cb(null, self); return self; })
      .catch(function(err) { if (cb) cb(err); throw err; });
  };

  // Mongoose 6 renamed doc.remove() to doc.deleteOne(); callers use both.
  self.deleteOne = self.remove;

  // Mongoose compat
  self.markModified = function(field) { _modified[field] = true; };
  self.modifiedPaths = function() { return Object.keys(_modified); };
  self.populated = function() { return null; };
  self.toJSON = function() { return self.toObject(); };
  self.serialize = function() { return self.toObject(); };
  self.__v = 0;

  // populate(spec) — fetch referenced documents and replace ID arrays with document arrays.
  // spec: string fieldName OR Mongoose-style { path, select, match } object.
  self.populate = function(spec) {
    var fieldName = typeof spec === 'string' ? spec : spec && spec.path;
    if (!fieldName) return Promise.resolve(self);

    var refs = (modelSchema && modelSchema._refs) || {};
    var collectionName = refs[fieldName];
    if (!collectionName) return Promise.resolve(self); // no ref — nothing to fetch

    var ids = self[fieldName];
    if (!ids) return Promise.resolve(self);

    var col = getDb().collection(collectionName);
    var targetModelSchema = _modelRegistry[collectionName] || null;

    // Single ID (not array)
    if (!Array.isArray(ids)) {
      var singleId = ids.toString ? ids.toString() : ids;
      return col.doc(singleId).get()
        .then(function(snap) {
          if (snap.exists) {
            self[fieldName] = docToInstance(snap.data(), col, targetModelSchema);
          }
          return self;
        });
    }

    // Array of IDs
    if (ids.length === 0) return Promise.resolve(self);

    var match = spec && spec.match;
    var promises = ids.map(function(id) {
      var idStr = id && id.toString ? id.toString() : id;
      return col.doc(idStr).get().then(function(snap) {
        return snap.exists ? snap.data() : null;
      });
    });

    return Promise.all(promises).then(function(docs) {
      var results = docs
        .filter(function(d) { return d !== null; })
        .map(function(d) { return docToInstance(d, col, targetModelSchema); });

      // Apply match filter if provided
      if (match) {
        results = results.filter(function(doc) {
          return matchesFilter(doc, match);
        });
      }

      self[fieldName] = results;
      return self;
    });
  };
}

// ---------------------------------------------------------------------------
// ChainableQuery — mimics Mongoose chainable query API
// ---------------------------------------------------------------------------

function ChainableQuery(collectionRef, filter, modelSchema, fields) {
  this._collectionRef = collectionRef;
  this._filter = filter || {};
  this._modelSchema = modelSchema;
  this._fields = fields || null;
  this._sort = null;
  this._limit = null;
  this._skip = null;
}

ChainableQuery.prototype.sort = function(sort) {
  this._sort = sort;
  return this;
};

ChainableQuery.prototype.limit = function(n) {
  this._limit = n;
  return this;
};

ChainableQuery.prototype.skip = function(n) {
  this._skip = n;
  return this;
};

ChainableQuery.prototype.select = function(fields) {
  this._fields = fields;
  return this;
};

// No-op: Firestore doesn't support joins; callers do N+1 explicitly
ChainableQuery.prototype.populate = function() {
  return this;
};

// No-op: Firestore documents are already plain objects
ChainableQuery.prototype.lean = function() {
  return this;
};

ChainableQuery.prototype.exec = function(cb) {
  var self = this;
  var promise = self._run();
  if (cb) {
    promise.then(function(docs) { cb(null, docs); }).catch(cb);
    return;
  }
  return promise;
};

ChainableQuery.prototype.then = function(resolve, reject) {
  return this._run().then(resolve, reject);
};

ChainableQuery.prototype.catch = function(reject) {
  return this._run().catch(reject);
};

ChainableQuery.prototype.count = function(cb) {
  var self = this;
  var query = applyConstraints(self._collectionRef, self._filter, self._modelSchema);
  var promise = query.count().get().then(function(snap) {
    return snap.data().count;
  });
  if (cb) { promise.then(function(n) { cb(null, n); }).catch(cb); return; }
  return promise;
};

ChainableQuery.prototype._run = function() {
  var self = this;
  var query = applyConstraints(self._collectionRef, self._filter, self._modelSchema);
  if (self._sort) query = applySort(query, self._sort);
  if (self._skip) query = query.offset(self._skip);
  if (self._limit) query = query.limit(self._limit);

  return query.get().then(function(snap) {
    var docs = snap.docs.map(function(doc) {
      return docToInstance(doc.data(), self._collectionRef, self._modelSchema);
    });
    return self._single ? (docs[0] || null) : docs;
  });
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function docToInstance(data, collectionRef, modelSchema) {
  if (!data) return null;
  var doc = new FirestoreDocument(data, collectionRef, modelSchema);
  // Attach instance methods from schema
  if (modelSchema && modelSchema._instance_methods) {
    Object.keys(modelSchema._instance_methods).forEach(function(method) {
      doc[method] = modelSchema._instance_methods[method].bind(doc);
    });
  }
  return doc;
}

// ---------------------------------------------------------------------------
// FirestoreModelClass — what class methods are bound to via {model: <this>}
// ---------------------------------------------------------------------------

function FirestoreModelClass(collectionName, modelSchema) {
  this._collectionName = collectionName;
  this._modelSchema = modelSchema;
}

FirestoreModelClass.prototype._col = function() {
  return getDb().collection(this._collectionName);
};

FirestoreModelClass.prototype.find = function(filter, fields, cb) {
  if (typeof fields === 'function') { cb = fields; fields = null; }
  var query = new ChainableQuery(this._col(), filter, this._modelSchema, fields);
  if (cb) { query._run().then(function(d) { cb(null, d); }).catch(cb); return; }
  return query;
};

FirestoreModelClass.prototype.findOne = function(filter, cb) {
  var self = this;
  var query = new ChainableQuery(self._col(), filter, self._modelSchema);
  query._limit = 1;
  query._single = true;
  if (cb) { query._run().then(function(d) { cb(null, d); }).catch(cb); return; }
  return query;
};

FirestoreModelClass.prototype.findById = function(id, cb) {
  var self = this;
  var promise = self._col().doc(id.toString()).get().then(function(snap) {
    if (!snap.exists) return null;
    return docToInstance(snap.data(), self._col(), self._modelSchema);
  });
  if (cb) { promise.then(function(d) { cb(null, d); }).catch(cb); return; }
  return promise;
};

FirestoreModelClass.prototype.findOneAndUpdate = function(filter, update, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  var self = this;
  var patch = translateUpdate(update);
  var upsert = options && options.upsert;

  var promise = self.findOne(filter).then(function(existing) {
    if (existing) {
      return self._col().doc(existing._id).update(patch).then(function() {
        return self._col().doc(existing._id).get();
      }).then(function(snap) {
        return docToInstance(snap.data(), self._col(), self._modelSchema);
      });
    } else if (upsert) {
      var ref = self._col().doc();
      var data = Object.assign({ _id: ref.id }, expandDottedKeys(patch));
      return ref.set(data).then(function() {
        return ref.get();
      }).then(function(snap) {
        return docToInstance(snap.data(), self._col(), self._modelSchema);
      });
    }
    return null;
  });

  // Attach .exec() so callers using the Mongoose query pattern work
  promise.exec = function() { return promise; };

  if (cb) { promise.then(function(d) { cb(null, d); }).catch(cb); return; }
  return promise;
};

FirestoreModelClass.prototype.findByIdAndUpdate = function(id, update, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  var self = this;
  var ref = self._col().doc(id.toString());
  var patch = translateUpdate(update);

  var promise = (options && options.upsert)
    ? ref.set(expandDottedKeys(patch), { merge: true }).then(function() { return ref.get(); })
    : ref.update(patch).then(function() { return ref.get(); });

  promise = promise.then(function(snap) {
    return docToInstance(snap.data ? snap.data() : snap, self._col(), self._modelSchema);
  });

  if (cb) { promise.then(function(d) { cb(null, d); }).catch(cb); return; }
  return promise;
};

FirestoreModelClass.prototype.deleteOne = function(filter, cb) {
  var self = this;
  var promise = self.findOne(filter).then(function(doc) {
    if (!doc) return;
    return self._col().doc(doc._id).delete();
  });
  if (cb) { promise.then(function() { cb(null); }).catch(cb); return; }
  return promise;
};

FirestoreModelClass.prototype.deleteMany = function(filter, cb) {
  var self = this;
  var promise = new ChainableQuery(self._col(), filter, self._modelSchema)._run()
    .then(function(docs) {
      var batch = getDb().batch();
      docs.forEach(function(doc) { batch.delete(self._col().doc(doc._id)); });
      return batch.commit();
    });
  promise.exec = function() { return promise; };
  if (cb) { promise.then(function() { cb(null); }).catch(cb); return; }
  return promise;
};

// Resolve MongoDB positional updates (e.g. "users.$.roles") against a document.
// Finds the matching array element using the $elemMatch condition from the filter,
// mutates the array in place, and returns a { arrayField: updatedArray } patch.
function resolvePositionalUpdates(setFields, filter, doc) {
  var patch = {};
  Object.keys(setFields).forEach(function(path) {
    var parts = path.split('.$.');
    if (parts.length !== 2) { patch[path] = setFields[path]; return; }

    var arrayField = parts[0];   // e.g. "users"
    var subField   = parts[1];   // e.g. "roles"
    // Use already-patched array if this field was touched earlier in the same update
    var arr = patch[arrayField] || doc[arrayField];
    if (!Array.isArray(arr)) { return; }

    // Find the $elemMatch condition for this array field in the filter
    var matchCondition = filter[arrayField] && filter[arrayField].$elemMatch;
    if (!matchCondition) { return; }

    // Find the index of the matching element
    var idx = arr.findIndex(function(el) {
      return Object.keys(matchCondition).every(function(k) {
        return el[k] && el[k].toString() === matchCondition[k].toString();
      });
    });

    if (idx === -1) { return; }

    // Clone the array (only once per arrayField — reuse if already cloned)
    var updated = patch[arrayField] ? arr : arr.slice();
    if (!patch[arrayField]) updated[idx] = Object.assign({}, updated[idx]);
    updated[idx][subField] = setFields[path];
    patch[arrayField] = updated;
  });
  return patch;
}

// Resolve $push/$pull with positional operator (e.g. "users.$.hideFrom")
function resolvePositionalArrayOp(fields, filter, doc, op) {
  var patch = {};
  Object.keys(fields).forEach(function(path) {
    var parts = path.split('.$.');
    if (parts.length !== 2) {
      // non-positional — handle normally
      var v = fields[path];
      if (op === '$push') {
        var values = (v && v.$each) ? v.$each : [v];
        patch[path] = Firestore.FieldValue.arrayUnion.apply(null, values);
      } else {
        patch[path] = Firestore.FieldValue.arrayRemove(v);
      }
      return;
    }

    var arrayField = parts[0];
    var subField   = parts[1];
    var arr = doc[arrayField];
    if (!Array.isArray(arr)) { return; }

    var matchCondition = filter[arrayField] && filter[arrayField].$elemMatch;
    if (!matchCondition) { return; }

    var idx = arr.findIndex(function(el) {
      return Object.keys(matchCondition).every(function(k) {
        return el[k] && el[k].toString() === matchCondition[k].toString();
      });
    });
    if (idx === -1) { return; }

    var updated = arr.slice();
    updated[idx] = Object.assign({}, updated[idx]);
    var subArr = (updated[idx][subField] || []).slice();
    var val = fields[path];
    if (op === '$push') {
      var pushVals = (val && val.$each) ? val.$each : [val];
      pushVals.forEach(function(v) { if (subArr.indexOf(v) === -1) subArr.push(v); });
    } else {
      subArr = subArr.filter(function(v) { return v !== val; });
    }
    updated[idx][subField] = subArr;
    patch[arrayField] = updated;
  });
  return patch;
}

FirestoreModelClass.prototype.updateOne = function(filter, update, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  var self = this;

  // Check whether this update uses any positional operators
  var hasPositional = Object.keys(update).some(function(op) {
    var fields = update[op];
    return fields && typeof fields === 'object' &&
      Object.keys(fields).some(function(k) { return k.indexOf('.$.' ) !== -1; });
  });

  // Firestore can't evaluate $elemMatch at query time — strip those conditions
  // so findOne can locate the document by _id. resolvePositionalUpdates handles
  // the array-element matching in memory.
  var findFilter = filter;
  if (hasPositional) {
    findFilter = {};
    Object.keys(filter).forEach(function(k) {
      if (filter[k] && typeof filter[k] === 'object' && '$elemMatch' in filter[k]) return;
      findFilter[k] = filter[k];
    });
  }

  var promise = self.findOne(findFilter).then(function(existing) {
    if (!existing) return null;

    var patch;
    if (hasPositional) {
      // Resolve positional paths against the loaded document
      patch = {};
      if (update.$set)  Object.assign(patch, resolvePositionalUpdates(update.$set, filter, existing));
      if (update.$push) Object.assign(patch, resolvePositionalArrayOp(update.$push, filter, existing, '$push'));
      if (update.$pull) Object.assign(patch, resolvePositionalArrayOp(update.$pull, filter, existing, '$pull'));
      // Any non-positional $set fields
      if (update.$set) {
        Object.keys(update.$set).forEach(function(k) {
          if (k.indexOf('.$.') === -1) patch[k] = update.$set[k];
        });
      }
    } else {
      patch = translateUpdate(update);
    }

    return self._col().doc(existing._id).update(patch).then(function() {
      return self._col().doc(existing._id).get();
    }).then(function(snap) {
      return docToInstance(snap.data(), self._col(), self._modelSchema);
    });
  });

  promise.exec = function() { return promise; };
  if (cb) { promise.then(function(d) { cb(null, d); }).catch(cb); return; }
  return promise;
};

FirestoreModelClass.prototype.count = function(filter, cb) {
  var query = applyConstraints(this._col(), filter || {}, this._modelSchema);
  var promise = query.count().get().then(function(snap) { return snap.data().count; });
  if (cb) { promise.then(function(n) { cb(null, n); }).catch(cb); return; }
  return promise;
};

// Aggregation: Firestore doesn't support pipelines — callers that need this
// must override the relevant class methods on the model. Return empty for now
// so the app doesn't crash on startup.
FirestoreModelClass.prototype.aggregate = function() {
  return Promise.resolve([]);
};

// ---------------------------------------------------------------------------
// Constructor function returned by createModel
// This is what class methods call as `new this.model(data)`
// ---------------------------------------------------------------------------

function makeConstructor(collectionName, modelSchema, classInstance) {
  function Model(data) {
    if (!(this instanceof Model)) return new Model(data);
    var doc = new FirestoreDocument(data || {}, getDb().collection(collectionName), modelSchema);
    // Attach instance methods
    if (modelSchema && modelSchema._instance_methods) {
      Object.keys(modelSchema._instance_methods).forEach(function(method) {
        doc[method] = modelSchema._instance_methods[method].bind(doc);
      });
    }
    return doc;
  }

  // Copy all FirestoreModelClass methods onto the constructor function
  // so `this.model.findOne(...)` etc. work when called with {model: constructor}
  Object.keys(FirestoreModelClass.prototype).forEach(function(method) {
    Model[method] = FirestoreModelClass.prototype[method].bind(classInstance);
  });

  Model._collectionName = collectionName;
  Model._modelSchema = modelSchema;

  return Model;
}

// ---------------------------------------------------------------------------
// Hook extraction from Mongoose schema
//
// model.js calls schema.pre() / schema.post() before createModel().
// We extract the pre-save hooks so FirestoreDocument.save() can run them.
// ---------------------------------------------------------------------------

function extractHooks(schema) {
  var preSave = [];
  var postSave = [];

  try {
    var hooks = schema.s && schema.s.hooks;
    if (hooks) {
      if (hooks._pres && hooks._pres.get('save')) {
        hooks._pres.get('save').forEach(function(h) {
          if (h.fn) preSave.push(h.fn);
        });
      }
      if (hooks._posts && hooks._posts.get('save')) {
        hooks._posts.get('save').forEach(function(h) {
          if (h.fn) postSave.push(h.fn);
        });
      }
    }
  } catch (e) {
    // Ignore — hooks won't run but nothing will crash
  }

  return { preSave: preSave, postSave: postSave };
}

// ---------------------------------------------------------------------------
// extractDefaults — build a flat map of top-level field defaults from the schema
// ---------------------------------------------------------------------------

function extractDefaults(schema) {
  var defaults = {};
  if (!schema || !schema.paths) return defaults;
  Object.keys(schema.paths).forEach(function(pathName) {
    if (pathName === '__v' || pathName === '_id') return;
    var sp = schema.paths[pathName];
    var isDotted = pathName.indexOf('.') !== -1;

    if (!isDotted) {
      // Top-level path
      if (sp.instance === 'Array' || sp.$isMongooseArray) {
        defaults[pathName] = [];
      } else {
        var def = sp.defaultValue;
        if (typeof def === 'undefined') return;
        try { defaults[pathName] = typeof def === 'function' ? def() : def; } catch (e) {}
      }
    } else {
      // Nested path (e.g. 'settings.theme') — build nested default object
      var def = sp.defaultValue;
      if (typeof def === 'undefined') return;
      var val;
      try { val = typeof def === 'function' ? def() : def; } catch (e) { return; }
      var parts = pathName.split('.');
      var obj = defaults;
      for (var i = 0; i < parts.length - 1; i++) {
        if (typeof obj[parts[i]] !== 'object' || obj[parts[i]] === null) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = val;
    }
  });
  return defaults;
}

// ---------------------------------------------------------------------------
// extractSubdocDefaults — build defaults for each element of DocumentArray fields
// ---------------------------------------------------------------------------

function extractSubdocDefaults(schema) {
  var subdocDefaults = {};
  if (!schema || !schema.paths) return subdocDefaults;
  Object.keys(schema.paths).forEach(function(pathName) {
    if (pathName === '__v' || pathName === '_id') return;
    if (pathName.indexOf('.') !== -1) return;
    var sp = schema.paths[pathName];
    if (!sp.schema || !sp.schema.paths) return; // not a DocumentArray
    var subDefaults = {};
    Object.keys(sp.schema.paths).forEach(function(subPath) {
      if (subPath === '__v' || subPath === '_id') return;
      var subSp = sp.schema.paths[subPath];
      if (subSp.instance === 'Array' || subSp.$isMongooseArray) {
        subDefaults[subPath] = [];
      } else {
        var def = subSp.defaultValue;
        if (typeof def === 'undefined') return;
        try { subDefaults[subPath] = typeof def === 'function' ? def() : def; } catch (e) {}
      }
    });
    if (Object.keys(subDefaults).length > 0) {
      subdocDefaults[pathName] = subDefaults;
    }
  });
  return subdocDefaults;
}

// ---------------------------------------------------------------------------
// matchesFilter — evaluate a Mongoose-style match object against a document.
// Handles $or and field-level $ne / equality.
// ---------------------------------------------------------------------------

function matchesFilter(doc, filter) {
  return Object.keys(filter).every(function(k) {
    if (k === '$or') {
      return filter.$or.some(function(clause) {
        return matchesFilter(doc, clause);
      });
    }
    var cond = filter[k];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$ne' in cond) return doc[k] !== cond.$ne;
    }
    return doc[k] === cond;
  });
}

// extractRefs — build a map of { fieldName: 'CollectionName' } for populate()
// ---------------------------------------------------------------------------

// Collects top-level array-typed path names so the query translator can pick
// `array-contains-any` over `in` for $in on those fields (Mongo array semantics).
function extractArrayPaths(schema) {
  var arrays = {};
  if (!schema || !schema.paths) return arrays;
  Object.keys(schema.paths).forEach(function(pathName) {
    if (pathName.indexOf('.') !== -1) return; // skip nested
    if (schema.paths[pathName].instance === 'Array') arrays[pathName] = true;
  });
  return arrays;
}

function extractRefs(schema) {
  var refs = {};
  if (!schema || !schema.paths) return refs;
  Object.keys(schema.paths).forEach(function(pathName) {
    if (pathName.indexOf('.') !== -1) return; // skip nested
    var sp = schema.paths[pathName];
    // Single ObjectId with ref: sp.options.ref
    var ref = sp.options && sp.options.ref;
    // Array of ObjectIds with ref: sp.caster && sp.caster.options.ref
    if (!ref && sp.caster) ref = sp.caster.options && sp.caster.options.ref;
    if (ref) refs[pathName] = ref.toLowerCase() + 's'; // 'Lesson' → 'lessons'
  });
  return refs;
}

// ---------------------------------------------------------------------------
// extractInstanceMethods — pull schema.methods into a plain object
// ---------------------------------------------------------------------------

function extractInstanceMethods(schema) {
  var methods = {};
  if (schema && schema.methods) {
    Object.keys(schema.methods).forEach(function(name) {
      methods[name] = schema.methods[name];
    });
  }
  return methods;
}

// ---------------------------------------------------------------------------
// Public: createModel(modelName, schema) → constructor with class methods
// ---------------------------------------------------------------------------

function createModel(modelName, schema) {
  var collectionName = modelName.toLowerCase() + 's';

  var hooks = extractHooks(schema);
  var instanceMethods = extractInstanceMethods(schema);

  // Build a lightweight "modelSchema" object that FirestoreDocument uses
  var modelSchema = {
    _pre_save_hooks: hooks.preSave,
    _post_save_hooks: hooks.postSave,
    _instance_methods: instanceMethods,
    _defaults: extractDefaults(schema),
    _subdoc_defaults: extractSubdocDefaults(schema),
    _refs: extractRefs(schema),
    _array_paths: extractArrayPaths(schema)
  };

  _modelRegistry[collectionName] = modelSchema;

  var classInstance = new FirestoreModelClass(collectionName, modelSchema);
  return makeConstructor(collectionName, modelSchema, classInstance);
}

// Global registry: collectionName → modelSchema (for use by populate())
var _modelRegistry = {};

module.exports = {
  createModel: createModel,
  // Exposed for unit tests only — not part of the public API
  _test: {
    FirestoreDocument: FirestoreDocument,
    extractDefaults: extractDefaults,
    extractSubdocDefaults: extractSubdocDefaults,
    resolvePositionalUpdates: resolvePositionalUpdates,
    resolvePositionalArrayOp: resolvePositionalArrayOp
  }
};
