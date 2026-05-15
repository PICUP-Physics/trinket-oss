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

function applyConstraints(query, filter) {
  if (!filter || typeof filter !== 'object') return query;

  Object.keys(filter).forEach(function(key) {
    if (key === '$or') {
      // Firestore Native supports OR queries via Filter.or()
      var orFilters = filter.$or.map(function(clause) {
        return buildFirestoreFilter(clause);
      });
      query = query.where(Firestore.Filter.or.apply(null, orFilters));
      return;
    }

    var val = filter[key];

    if (val === null || typeof val !== 'object' || val instanceof Date) {
      query = query.where(key, '==', val);
      return;
    }

    if ('$ne' in val) {
      query = query.where(key, '!=', val.$ne);
    } else if ('$in' in val) {
      query = query.where(key, 'in', val.$in);
    } else if ('$gt' in val) {
      query = query.where(key, '>', val.$gt);
    } else if ('$gte' in val) {
      query = query.where(key, '>=', val.$gte);
    } else if ('$lt' in val) {
      query = query.where(key, '<', val.$lt);
    } else if ('$lte' in val) {
      query = query.where(key, '<=', val.$lte);
    } else if ('$exists' in val) {
      query = query.where(key, val.$exists ? '!=' : '==', null);
    } else {
      // nested object equality
      query = query.where(key, '==', val);
    }
  });

  return query;
}

// Build a Firestore Filter object (used for $or)
function buildFirestoreFilter(clause) {
  var filters = Object.keys(clause).map(function(key) {
    var val = clause[key];
    if (val === null || typeof val !== 'object' || val instanceof Date) {
      return Firestore.Filter.where(key, '==', val);
    }
    if ('$ne' in val)  return Firestore.Filter.where(key, '!=', val.$ne);
    if ('$in' in val)  return Firestore.Filter.where(key, 'in', val.$in);
    if ('$gt' in val)  return Firestore.Filter.where(key, '>', val.$gt);
    if ('$gte' in val) return Firestore.Filter.where(key, '>=', val.$gte);
    if ('$lt' in val)  return Firestore.Filter.where(key, '<', val.$lt);
    if ('$lte' in val) return Firestore.Filter.where(key, '<=', val.$lte);
    return Firestore.Filter.where(key, '==', val);
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

function FirestoreDocument(data, collectionRef, modelSchema) {
  var self = this;
  var _data = Object.assign({}, data);
  var _original = Object.assign({}, data);
  var _modified = {};
  var _isNew = !data._id;

  self._id = _data._id || getDb().collection('_').doc().id;
  self.id = self._id.toString();
  self._collectionRef = collectionRef;

  // Copy data fields to the document (so code can access doc.email, doc.name, etc.)
  Object.keys(_data).forEach(function(k) {
    if (k !== '_id') self[k] = _data[k];
  });

  self.isNew = _isNew;

  self.isModified = function(field) {
    if (!field) return Object.keys(_modified).length > 0;
    return field in _modified;
  };

  self.set = function(field, value) {
    self[field] = value;
    _data[field] = value;
    _modified[field] = true;
  };

  self.get = function(field) {
    return _data[field];
  };

  // Names that are always on the instance but are not data fields
  var _SKIP = { id: 1, isNew: 1, __v: 1,
                isModified: 1, set: 1, get: 1, toObject: 1, toJSON: 1,
                save: 1, remove: 1, markModified: 1 };

  // Scan own enumerable properties so fields written by pre-save hooks
  // (e.g. `this.slug = '...'`) are included, not just the original _data keys.
  self.toObject = function() {
    var obj = {};
    Object.keys(self).forEach(function(k) {
      if (k.startsWith('_')) return;        // internal: _id, _collectionRef, …
      if (k in _SKIP) return;              // non-data instance properties
      if (typeof self[k] === 'function') return; // instance methods
      obj[k] = self[k];
    });
    // Also pull any _data fields not yet promoted to self (e.g. loaded from Firestore)
    Object.keys(_data).forEach(function(k) {
      if (k !== '_id' && !(k in obj)) obj[k] = _data[k];
    });
    obj._id = self._id;
    return obj;
  };

  self.toJSON = self.toObject;

  // Run pre-save hooks then write to Firestore
  self.save = function(cb) {
    return new Promise(function(resolve, reject) {
      var hooks = (modelSchema && modelSchema._pre_save_hooks) || [];
      var i = 0;

      function runNext(err) {
        if (err) return cb ? cb(err) : reject(err);
        if (i >= hooks.length) return persist();
        var hook = hooks[i++];
        try {
          hook.call(self, runNext);
        } catch (e) {
          runNext(e);
        }
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
            if (cb) cb(null, self);
            resolve(self);
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

  // Mongoose compat
  self.markModified = function(field) { _modified[field] = true; };
  self.__v = 0;
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
  var query = applyConstraints(self._collectionRef, self._filter);
  var promise = query.count().get().then(function(snap) {
    return snap.data().count;
  });
  if (cb) { promise.then(function(n) { cb(null, n); }).catch(cb); return; }
  return promise;
};

ChainableQuery.prototype._run = function() {
  var self = this;
  var query = applyConstraints(self._collectionRef, self._filter);
  if (self._sort) query = applySort(query, self._sort);
  if (self._skip) query = query.offset(self._skip);
  if (self._limit) query = query.limit(self._limit);

  return query.get().then(function(snap) {
    return snap.docs.map(function(doc) {
      return docToInstance(doc.data(), self._collectionRef, self._modelSchema);
    });
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

FirestoreModelClass.prototype.find = function(filter, fields) {
  return new ChainableQuery(this._col(), filter, this._modelSchema, fields);
};

FirestoreModelClass.prototype.findOne = function(filter, cb) {
  var self = this;
  var query = new ChainableQuery(self._col(), filter, self._modelSchema);
  query._limit = 1;
  var promise = query._run().then(function(docs) { return docs[0] || null; });
  if (cb) { promise.then(function(d) { cb(null, d); }).catch(cb); return; }
  return promise;
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

FirestoreModelClass.prototype.findByIdAndUpdate = function(id, update, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  var self = this;
  var ref = self._col().doc(id.toString());
  var patch = translateUpdate(update);

  var promise = (options && options.upsert)
    ? ref.set(patch, { merge: true }).then(function() { return ref.get(); })
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
  if (cb) { promise.then(function() { cb(null); }).catch(cb); return; }
  return promise;
};

FirestoreModelClass.prototype.count = function(filter, cb) {
  var query = applyConstraints(this._col(), filter || {});
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
  // Mongoose stores hooks in schema.s.hooks (newer) or schema._callbacksMap (older)
  // We tap _callbacksMap which works with Mongoose 6 + mongoose-schema-extend
  var preSave = [];

  try {
    var hooks = schema.s && schema.s.hooks;
    if (hooks && hooks._pres && hooks._pres.get('save')) {
      hooks._pres.get('save').forEach(function(h) {
        if (h.fn) preSave.push(h.fn);
      });
    }
  } catch (e) {
    // Ignore — hooks won't run but nothing will crash
  }

  return { preSave: preSave };
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
    _instance_methods: instanceMethods
  };

  var classInstance = new FirestoreModelClass(collectionName, modelSchema);
  return makeConstructor(collectionName, modelSchema, classInstance);
}

module.exports = { createModel: createModel };
