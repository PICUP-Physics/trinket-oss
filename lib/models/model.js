var mongoose   = require('mongoose'),
    util       = require('util'),
    timestamps = require('./plugins/timestamps'),
    backend    = require('../db/backend-factory'),
    ObjectId   = mongoose.Types.ObjectId,
    ID_REGEXP  = /^[0-9a-fA-F]{24}$/;

function createModel(modelName, config) {
  //schema, hooks, modelMethods, classMethods
  var schema        = config.schema instanceof mongoose.Schema ? config.schema : mongoose.Schema(config.schema, {strict:true}),
      hooks         = config.hooks,
      objectMethods = config.objectMethods,
      classMethods  = config.classMethods || {},
      publicSpec    = config.publicSpec,
      plugins       = config.plugins,
      index         = config.index,
      alternateIds  = config.alternateIds,
      defaultFields = config.fields,
      expose        = process.env.NODE_ENV === 'test' ? config : {},
      model,
      Model;

  if (plugins) {
    plugins.forEach(function(plugin) {
      if (typeof plugin === 'function') {
        schema.plugin(plugin);
      }
      else if (Array.isArray(plugin)) {
        schema.plugin(plugin[0], plugin[1]);
      }
      else {
        log.error('Unrecognized plugin format:', util.inspect(plugin));
        throw new Error('Unrecognized plugin format');
      }
    });
  }

  // every schema gets the created and lastUpdated fields
  // unless explicitly configured otherwise
  if (config.timestamps !== false) {
    schema.plugin(timestamps);
  }

  if (hooks) {
    for (var hookType in hooks) {
      for (var hookName in hooks[hookType]) {
        for (var hookMethod in hooks[hookType][hookName]) {
          schema[hookType](hookName, hooks[hookType][hookName][hookMethod]);
        }
      }
    }
  }

  if (objectMethods) {
    for (var methodName in objectMethods) {
      schema.methods[methodName] = objectMethods[methodName];
    }
  }

  if (publicSpec) {
    schema.methods['publicSpec'] = function() {
      return publicSpec;
    }

    schema.methods['serialize'] = function() {
      var serialized = {};
      for (var key in publicSpec) {
        if (Array.isArray(this[key])) {
          serialized[key] = [];
          for (var i = 0; i < this[key].length; i++) {
            if (typeof(this[key][i].serialize) === 'function') {
              serialized[key].push( this[key][i].serialize() );
            } else {
              serialized[key].push( this[key][i] );
            }
          }
        }
        else if (typeof(this[key]) === 'object' && this[key] !== null) {
          if (this[key].hasOwnProperty('serialize') && typeof(this[key].serialize) === 'function') {
            serialized[key] = this[key].serialize();
          }
          else {
            // clone object - handle cases where stringify returns undefined
            var stringified = JSON.stringify(this[key]);
            serialized[key] = stringified !== undefined ? JSON.parse(stringified) : null;
          }
        }
        else {
          serialized[key] = this[key];
        }
      }
      return serialized;
    }
  }

  if (index) {
    index.forEach(function(index) {
      schema.index(index[0], index[1]);
    });
  }

  model = backend.getBackend().createModel(modelName, schema);

  if (process.env.NODE_ENV === 'migration' || process.env.NODE_ENV === 'test') {
    expose.model = model;
  }

  if (!classMethods.findByIds) {
    classMethods.findByIds = function(ids, cb) {
      return defaultFields
        ? this.model.find({_id:{$in:ids}}, defaultFields, cb)
        : this.model.find({_id:{$in:ids}}, cb)
    }
  }

  if (!classMethods.findById) {
    classMethods.findById = function(id, cb) {
      var promise;

      if (alternateIds && alternateIds.length) {
        var query = {$or:[]};

        if (ID_REGEXP.test(id)) {
          query.$or.push({_id:new ObjectId(id)});
        } else {
          query.$or.push({_id:id});
        }

        for(var i = 0; i < alternateIds.length; i++) {
          var condition = {};
          condition[alternateIds[i]] = id;
          query.$or.push(condition);
        }

        if (query.$or.length === 1) {
          query = query.$or[0];
        }

        promise = defaultFields
          ? this.model.findOne(query, defaultFields)
          : this.model.findOne(query);
      } else {
        promise = defaultFields
          ? this.model.findById(id, defaultFields)
          : this.model.findById(id);
      }

      // Support both callback and promise patterns
      if (cb) {
        promise.then(function(doc) { cb(null, doc); }).catch(cb);
      }
      return promise;
    };
  }

  if (!classMethods.findByIdAndUpdate) {
    classMethods.findByIdAndUpdate = function(id, update, options, cb) {
      if (typeof options === 'function' && typeof cb === 'undefined') {
        cb = options;
        options = {};
      }
      if (!options.select && defaultFields) {
        options.select = defaultFields;
      }

      return this.model.findByIdAndUpdate(id, update, options, cb);
    };
  }

  if (classMethods.findForUser) {
    delete classMethods.findForUser
    classMethods.findForUser = function(userId, cb) {
      return this.model.find({ _owner : userId }, defaultFields, cb);
    }
  }

  if (classMethods) {
    for (var methodName in classMethods) {
      expose[methodName] = classMethods[methodName].bind({model:model});
    }
  }

  Model = function(doc) {
    return new model(doc);
  };

  for (var key in expose) {
    Model[key] = expose[key]
  }

  Model.schema = schema;

  Model.extend = function(name, obj) {
    obj.schema = schema.extend(obj.schema);
    return createModel(name, obj);
  };

  Model.getName = function() {
    return modelName;
  }

  Model.isInstance = function(obj) {
    return obj instanceof model;
  };

  return {
    publicModel  : Model,
    privateModel : model
  }
}

module.exports = {
  create : createModel
};
