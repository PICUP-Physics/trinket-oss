var _                 = require('underscore'),
    Boom              = require('@hapi/boom'),
    config            = require('config'),
    Hapi              = require('@hapi/hapi'),
    Store             = require('./store'),
    features          = require('./features'),
    trinketStore      = Store.trinkets(),
    courseStore       = Store.courses(),
    userStore         = Store.users(),
    fs                = require('fs'),
    jwt               = require('jsonwebtoken'),
    defaultNextResult = true, // use this if your helper doesn't return a value
    internals         = {};

internals.defaultNextResult = defaultNextResult;

internals.isAdmin = function(user, next) {
  // Hapi 20+ style: return directly or throw
  if (typeof next === 'function') {
    // Legacy callback style
    next(user.hasRole("admin") ? defaultNextResult : Boom.forbidden());
  } else {
    // Modern style: return value or throw Boom error
    if (user && user.hasRole && user.hasRole("admin")) {
      return defaultNextResult;
    }
    throw Boom.forbidden();
  }
}

// Pre-handler gating an action behind an authenticated account, used by the fork
// route when features.requireAuthToFork is true. Anonymous requests get a clean 401
// that the embed fork() .fail() handler turns into a "Log in to save…" bar.
// With auth.requireApprovedAccount (default false) any logged-in user passes; a
// deploy that enables it also requires the account be approved (or a site admin) —
// the approval-tier profile used by instructor-run deployments.
internals.isApproved = function(user) {
  if (!user) throw Boom.unauthorized();
  if (!(config.auth && config.auth.requireApprovedAccount)) return defaultNextResult;
  if (user.hasRole && user.hasRole("admin")) return defaultNextResult;
  if (user.approved) return defaultNextResult;
  throw Boom.forbidden('Your account is not approved for editing. Contact your instructor.');
}

// Boolean form of the course-creation check, safe to use from templates and
// controllers without throwing. With auth.restrictCourseCreation (default false) any
// authenticated user may create/copy courses (stock behavior). A deploy that enables
// it restricts course create/copy to site admins and approved instructors
// (user.isInstructor); students, including those with elevated per-course roles, cannot.
internals.userCanCreateCourse = function(user) {
  if (!user) return false;
  if (!(config.auth && config.auth.restrictCourseCreation)) return true;
  if (user.hasRole && user.hasRole("admin")) return true;
  if (user.isInstructor) return true;
  return false;
}

// Pre-handler wrapper around userCanCreateCourse that throws on rejection.
internals.canCreateCourse = function(user) {
  if (!user) throw Boom.unauthorized();
  if (internals.userCanCreateCourse(user)) return defaultNextResult;
  throw Boom.forbidden('Only approved instructors can create or copy courses.');
}

// Gate the "Connect your LMS" page through the instructorAuthority SEAM (not instructorAuth
// directly), so each deploy profile's gate applies. Pass ONLY { email } (no lmsTeacher) so a bare
// trust-platform deploy resolves false and fails closed. Async — returns a Promise.
internals.canInitiateLtiRegistration = function(user) {
  if (!user) throw Boom.unauthorized();
  var ltiInstructorAuthority = require('./ltiInstructorAuthority');
  return Promise.resolve(ltiInstructorAuthority.resolveInstructor({ email: (user.email || '').toLowerCase() }))
    .then(function(ok) {
      if (ok) return defaultNextResult;
      throw Boom.forbidden('Only approved instructors can connect an LMS.');
    });
};

internals.findById = function(model, fallback) {
  return function(id, optional, next) {
    // Handle different argument patterns
    if (typeof optional === 'function') {
      next = optional;
      optional = false;
    } else if (arguments.length === 2 && typeof optional !== 'boolean') {
      if (typeof optional === 'object' && optional !== null) {
        // optional is a fallback document (e.g. parent(payload.parent, pre.lesson))
        // return it directly when id is falsy
        if (!id) return optional;
        optional = false;
      } else {
        next = optional;
        optional = false;
      }
    }

    if (!id) {
      var err = optional ? optional : Boom.badRequest();
      return next ? next(err) : Promise.reject(err);
    }

    return model.findById(id)
      .then(function(doc) {
        // Treat soft-deleted documents as not found
        var result = (doc && !doc.deletedAt) ? doc : Boom.notFound();
        return next ? next(result) : result;
      })
      .catch(function(err) {
        if (next) return next(err);
        throw err;
      });
  };
}

internals.userByLogin = function(userSlug, next) {
  return User.findByLogin(userSlug, function(err, doc) {
    if (err) return next(err);
    return next(doc ? doc : Boom.notFound());
  });
},

// TODO: refactor to check roles

internals.canEdit = function(resource, user, next) {
  var result;

  if (!resource) {
    result = Boom.badRequest();
  } else if (!user) {
    result = Boom.forbidden();
  } else {
    var ownerId = resource.populated('_owner') || "";
    if (!ownerId && resource._owner) {
      ownerId = resource._owner.toString();
    }
    result = ownerId === user.id ? defaultNextResult : Boom.forbidden();
  }

  // Support both callback and direct return patterns
  if (next) {
    return next(result);
  }
  return result;
}

internals.contains = function(listProperty) {
  return function(haystack, needle, next) {
    if (!haystack || !needle) {
      if (next) return next(Boom.badRequest());
      throw Boom.badRequest();
    }

    if (!haystack[listProperty] || !haystack[listProperty].indexOf || typeof(haystack[listProperty].indexOf) !== 'function') {
      if (next) return next(Boom.badRequest());
      throw Boom.badRequest();
    }

    var result = haystack[listProperty].indexOf(needle) >= 0 ? defaultNextResult : Boom.badRequest();
    if (next) return next(result);
    if (result instanceof Error) throw result;
    return result;
  };
}

internals.lowerUserFields = function(request, h) {
  ['email', 'username'].forEach(function(field) {
    if (request.payload && request.payload[field]) request.payload[field] = request.payload[field].trim().toLowerCase();
  });
  return null;
}

internals.populate = function(source, fields, next) {
  if (!(fields && fields.length)) {
    if (next) return next(defaultNextResult);
    return Promise.resolve(defaultNextResult);
  }

  if (!Array.isArray(fields)) {
    fields = fields.split(',');
  }

  var promises = _.map(fields, function(field) {
    return source.populate(field);
  });

  return Promise.all(promises)
    .then(function() {
      if (next) return next(source);
      return source;
    })
    .catch(function(err) {
      if (next) return next(err);
      throw err;
    });
}

module.exports.findTrinket = {
  assign : 'trinket',
  method : function(request, reply) {
    var trinketId = request.params.trinketId || request.params.shortCode;

    // check for extension
    var hasExtension = trinketId.match(/\.(\w+)/);
    if (hasExtension) {
      trinketId = trinketId.substr(0, hasExtension.index);

      // for downstream handlers
      request.params.trinketId = request.params.shortCode = trinketId;
      request.pre.extension = hasExtension[1];
    }

    return Trinket.findById(trinketId)
      .then(function(doc) {
        if (doc) {
          // Soft-deleted trinkets are treated as not found
          if (doc.deletedAt) {
            return reply(Boom.notFound());
          }

          var requestLang = request.params.lang;
          if (!requestLang) {
            var pathSegments = request.path.split('/');

            // i.e. /{lang}/{shortCode}
            if (Trinket.schema.path('lang').enumValues.indexOf( pathSegments[1] ) >= 0) {
              requestLang = pathSegments[1];
            }
          }

          if (!requestLang || requestLang === doc.lang) {
            return reply(doc);
          }
          else {
            // redirect to correct lang
            var location = config.url + '/' + doc.lang + '/' + trinketId;
            return reply().redirect(location).permanent().takeover();
          }
        }
        else {
          return reply(Boom.notFound());
        }
      })
      .catch(function(err) {
        return reply(err);
      });
  }
};

module.exports.validLang = {
  assign : 'validLang',
  method : function(request, reply) {
    // strip leading and trailing slashes
    var urlLang = request.url.pathname.replace(/^\//, '').replace(/\/$/, '')
      , lang    = request.params.lang || request.query.lang || (request.payload && request.payload.lang) || urlLang;

    var isValid = Trinket.schema.path('lang').enumValues.indexOf(lang) >= 0;
    return isValid ? reply(lang) : reply(Boom.notFound());
  }
}

/**
 * Check if a trinket type (language) is enabled via feature flags
 * Returns 404 if the trinket type is disabled
 */
module.exports.trinketTypeEnabled = {
  assign : 'trinketTypeEnabled',
  method : function(request, reply) {
    // Get lang from various sources
    var urlLang = request.url.pathname.replace(/^\//, '').split('/')[0]
      , lang    = request.params.lang || request.query.lang;

    // Only use urlLang if it's actually a known trinket type
    // (avoids treating paths like /library as a lang)
    if (!lang && features.isKnownTrinketType(urlLang)) {
      lang = urlLang;
    }

    if (!lang) {
      // No lang specified, allow through
      return reply(true);
    }

    if (features.isTrinketTypeEnabled(lang)) {
      return reply(true);
    }

    // Trinket type is disabled
    return reply(Boom.notFound('This trinket type is not available'));
  }
}

/**
 * Pre-handler to check if courses feature is enabled.
 * Returns 404 if courses are disabled.
 */
module.exports.coursesEnabled = {
  assign : 'coursesEnabled',
  method : function(request, reply) {
    if (features.isCoursesEnabled()) {
      return reply(true);
    }
    return reply(Boom.notFound('Courses are not available'));
  }
}

module.exports.verifyEmailToken = function(request, reply) {
  var secret = config.app.mail.secret + request.pre.trinket.shortCode
    , sessionKey = 'emailToken:' + request.pre.trinket.shortCode
    , data, token;

  token = request.payload.token
    ? request.payload.token
    : request.yar && request.yar.get(sessionKey)
      ? request.yar.get(sessionKey)
      : null;

  if (token) {
    data = jwt.verify(token, secret);

    if (data.shortCode === request.pre.trinket.shortCode) {
      return reply(data);
    } else {
      return reply(Boom.forbidden());
    }
  }
  else {
    return reply(Boom.badRequest());
  }
}


module.exports.register = function(server) {
  server.method('isAdmin',                       internals.isAdmin);
  server.method('isApproved',                    internals.isApproved);
  server.method('canCreateCourse',               internals.canCreateCourse);
  server.method('canInitiateLtiRegistration',    internals.canInitiateLtiRegistration);
  server.method('user',                 internals.findById(User));
  server.method('course',               internals.findById(Course));
  server.method('folder',               internals.findById(Folder));
  server.method('invitation',           internals.findById(CourseInvitation));
  server.method('canEdit',              internals.canEdit);
  server.method('file',                 internals.findById(File));
  server.method('lesson',               internals.findById(Lesson));
  server.method('parent',               internals.findById(Lesson));
  server.method('material',             internals.findById(Material));
  server.method('trinket',              internals.findById(Trinket));
  server.method('hasLesson',            internals.contains('lessons'));
  server.method('hasMaterial',          internals.contains('materials'));
  server.method('populate',             internals.populate);
  server.method('namedTrinketList', internals.namedTrinketList);
}

module.exports.lowerUserFields = internals.lowerUserFields;
module.exports.userCanCreateCourse = internals.userCanCreateCourse;

module.exports.toLowerCaseURI = function(request, reply) {
  // requests for static files and api calls should pass through unchanged
  var privacy = (request.route.cache && request.route.cache.privacy) || 'default';
  var static  = privacy === 'public' ? true : false;

  var url     = request.url.pathname;
  var api     = /^\/api\//.test(url) ? true : false;

  var host    = request.headers.host || '';
  var lcHost  = host.toLowerCase();
  var lcUrl   = url.toLowerCase();

  var caseMatches = (url === lcUrl && host === lcHost) ? true : false;

  if (api || static || caseMatches) return reply();

  var hostname = lcHost;

  var location = config.app.url.protocol + '://' + hostname + lcUrl;

  return reply('').redirect(location).permanent();
}

module.exports.logUnauth = function(request, reply) {
  if (request.route.auth && request.route.auth.mode === 'required' && !request.auth.isAuthenticated) {
    log.debug("unauth", {
      route   : request.route,
      auth    : request.auth,
      session : request.yar,
      headers : request.headers,
      params  : request.params,
      query   : request.query,
      payload : request.payload
    });
  }

  return reply();
}

module.exports.getDefaultTrinket = function(request, reply) {
  if (!request.query.category) {
    return reply();
  }

  return trinketStore
    .random(request.params.lang, request.query.category)
    .then(reply)
    .catch(function(err) {
      // TODO: what should we do here?
      reply(err);
    });
}

module.exports.userByUsername = async function(request, reply) {
  var username = request.params.username.toLowerCase();

  try {
    // findById supports alternate IDs (username, email) per user model config
    var user = await User.findById(username);
    if (user) {
      return reply(user);
    }
    return reply(Boom.notFound());
  } catch (err) {
    console.error('userByUsername error:', err);
    return reply(err);
  }
}

module.exports.courseBySlug = async function(request, reply) {
  var slug = request.params.courseSlug,
      user = request.pre.user || request.user,
      aliasId;

  try {
    var doc = await Course.findByUserAndSlug(user._id, slug);
    if (doc) return reply(doc);

    var id = await courseStore.getIdBySlug(slug);
    if (!id) throw Boom.notFound();

    aliasId = id;
    var alias = await Course.findById(id);

    if (alias) {
      var url_regexp = new RegExp('\\b' + slug + '\\b', 'i');
      var location = request.path.replace(url_regexp, alias.slug);
      return reply().redirect(location).permanent().takeover();
    }
    else {
      // prune the dead link
      courseStore.unlinkIdFromSlug(slug, aliasId);
    }
    throw Boom.notFound();
  } catch (err) {
    return reply(err);
  }
}

module.exports.findFeaturedTrinkets = async function(request, h) {
  var path       = request.path;
  var lenOrIndex = path.indexOf('/', 1) >= 0 ? path.indexOf('/', 1) : path.length;
  var lang       = path.substring(path.indexOf('/') + 1, lenOrIndex);

  return await internals.namedTrinketList(lang, 'featured');
}

module.exports.trinketByOwnerAndSlug = function(request, reply) {
  var slug = request.params.trinketSlug.toLowerCase(),
      user = request.pre.user || request.user,
      aliasId;

  // NOTE: do not `return` the Mongoose query here. The Hapi-20 pre-handler
  // wrapper calls `.then()` on any returned thenable; combined with the
  // callback below that double-executes the query (Mongoose "Query was already
  // executed") and fails the request. Letting the callback drive `reply`
  // keeps it single-execution.
  Trinket.findByOwnerAndSlug(user._id, slug, function(err, doc) {
    if (err) return reply(err);
    if (doc) return reply(doc);

    return trinketStore.getIdBySlugAndUser(slug, user._id)
      .then(function(id) {
        if (!id) throw Boom.notFound();
        aliasId = id;
        return Trinket.findById(id);
      })
      .then(function(alias) {
        if (alias) {
          // Check if aliased trinket is soft-deleted
          if (alias.deletedAt) {
            throw Boom.notFound();
          }
          var url_regexp = new RegExp('\\b' + slug + '\\b', 'i');
          var location = request.path.replace(url_regexp, alias.slug);
          return reply().redirect(location).permanent().takeover();
        }
        else {
          // prune the dead link
          trinketStore.unlinkIdFromSlugAndUser(slug, user._id, aliasId);
        }
        throw Boom.notFound();
      })
      .catch(reply);
  });
}

// Guard for the published-site route: only allow viewing a trinket at its
// vanity URL if it has actually been published. Expects request.pre.trinket
// to be populated first (e.g. by trinketByOwnerAndSlug).
module.exports.requirePublished = function(request, reply) {
  var trinket = request.pre.trinket;
  if (trinket && trinket.published) {
    return reply(trinket);
  }
  return reply(Boom.notFound());
};

internals.namedTrinketList = async function(lang, category) {
  var trinkets = await trinketStore.byCategory(lang, category);

  if (!trinkets || !trinkets.length) {
    return [];
  }

  var sortedTrinkets = trinkets.slice();
  var trinketObjects = await Trinket.findByIds(trinkets);

  if (trinketObjects && trinketObjects.length) {
    for (var i = 0; i < trinketObjects.length; i++) {
      var sortedIndex = sortedTrinkets.indexOf(trinketObjects[i].id);
      sortedTrinkets[sortedIndex] = trinketObjects[i];
    }
  }

  return sortedTrinkets;
}

if (config.isTest) {
  // expose internals for testing
  module.exports.internals = internals;
}
