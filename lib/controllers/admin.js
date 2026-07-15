var config        = require('config'),
    _             = require('underscore'),
    mailer        = require('../util/mailer'),
    Store         = require('../util/store'),
    userUtil      = require('../util/user'),
    featuredStore = Store.featured(),
    errors        = require('@hapi/boom'),
    parse         = require('csv').parse;

module.exports = {
  index : function(request, reply) {
    var page     = request.params.adminPage
      , pageData = {}
      , subpage, promise, criteria;

    if (!request.params.adminPage) {
      return reply().redirect('/admin/users');
    }
    else if (request.query.logoutAs) {
      request.yar.clear('loginAs');
      return reply().redirect('/admin/users');
    }

    if (request.user.loggedInAs()) {
      page    = 'users';
      promise = Promise.resolve();
    }
    else if (request.params.adminPage === 'users' && request.query.q) {
      if (/^role:\w+/.test(request.query.q)) {
        criteria = request.query.q.split(':');
        promise  = roleSearch(criteria[1]);
        subpage  = 'userSearchResults'
      }
      else {
        promise = userSearch(request.query.q);
      }
    }
    else if (request.params.adminPage === 'users' && request.query.loginAs) {
      request.yar.set('loginAs', request.query.loginAs);
      return reply().redirect('/home');
    }
    else if (request.params.adminPage === 'lti-registrations') {
      var LtiPlatform = require('../models/ltiPlatform');
      var authority   = require('../util/ltiInstructorAuthority');
      promise = new Promise(function(resolve, reject) {
        LtiPlatform.find({ status: 'pending' }, function(err, platforms) {
          if (err) return reject(err);
          resolve(platforms || []);
        });
      }).then(function(platforms) {
        return Promise.all(platforms.map(function(p) {
          return Promise.resolve(authority.getInstructorRecord(p.initiatedByEmail))
            .catch(function() { return null; })
            .then(function(record) {
              return {
                id              : p.id,
                issuer          : p.issuer,
                clientId        : p.clientId,
                name            : p.name,
                productFamily   : p.productFamily,
                deploymentIds   : p.deploymentIds || [],
                initiatedByEmail: p.initiatedByEmail,
                created         : p.created,
                record          : record
              };
            });
        }));
      }).then(function(rows) {
        pageData.registrations = rows;
        return pageData;
      });
    }
    else if (request.params.adminPage === 'featured-courses') {
      promise = featuredStore.getList()
        .then(function(featuredList) {
          return Promise.all(_.map(featuredList, function(member) {
            return Course.findById(member.id)
              .then(function(course) {
                if (course) {
                  course.page = member.page;
                }
                return course;
              });
          }));
        })
        .then(function(courses) {
          // Filter out null courses (deleted)
          courses = _.compact(courses);
          pageData.courses = _.map(courses, function(course) {
            return {
                id        : course.id
              , name      : course.name
              , slug      : course.slug
              , ownerSlug : course.ownerSlug
              , page      : course.page || null
            };
          });
          return pageData;
        })
        .catch(function(err) {
          pageData.courses = [];
          return pageData;
        });
    }
    else {
      promise = Promise.resolve();
    }

    return promise.then(function(data) {
      return request.success({
        page    : page,
        subpage : subpage || page,
        q       : request.query.q || undefined,
        active  : request.query.active || 'profile',
        data    : data
      });
    });
  },
  ohnoes : function(request, reply) {
    var log = request.payload.log;

    request.success();

    if (!log || !log.length) return;

    var keys = "time,path,referrer,user,userAgent,sesh".split(",");
    var msg;
    for (var i = 0; i < log.length; i++) {
      for (var j = 0; j < keys.length; j++) {
        msg += "\n" + keys[j] + "\t\t" + log[i][keys[j]];
      }
      msg += "\n----------------------------------"
    }

    mailer.send(config.app.adminEmail, 'User Session Alert', {
      text : msg
    });
  },
  uploadForm : function(request, reply) {
    return request.success({});
  },
  uploadUsers : function(request, reply) {
    var userList = request.payload.userList.split(/\n/);
    var promises = [];

    // Email, Username, Name, Password
    parse(request.payload.userList, {
      columns: true,
      skip_empty_lines: true
    }, function(err, records) {
      if (err) return request.fail(err);

      records.forEach(function(userInfo) {
        var fullname = userInfo.Name || userInfo.Email;
        var username = userInfo.Username || userUtil.generate_username(userInfo.Email);
        var user = new User({
          email    : userInfo.Email,
          password : userInfo.Password,
          fullname : fullname,
          username : username,
          source   : 'upload'
        });

        promises.push(user.save());
      });

      Promise.allSettled(promises).then(function(results) {
        var success = 0;
        var errors  = 0;

        results.forEach(function(result) {
          if (result.status === 'fulfilled') {
            success++;
          }
          else {
            errors++;
          }
        });

        return request.success({
          page    : 'upload',
          subpage : 'upload',
          success : success,
          errors  : errors
        });
      });
    });
  },
  updateUser : function(request, reply) {
    User.findById(request.params.userId, function(err, user) {
      if (err) return request.fail(err);

      if (!user) return request.fail({ message : 'user not found' });

      if (request.payload.roles) {
        user.mergeRoles(request.payload.roles);
        user.save(function(err, user) {
          if (err) return request.fail(err);

          return request.success({
            success : true
          });
        });
      }
    });
  },
  grantRole : function(request, reply) {
    User.findById(request.params.userId, function(err, user) {
      if (err) return request.fail(err);

      if (!user) return request.fail({ message : 'user not found' });

      return user.grant(request.payload.role, "site")
        .then(function(user) {
          if (request.payload.role === "trinket-teacher") {
            // grant connect for 30ish days
            var thru = moment().startOf('day').add(1, 'months').add(1, 'days').toISOString();

            var promise = Promise.resolve(user);
            if (!user.hasRole("trinket-connect")) {
              promise = promise.then(function(user) {
                return user.grant("trinket-connect", "site", { thru : thru });
              });
            }
            if (!user.hasRole("trinket-connect-trial")) {
              promise = promise.then(function(user) {
                return user.grant("trinket-connect-trial", "site", { thru : thru });
              });
            }
            return promise;
          }
          return Promise.resolve(user);
        })
        .then(function(user) {
          return request.success({
            success : true,
            user    : JSON.parse(JSON.stringify(user))
          });
        })
        .catch(function(err) {
          return request.fail(err);
        });
    });
  },
  addFeaturedCourse : function(request, reply) {
    return User.findByLogin(request.payload.ownerSlug)
      .then(function(user) {
        if (user) {
          return Course.findByUserAndSlug(user.id, request.payload.slug);
        }
        else {
          throw Boom.notFound();
        }
      })
      .then(function(course) {
        if (course) {
          return featuredStore.addMember(course.id, request.payload.page)
            .then(function() { return course; });
        }
        else {
          throw Boom.notFound();
        }
      })
      .then(function(course) {
        return request.success({
            success : true
          , course  : {
                id        : course.id
              , slug      : course.slug
              , name      : course.name
              , ownerSlug : course.ownerSlug
              , page      : request.payload.page
            }
        });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  removeFeaturedCourse : function(request, reply) {
    return featuredStore.removeMember(request.params.courseId, request.query.page)
      .then(function() {
        return request.success();
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  moveFeaturedCourse : function(request, reply) {
    return featuredStore.moveMember(request.payload.courseId, request.payload.page, request.payload.currentIndex, request.payload.newIndex)
      .then(function() {
        return request.success();
      })
      .catch(function(err) {
        return reply(err);
      });
  },

  // POST /admin/lti-registrations/activate — approve (activate) or reject (delete) a pending
  // platform. Thin wrapper over ltiRegistration.activatePlatform (the DRY anchor).
  activateLtiRegistration : function(request, reply) {
    var b               = request.payload || {};
    var ltiRegistration = require('../util/ltiRegistration');

    if (b.action === 'reject') {
      var LtiPlatform = require('../models/ltiPlatform');
      return new Promise(function(resolve, reject) {
        LtiPlatform.findByIssuer(b.issuer, b.clientId, function(err, platform) {
          if (err) return reject(err);
          if (!platform) return resolve(request.success({ ok: true }));
          platform.remove(function(rmErr) {
            if (rmErr) return reject(rmErr);
            resolve(request.success({ ok: true }));
          });
        });
      }).catch(function(e) { return request.fail(e); });
    }

    return ltiRegistration.activatePlatform(b.issuer, b.clientId)
      .then(function() { return request.success({ ok: true, status: 'active' }); })
      .catch(function(e) { return request.fail(e); });
  }
};

function userSearch(q) {
  return new Promise(function(resolve, reject) {
    var data;

    User.findByLogin(q, function(err, user) {
      if (err) {
        return reject(err);
      }

      if (user) {
        data = JSON.parse(JSON.stringify(user));
        data.tags = [];

        Trinket.findForUser(user.id)
          .then(function(trinkets) {
            data.trinketsOwned = trinkets.length;
            return Course.findForUser(user.id);
          })
          .then(function(courses) {
            data.coursesOwned = courses.length;
            resolve(data);
          })
          .catch(function(err) {
            reject(err);
          });
      }
      else {
        resolve();
      }
    });
  });
}

function roleSearch(role, data) {
  return User.findByRole(role)
    .then(function(users) {
      users.map(function(user) {
        user.avatar = user.normalizeAvatar();
      });
      return users;
    });
}
