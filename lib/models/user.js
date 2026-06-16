var model            = require('./model'),
    mongoose         = require('mongoose'),
    bcrypt           = require('bcrypt'),
    _                = require('underscore'),
    roles            = require('./plugins/roles'),
    config           = require('config'),
    userStore        = require('../util/store').users(),
    SALT_WORK_FACTOR = 10,
    schema           = {
      name      : { type: String },
      fullname  : { type: String,  required: true },
      username  : { type: String,  required: true, unique: true },
      email     : { type: String,  required: true, unique: true },
      verified  : { type: Boolean, default: false },
      password  : { type: String },
      avatar    : { type: String },
      source    : { type: String,  default: 'trinket' },
      profiles  : {},
      settings       : {
        disableAceEditor : { type: Boolean, default: false },
        theme            : { type: String, default: "xcode"},
        lineWrapping     : { type: Boolean, default: false },
        pythonTab        : { type: Number, default: 2 }, // Includes python, python3, pygame, and glowscript
        javaTab          : { type: Number, default: 2 },
        rTab             : { type: Number, default: 2 },
        htmlTab          : { type: Number, default: 2 },
      }
    };

function ensureName(next) {
  var user = this;

  if (!user.name) {
    user.name = user.fullname;
  }

  // ensure these are always lowercase
  user.username = user.username.toLowerCase();
  user.email    = user.email.toLowerCase();

  // ensure there is always some avatar stored
  user.avatar   = this.normalizeAvatar();

  next();
}

// Bcrypt middleware
function encryptPassword(next) {
  var user = this;

  if(!user.isModified('password')) return next();

  bcrypt.genSalt(SALT_WORK_FACTOR, function(err, salt) {
    if(err) return next(err);

    bcrypt.hash(user.password, salt, function(err, hash) {
      if(err) return next(err);
      user.password = hash;
      next();
    });
  });
}

function checkPermissions(next) {
  // if no roles, likely a new user
  // give them default permissions
  if (this.roles.length == 0) {
    this.setRoles("user", "site").then(next);
  }
  else {
    next();
  }
}

function preserveUsername() {
  this._original_username = this.username;
}

function ensureUsernameAlias() {
  if (!this._original_username || this._original_username === this.username) return;

  userStore.linkIdToUsername(this._original_username, this.id);
}

function markAsDeleted(doc) {
  // Clean up user's association with courses when user is removed
  Course.userDeleted(doc);
}

// Password verification
function comparePassword(candidatePassword, cb) {
  return bcrypt.compare(candidatePassword, this.password, cb);
};

// user lookup by email or username
function findByLogin(login, cb){
  return this.model.findOne({
    $or: [
      { email    : login },
      { username : login.toLowerCase() }
    ]
  }, cb);
}

function findByMultiple(query, cb) {
  var or = [], c;
  for (var key in query) {
    c = {};
    c[key] = query[key];
    or.push(c);
  }
  return this.model.findOne({
    $or : or
  }, cb);
}

function exists(user, cb) {
  var or = [
    { email    : user.email    },
    { username : user.username.toLowerCase() }
  ];

  return this.model.find({ $or : or }, function(err, users) {
    if (err) return cb(err);
    if (!users || users.length == 0) return cb(null, {exists:false});
    var duplicates = {};
    users.forEach(function(existingUser) {
      if (existingUser.username === user.username) {
        duplicates.username = true;
      }
      if (existingUser.email === user.email) {
        duplicates.email = true;
      }
    });

    return cb(null, {exists:true, duplicates:duplicates, users:users});
  });
}

// find up to 100 users for admin page, includes pagination
function findAdminList(page, cb) {
  var limit = 100;
  var skip  = page * limit;
  this.model.find({}).skip(skip).limit(limit).sort('-created').exec(function(err, users) {
    cb(err, users);
  });
}

function findByRole(role, cb) {
  return this.model.find({ roles : { $elemMatch : { roles : { $in : [role] } } } }).sort({ username : 1 }).exec();
}

function getCourses(filter) {
  var self      = this
    , courseIds = []
    , promises  = []
    , context;

  if (this.roles) {
    this.roles.forEach(function(role) {
      if (/^course/.test(role.context) && self.hasPermission('view-course-content', role.context)) {
        // course:[id]
        context = role.context.split(':');

        if (filter && role.permissions.indexOf(filter) < 0) {
          return;
        }

        courseIds.push(context[1]);
      }
    });

    courseIds.forEach(function(id) {
      // Use promise directly instead of Q.nsend for Mongoose 6 compatibility
      promises.push(Course.findById(id));
    });
  }

  if (promises.length) {
    return Promise.all(promises)
      .then(function(courses) {
        return _.compact(courses).filter(function(c) {
          if (!c.archived || (c.archived && c._owner.toString() === self.id.toString())) {
            return true;
          }
          return false;
        });
      });
  }
  else {
    return Promise.resolve([]);
  }
}

function getOwnedCourses() {
  var self      = this
    , courseIds = []
    , promises  = []
    , context;

  if (this.roles) {
    this.roles.forEach(function(role) {
      if (/^course/.test(role.context) && self.hasRole('course-owner', role.context)) {
        // course:[id]
        context = role.context.split(':');
        courseIds.push(context[1]);
      }
    });

    courseIds.forEach(function(id) {
      promises.push(Course.findById(id));
    });
  }

  if (promises.length) {
    return Promise.all(promises);
  }
  else {
    return Promise.resolve([]);
  }
}

function inCourse(courseId) {
  var inCourse = false
    , self     = this;

  if (this.roles) {
    this.roles.forEach(function(role) {
      if (role.context === "course:" + courseId && self.hasPermission("view-course-content", "course", { id : courseId })) {
        inCourse = true;
      }
    });
  }

  return inCourse;
}

function normalizeAvatar() {
  var avatar = this.avatar;
  var cloudHost = config.aws.buckets.useravatars.host || '';
  var hasCloudConfig = cloudHost.length > 0 && !cloudHost.includes('example.com');

  // Treat placeholder URLs as no avatar. The default avatar is a static asset
  // shipped with the app, so serve it from /img rather than the object store
  // (where it was never uploaded and would 404).
  if (!avatar || avatar.includes('example.com')) {
    return '/img/avatar-default.svg';
  }

  // Already a valid local path - return as-is
  if (/^\/img\//.test(avatar)) {
    return avatar;
  }

  // Already a full URL (and not a placeholder)
  if (/^http/.test(avatar)) {
    return avatar;
  }

  // Relative path - prepend cloud host if configured, otherwise use local
  if (hasCloudConfig) {
    return cloudHost + (avatar.startsWith('/') ? '' : '/') + avatar;
  }

  // Local path
  return /^\//.test(avatar) ? avatar : '/img/' + avatar;
}

function updateSettings(settings) {
  var update, updateOptions;

  var newSettings = _.extend(this.settings, settings);

  update = {
    "$set" : {
      "settings": newSettings
    }
  };

  updateOptions = { new : true };

  return User.findByIdAndUpdate(this.id, update, updateOptions).exec();
}

module.exports = model.create('User', {
  schema  : schema,
  plugins : [ roles ],
  hooks  : {
    pre : {
      save : {
        ensureName       : ensureName,
        encryptPassword  : encryptPassword,
        checkPermissions : checkPermissions
      }
    },
    post : {
      init : {
        preserveUsername : preserveUsername
      },
      save : {
        ensureUsernameAlias : ensureUsernameAlias
      },
      remove : {
        markAsDeleted : markAsDeleted
      }
    }
  },
  objectMethods : {
    comparePassword : comparePassword,
    normalizeAvatar : normalizeAvatar,
    inCourse        : inCourse,
    getCourses      : getCourses,
    getOwnedCourses : getOwnedCourses,
    updateSettings   : updateSettings
  },
  classMethods : {
    findByLogin          : findByLogin,
    findByMultiple       : findByMultiple,
    findAdminList        : findAdminList,
    exists               : exists,
    findByRole           : findByRole
  },
  alternateIds : ['username', 'email'],
  publicSpec: {
    id:true, name:true, username:true, fullname:true, email:true, avatar:true, settings:true
  }
}).publicModel;
