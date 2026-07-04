var mongoose    = require('mongoose'),
    ObjectId    = mongoose.Types.ObjectId,
    model       = require('./model'),
    ownable     = require('./plugins/ownable'),
    slug        = require('./plugins/slug'),
    config      = require('config'),
    courseStore = require('../util/store').courses(),
    featuredStore = require('../util/store').featured(),
    _           = require('underscore'),
    schema = {
      name           : { type: String, required: true },
      description    : { type: String },
      ownerSlug      : { type: String, required: true },
      lessons        : [{
        type : mongoose.SchemaTypes.ObjectId,
        ref  : 'Lesson'
      }],
      users        : [{
        _id         : false,
        userId      : { type: mongoose.SchemaTypes.ObjectId, ref: 'User' },
        username    : { type: String },
        displayName : { type: String },
        avatar      : { type: String },
        email       : { type: String },
        hideFrom    : [{ type: String }], // dashboard, all
        roles       : [{ type: String }],
        deleted     : { type: Boolean }
      }],
      globalSettings : {
        courseType : { type: String, enum: ['private', 'public', 'open', 'demo'], default: 'public' },
        contentDefault : { type: String, enum: ['publish', 'draft'], default: 'publish' },
        copyable : { type: Boolean, default: 'false' }
      },
      accessCode  : { type: String, index: true },
      externalLink : {
        source : { type: String },
        sourceId : { type: String, index: true }
      },
      archived: { type: Boolean, default: false }
    };

var MaterialParser = require('../util/material-parser.js');

function addUser(user, roles) {
  var context  = "course:" + this.id
    , self     = this
    , updateOptions = { new : true }
    , userRoles, courseUser, query, update;

  if (typeof roles === 'undefined' || roles.length === 0) {
    roles = ["course-student"];
  }

  userRoles = user.getByContext(context);

  if (userRoles && userRoles.roles.length) {
    return Promise.resolve({
      alreadyListed : true
    });
  }

  courseUser = {
      userId      : user.id
    , username    : user.username
    , displayName : user.name
    , email       : user.email
    , avatar      : user.normalizeAvatar()
    , roles       : roles
  };

  update = {
    "$push" : {
      "users" : courseUser
    }
  };

  return Course.publicModel.findByIdAndUpdate(this.id, update, updateOptions)
    .then(function(course) {
      return user.grant(roles[0], "course", { id : self.id })
        .then(function() {
          return {
              success : true
            , user    : courseUser
          };
        });
    });
}

function removeUser(user) {
  var self     = this
    , update, updateOptions;

  update = {
    "$pull" : {
      "users" : {
        "userId" : user.id
      }
    }
  };
  updateOptions = { new : true };

  return Course.publicModel.findByIdAndUpdate(this.id, update, updateOptions)
    .then(function(course) {
      return user.revokeAll("course", { id : self.id });
    });
}

function removeDeletedUser(userId) {
  var update, updateOptions;

  update = {
    "$pull" : {
      "users" : {
        "userId" : userId
      }
    }
  };
  updateOptions = { new : true };

  return Course.publicModel.findByIdAndUpdate(this.id, update, updateOptions);
}

function updateRole(user, role) {
  var self     = this
    , query, update, updateOptions;

  query = {
      _id   : this.id
    , users : {
        "$elemMatch" : {
          userId : user.id
        }
      }
  };

  update = {
    "$set" : {
      "users.$.roles" : [role]
    }
  };

  updateOptions = { new : true };

  return Course.privateModel.updateOne(query, update, updateOptions).exec()
    .then(function() {
      return user.revokeAll("course", { id : self.id });
    })
    .then(function() {
      return user.grant(role, "course", { id : self.id });
    });
}

function updateView(userId, view, action) {
  var self     = this
    , update   = {}
    , query, updateKey, updateOptions;

  query = {
      _id   : this.id
    , users : {
        "$elemMatch" : {
          userId : userId
        }
      }
  };

  updateKey = action === "hide" ? "$push" : "$pull";

  update[updateKey] = {
    "users.$.hideFrom" : view
  };

  updateOptions = { new : true };

  return Course.privateModel.updateOne(query, update, updateOptions).exec();
}

function deleteCourse() {
  var self = this
    , promises;

  // revoke roles for all users
  if (this.users.length) {
    promises = this.users.map(function(user) {
      return User.findById(user.userId)
        .then(function(user) {
          if (user) {
            return user.revokeAll("course", { id : self.id });
          }
          else {
            return Promise.resolve();
          }
        });
    });
  }
  else {
    promises = [Promise.resolve()];
  }

  return Promise.all(promises)
    .then(function() {
      return self.deleteOne();
    });
}

function userUpdate(user) {
  var promises
    , updateOptions = { new : true }
    , context, query, update;

  promises = user.roles.map(function(role) {
    if (/^course:/.test(role.context)) {
      context = role.context.split(':');
      query = {
        _id : new ObjectId(context[1]),
        users : {
          "$elemMatch" : {
            userId : user.id
          }
        }
      };
      update = {
        "$set" : {
          "users.$.username"    : user.username,
          "users.$.displayName" : user.name,
          "users.$.avatar"      : user.normalizeAvatar()
        }
      };

      if (role.roles.indexOf("course-owner") >= 0) {
        update.$set.ownerSlug = user.username;
      }

      return Course.privateModel.updateOne(query, update, updateOptions).exec();
    }
    else {
      return Promise.resolve();
    }
  });

  return Promise.all(promises);
}

function userDeleted(user) {
  var promises
    , updateOptions = { new : true }
    , context, query, update;

  promises = user.roles.map(function(role) {
    if (/^course:/.test(role.context)) {
      context = role.context.split(':');
      query = {
        _id : new ObjectId(context[1]),
        users : {
          "$elemMatch" : {
            userId : user.id
          }
        }
      };
      update = {
        "$set" : {
          "users.$.deleted" : true
        }
      };

      return Course.privateModel.updateOne(query, update, updateOptions).exec();
    }
    else {
      return Promise.resolve();
    }
  });

  return Promise.all(promises);
}

function findByUserAndSlug(userId, courseSlug, cb) {
  return this.model.findOne({ _owner: userId, slug: courseSlug }, cb);
}

function findByAccessCode(code, cb) {
  return this.model.findOne({ accessCode: code }, cb);
}

function findByExternalId(id, cb) {
  return this.model.findOne({ "externalLink.sourceId": id }, cb);
}

function preserveSlug() {
  this._original_slug = this.slug;
}

function ensureSlugAlias() {
  if (this._original_slug === this.slug) return;

  courseStore.linkIdToSlug(this._original_slug, this.id);
}

function copy(user, cb) {
  var course = new Course.publicModel({
    name           : this.name,
    description    : this.description,
    lessons        : [],
    _owner         : user,
    ownerSlug      : user.username,
    globalSettings : this.globalSettings
  }, this);

  var self = this;

  // try to save course before making copies of everything else
  // to catch any course errors (e.g. course with the same name)
  course.save(function(err, doc) {
    if (err) {
      console.log(err);
      return cb(err);
    }

    var lessonPromises = self.lessons.map(function(lessonId) {
      return Lesson.findById(lessonId);
    });

    var materialParser = new MaterialParser('a');

    function copyLesson(lesson) {
      return new Promise(function(resolve, reject) {
        lesson.copy(user, materialParser, function(err, copy) {
          if (err) return reject(err);
          return resolve(copy.id);
        });
      });
    }

    Promise.all(lessonPromises)
      .then(function(lessons) {
        var copyPromises = lessons.map(function(lesson) {
          return copyLesson(lesson);
        });

        return Promise.all(copyPromises)
      })
      .then(function(ids) {
        course.lessons = ids.map(function(id) { return id });
        course.save(function(err, doc) {
          err && console.log(err);
          return cb(err, doc);
        });
      });
  });
}

function setGlobalSettings(settings) {
  if (!this.globalSettings) {
    this.globalSettings = {};
  }

  for (var setting in schema.globalSettings) {
    if (schema.globalSettings.hasOwnProperty(setting)) {
      this.globalSettings[setting] = typeof(settings[setting]) === 'undefined'
        ? schema.globalSettings[setting].default
        : this.globalSettings[setting] = settings[setting];
    }
  }
}

/**
 * helper method so we don't have to check for both 'dashboard' and 'all'
 * in the course.users.$.hideFrom array every time
 *
 * user is an object from course.users
 */
function userHiddenFromDashboard(user) {
  var hideFrom = user.hideFrom || [];
  return hideFrom.indexOf('dashboard') >= 0 || hideFrom.indexOf('all') >= 0;
}

function findFeaturedForUser(user) {
  var promises, page;

  return featuredStore.getList()
    .then(function(list) {
      if (!list || !list.length) {
        return [];
      }
      promises = _.map(list, function(featuredCourse) {
        return Course.publicModel.findById(featuredCourse.id)
          .then(function(course) {
            if (course) {
              course.page = featuredCourse.page || "";
            }
            return course;
          });
      });

      return Promise.all(promises);
    })
    .then(function(courses) {
      // Filter out any null courses (deleted courses)
      return _.compact(courses);
    })
    .catch(function(err) {
      return [];
    });
}

var Course = model.create('Course', {
  schema: schema,
  plugins: [
    [ownable, { index: false }],
    [slug, { path: 'name', index: false }]
  ],
  classMethods: {
      findByUserAndSlug : findByUserAndSlug
    , findFeaturedForUser : findFeaturedForUser
    , findForUser       : true
    , userUpdate        : userUpdate
    , findByAccessCode  : findByAccessCode
    , findByExternalId  : findByExternalId
    , userDeleted       : userDeleted
  },
  objectMethods: {
      copy              : copy
    , setGlobalSettings : setGlobalSettings
    , addUser           : addUser
    , removeUser        : removeUser
    , removeDeletedUser : removeDeletedUser
    , updateRole        : updateRole
    , updateView        : updateView
    , deleteCourse      : deleteCourse
    , userHiddenFromDashboard : userHiddenFromDashboard
  },
  index: [
    [{ _owner: 1, slug: 1 }, { unique: true }]
  ],
  publicSpec: {
    id             : true,
    name           : true,
    slug           : true,
    description    : true,
    lessons        : true,
    _owner         : true,
    globalSettings : true,
    ownerSlug      : true,
    archived       : true
  },
  hooks : {
    post : {
      init : {
        preserveSlug : preserveSlug
      },
      save : {
        ensureSlugAlias : ensureSlugAlias
      }
    }
  }
});

module.exports = Course.publicModel;
