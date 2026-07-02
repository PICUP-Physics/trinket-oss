var config       = require('config'),
    errors       = require('@hapi/boom'),
    Boom         = require('@hapi/boom'),
    Store        = require('../util/store'),
    emailStore   = Store.email(),
    mailer       = require('../util/mailer'),
    FileUtil     = require('../util/file'),
    nunjucks     = require('nunjucks'),
    url          = require('url'),
    mime         = require('mime'),
    _            = require('underscore'),
    path         = require('path'),
    fs           = require('fs'),
    _request     = require('request'),
    tmp          = require('tmp'),
    StringUtils  = require('../util/stringUtils'),
    Folder       = require('../models/folder'),
    exportsQueue = require('../util/queues').exports(),
    Export       = require('../models/export'),
    aws          = require('../../config/aws'),
    roles        = require('../util/roles'),
    constants    = require('../../config/constants'),
    uuid         = require('node-uuid'),
    crypto       = require('crypto'),
    userUtil     = require('../util/user'),
    recaptcha    = require('../util/recaptcha');

module.exports = {
  create : async function(request, reply) {
    var recaptcha_result = await new Promise(function(resolve) {
      recaptcha.verify(request.payload['g-recaptcha-response'], resolve);
    });

    if (!recaptcha_result.success) {
      return request.fail();
    }

    var payload  = request.payload,
        interest = request.payload.interest || 'python',
        redirect = request.yar.get('next') || payload.next,
        json     = { formName : payload.formName };

    var email = request.payload.email.split('@');
    if (!request.payload.fullname) {
      request.payload.fullname = email[0];
    }
    if (!request.payload.username) {
      request.payload.username = userUtil.generate_username_with_suffix(email[0]);
      json.formName = 'sign-up';
    }

    var user = new User(payload);

    try {
      // Check email blocklist
      var isBlocked = await emailStore.blockListLookup(email[1].toLowerCase());
      if (isBlocked) {
        console.log('blocking signup from:', request.payload.email);
        throw new Error("blocking signup from: " + request.payload.email);
      }

      // Check if user exists
      var existsResult = await new Promise(function(resolve, reject) {
        User.exists(user, function(err, result) {
          if (err) reject(err);
          else resolve(result);
        });
      });

      if (existsResult && existsResult.exists) {
        request.yar.flash('duplicates', existsResult.duplicates, true);
        return request.fail(json);
      }

      // Save user
      var savedUser = await user.save();

      request.yar.flash('requested', request.payload.username);

      // Log in the user
      await new Promise(function(resolve, reject) {
        request.yar._logIn(savedUser, function(err) {
          if (err) reject(err);
          else resolve();
        });
      });

      return redirect
        ? request.success({ redirectTo : redirect, status : 'success', data : savedUser })
        : request.success({ status : 'success', data : savedUser });

    } catch (err) {
      if (err.code === 11000) {
        request.yar.flash('duplicates', { username : true }, true);
        return request.fail(json);
      }
      return request.fail(json, err);
    }
  },

  login : async function(request, reply) {
    // Brute-force protection: limit only FAILED login attempts, keyed by client
    // IP and by target account over a rolling window. Successful logins are NOT
    // counted, so a whole class logging in legitimately — often behind one
    // campus NAT / proxy IP — never trips the limit; only repeated failures do
    // (see issue #3, where the old "count every attempt" design 429'd students
    // on their first try during an exam).
    var rl = (config.app && config.app.auth && config.app.auth.loginRateLimit) || {};
    var WINDOW      = rl.windowSeconds || 900; // 15 min
    var MAX_IP      = rl.maxPerIp      || 100; // failed attempts per IP (generous: shared NAT)
    var MAX_ACCOUNT = rl.maxPerAccount || 10;  // failed attempts per account (the real guard)

    // Prefer x-forwarded-for: behind Cloud Run / any proxy, remoteAddress is the
    // proxy IP shared across users, so keying on it collapses everyone into one
    // bucket. Matches how the rest of the app reads the client IP.
    var fwd = request.headers['x-forwarded-for'];
    var ip  = (fwd ? String(fwd).split(',')[0].trim() : '') || request.info.remoteAddress;

    var ipKey   = 'rate:login:fail:ip:'   + ip;
    var acctKey = 'rate:login:fail:acct:' + request.payload.email;

    // Read-only gate: reject if this IP or account has already exhausted its
    // failed-attempt budget. Does not increment — only the failure branches do.
    var ipFails   = parseInt(await Store.get(ipKey)   || '0', 10);
    var acctFails = parseInt(await Store.get(acctKey) || '0', 10);
    if (ipFails >= MAX_IP || acctFails >= MAX_ACCOUNT) {
      return reply(errors.tooManyRequests('Too many login attempts. Please try again later.'));
    }

    // Record one failed attempt against both buckets, setting a fresh TTL on the
    // first failure in the window. Call before returning any failure below.
    async function recordFailedLogin() {
      var i = parseInt(await Store.get(ipKey)   || '0', 10) + 1;
      var a = parseInt(await Store.get(acctKey) || '0', 10) + 1;
      await Store.set(ipKey,   String(i));
      await Store.set(acctKey, String(a));
      if (i === 1) await Store.expire(ipKey,   WINDOW);
      if (a === 1) await Store.expire(acctKey, WINDOW);
    }

    console.log('LOGIN: Starting login for', request.payload.email);
    var requested = request.payload.email;
    var password = request.payload.password;
    var redirect  = request.yar.get('next');
    var data;

    try {
      console.log('LOGIN: Finding user');
      // Find user by email or username
      var user = await new Promise(function(resolve, reject) {
        User.findByLogin(requested, function(err, user) {
          console.log('LOGIN: findByLogin callback', err, user ? user.email : 'no user');
          if (err) reject(err);
          else resolve(user);
        });
      });

      console.log('LOGIN: User found?', !!user);
      if (!user) {
        console.log('LOGIN: No user, failing');
        await recordFailedLogin();
        return request.fail({ message: 'Unknown user ' + requested });
      }

      if (user.hasRole && user.hasRole("disabled")) {
        await recordFailedLogin();
        return request.fail({ message: 'Account Disabled' });
      }

      if (!user.password || user.password.length === 0) {
        await recordFailedLogin();
        return request.fail({ message: 'A password was not found for this account.' });
      }

      console.log('LOGIN: Comparing password');
      // Verify password
      var isMatch = await new Promise(function(resolve, reject) {
        user.comparePassword(password, function(err, isMatch) {
          console.log('LOGIN: comparePassword callback', err, isMatch);
          if (err) reject(err);
          else resolve(isMatch);
        });
      });

      console.log('LOGIN: Password match?', isMatch);
      if (!isMatch) {
        await recordFailedLogin();
        return request.fail({ message: 'Invalid password' });
      }

      console.log('LOGIN: Success, resetting session');
      // Login successful - save data we want to preserve across session reset
      var educatorsFormData = request.yar.get("educatorsFormData") || null;
      var registrationPayload = request.yar.get("registration-payload") || null;

      // Generate a new session id for security (prevents session fixation)
      request.yar.reset();
      console.log('LOGIN: Session reset done');

      // Now set session data on the new session
      request.yar.set('loggedInWith', 'trinket');
      request.yar._logIn(user, function() {});
      console.log('LOGIN: User logged in');

      if (user.username !== requested && user.email !== requested) {
        request.yar.flash('requested', requested);
      } else {
        request.yar.flash('requested', user.username);
      }

      if (educatorsFormData) {
        request.yar.set("educatorsFormData", educatorsFormData);
      }
      if (registrationPayload) {
        request.yar.set("registration-payload", registrationPayload);
      }

      console.log('LOGIN: About to redirect, redirect=', redirect);

      if (redirect) {
        console.log('LOGIN: Redirecting to', redirect);
        return reply().redirect(redirect);
      } else {
        // e.g. from an api call - set in route config
        data = request.pre.encryptRoles
          ? {
              email    : user.email,
              fullname : user.fullname,
              id       : user.id,
              name     : user.name,
              username : user.username,
              roles    : roles.encrypt(user.roles)
            }
          : user;

        return request.success({
          status : 'success',
          data   : data
        });
      }
    } catch (err) {
      log.error('Login error:', err);
      return request.fail(err);
    }
  },
  remove : function(request, reply) {
    if (request.user && request.user.username === request.query.username) {
      return request.user.remove()
        .then(function() {
          return request.success();
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(Boom.forbidden());
    }
  },
  deleted : function(request, reply) {
    request.yar.flash('siteMessage', 'Your account has been deleted.');
    return reply().redirect('/');
  },
  logout : function(request, reply) {
    if (request.yar) {
      request.yar.clear('userId');
      request.yar.reset();
    }
    request.success();
  },

  sendPassReset : function(request, reply) {
    if (!mailer.isConfigured()) {
      return request.fail({
        message: "Email is not configured. Password reset is not available."
      });
    }

    recaptcha.verify(request.payload['g-recaptcha-response'], function(result) {
      if (result.success) {
        User.findByLogin(request.payload.email, function(err, user) {
          if (err)   return request.fail(err);
          if (!user) return request.fail({ message: 'user not found' });

          require('crypto').randomBytes(48, async function(ex, buf) {
            var key      = buf.toString('hex');
            var resetKey = Store.user.reset_password_key(key);
            var resetVal = user.id.toString();

            await Store.set(resetKey, resetVal);
            await Store.expire(resetKey, 86400);
            request.success();

            var reset_password_url = config.url + '/reset-pass?key=' + key;

            var message = nunjucks.render('emails/passwordReset', {
              fullname           : user.fullname,
              username           : user.username,
              reset_password_url : reset_password_url
            });
            mailer.send(user.email, 'Password reset', { html : message, type : 'password-reset' });
          });
        });
      }
      else {
        return request.success();
      }
    });
  },

  resetPasswordForm : async function(request, reply) {
    var resetKey = Store.user.reset_password_key(request.query.key);

    try {
      var user_id = await Store.get(resetKey);
      if (!user_id) return request.fail({ message: 'reset password key not found' });

      User.findById(user_id, function(err, user) {
        if (err)   return reply(err);
        if (!user) return request.fail({ message: 'user not found' });

        request.success({
          key : request.query.key
        });
      });
    } catch(err) {
      return reply(err);
    }
  },

  savePassword : async function(request, reply) {
    var ip = request.info.remoteAddress;
    var rateLimitKey = 'rate:save-pass:' + ip;
    var attempts = parseInt(await Store.get(rateLimitKey) || '0', 10) + 1;
    await Store.set(rateLimitKey, String(attempts));
    if (attempts === 1) await Store.expire(rateLimitKey, 900); // 15-minute window
    if (attempts > 10) return reply(require('@hapi/boom').tooManyRequests('Too many password reset attempts'));

    if (request.payload.password !== request.payload.password_verify)
      return reply().redirect('/reset-pass?key=' + request.payload.key);

    var resetKey = Store.user.reset_password_key(request.payload.key);

    try {
      var user_id = await Store.get(resetKey);

      User.findById(user_id, function(err, user) {
        if (err)   return reply(err);
        if (!user) return request.fail({ message: 'user not found' });

        user.password = request.payload.password;
        user.save(async function(err) {
          if (err) return reply(err);

          await Store.del(resetKey);
          request.success();
        });
      });
    } catch(err) {
      return reply(err);
    }
  },

  account : function(request, reply) {
    var data = {}
      , promise;

    if (!request.params.accountPage) {
      return reply().redirect('/account/profile');
    }

    if (request.params.accountPage === 'profile') {
      promise = new Promise(function(resolve, reject) {
        Course.findForUser(request.user.id, function(err, courses) {
          if (err) reject(err);
          else resolve(courses);
        });
      });
    }
    else if (request.params.accountPage === 'delete-account') {
      data.userCanDelete = true;
    }
    else if (request.params.accountPage === 'email') {
      // check if user has a pending email change
      var changeKey = Store.user.change_email_key(request.user.id.toString());
      promise = Store.get(changeKey);
    }

    if (!promise) {
      promise = Promise.resolve([]);
    }

    return promise.then(function(promiseResult) {
      // if array, number of courses
      if (Array.isArray(promiseResult)) {
        data.coursesOwned = promiseResult.length;
      }
      else {
        try {
          promiseResult = JSON.parse(promiseResult);
          if (promiseResult && promiseResult.new_email) {
            data.pendingEmailAddress = promiseResult.new_email;
          }
        } catch(e) {}
      }

      return request.success({
        page : request.params.accountPage,
        data : data
      });
    })
    .catch(function(err) {
      return request.success({
        page : request.params.accountPage,
        data : data
      });
    });
  },

  updateProfile : function(request, reply) {
    var user         = request.user,
        payload      = request.payload,
        updateSlugs         = false,
        updateCourses       = false,
        addFolderSlugJob, updateCoursesPromise, usernameCheck;

    if (user.id !== request.params.userId) {
      return reply(Boom.forbidden());
    }

    if (user.avatar !== request.payload.avatar || user.name !== request.payload.name) {
      updateCourses = true;
    }

    if (user.username !== payload.username.toLowerCase()) {
      usernameCheck = new Promise(function(resolve, reject) {
        User.exists(user, function(err, result) {
          if (err) reject(err);
          else resolve(result);
        });
      });

      updateSlugs = true;
      updateCourses = true;
    }
    else {
      usernameCheck = Promise.resolve(null);
    }

    user.set(request.payload);
    user.username = user.username.toLowerCase();

    return usernameCheck.then(function(result) {
      if (result && result.exists && result.duplicates.username) {
        return request.fail({
          message : "Sorry, that username is already taken. Please try another."
        });
      }
      else {
        user.save(function(err, user) {
          if (err) {
            if (err.code === 11000) {
              return request.fail({
                message : "Sorry, that username is already taken. Please try another."
              });
            }

            return request.fail({
              message : "Something went wrong when trying to update your profile. Please try again."
            });
          }

          if (updateSlugs) {
            // Update folder slugs inline
            addFolderSlugJob = Folder.findByOwner(user)
              .then(function(folders) {
                return Promise.all(folders.map(function(folder) {
                  return folder.updateOwnerSlug(user.username);
                }));
              })
              .catch(function(err) {
                console.error('Failed to update folder slugs:', err.message);
                // Don't fail the profile update if folder slugs fail
                return Promise.resolve();
              });
          }
          else {
            addFolderSlugJob = Promise.resolve();
          }

          if (updateCourses) {
            updateCoursesPromise = Course.userUpdate(user);
          }
          else {
            updateCoursesPromise = Promise.resolve();
          }

          return addFolderSlugJob
            .then(function() { return updateCoursesPromise; })
            .then(function() {
              return request.success({
                success : true,
                user    : user
              });
            });
        });
      }
    }).catch(function(err) {
      return request.fail({
        message : "Something went wrong when trying to update your profile. Please try again."
      });
    });
  },

  assetList : function(request, reply) {
    var sortBy = request.query.sortBy || 'name'
      , types  = request.query.type.toLowerCase().split(',') || []
      , getUserFiles;

    if (request.user) {
      getUserFiles = new Promise(function(resolve, reject) {
        File.findForUser(request.user._id, function(err, files) {
          if (err) reject(err);
          else resolve(files);
        });
      });
    }
    else {
      getUserFiles = Promise.resolve(undefined);
    }

    return getUserFiles
      .then(function(files) {
        if (typeof(files) === "undefined") {
          files = [];
        }

        if (request.query.type) {
          files = _.filter(files, function(file) {
            return _.some(types, function(type) {
              if (file.mime.indexOf(type) === 0) {
                return true;
              }

              var revtype = type.split("").reverse().join("");
              var revname = file.name.toLowerCase().split("").reverse().join("");
              if (revname.indexOf(revtype) === 0) {
                return true;
              }

              return false;
            });
          });
        }
        files = _.sortBy(files, sortBy);
        return request.success({
          files : files
        });
      })
      .catch(function(err) {
        return reply(err);
      });
  },

  assetUpload : function(request, reply) {
    if (!config.features.assets) {
      return reply(errors.notImplemented('Asset uploads are not enabled'));
    }
    FileUtil.uploadUserAsset(request.payload.file, request.user, function(err, file) {
      if (err) return request.fail(err);
      return request.success({ file : file });
    });
  },

  replaceAsset : function(request, reply) {
    if (!config.features.assets) {
      return reply(errors.notImplemented('Asset uploads are not enabled'));
    }
    var origfile = request.pre.file;

    if (request.user.id.toString() === origfile._owner.toString()) {
      return new Promise(function(resolve, reject) {
        FileUtil.uploadUserAsset(request.payload.file, request.user, origfile, function(err, file) {
          if (err) reject(err);
          else resolve(file);
        });
      })
        .then(function(file) {
          return request.success({ file : file });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(Boom.forbidden());
    }
  },

  removeAsset : function(request, reply) {
    var file = request.pre.file;

    if (request.user.id.toString() === file._owner.toString()) {
      file.hide()
        .then(function() {
          return request.success();
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(Boom.forbidden());
    }
  },

  restoreAsset : function(request, reply) {
    var file = request.pre.file;

    if (request.user.id.toString() === file._owner.toString()) {
      file.show()
        .then(function() {
          return request.success();
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(Boom.forbidden());
    }
  },

  assetUploadFromURL : function(request, reply) {
    if (!config.features.assets) {
      return reply(errors.notImplemented('Asset uploads are not enabled'));
    }

    var requestUrl = url.parse(request.payload.url);

    // Block non-HTTP schemes and private/internal hosts to prevent SSRF.
    if (!requestUrl.protocol || !/^https?:$/.test(requestUrl.protocol)) {
      return request.fail();
    }

    var dns = require('dns');
    var net = require('net');

    function isPrivateIP(ip) {
      // Reject loopback, link-local (AWS metadata), and RFC-1918 private ranges.
      if (!net.isIP(ip)) return true;
      var parts = ip.split('.').map(Number);
      return (
        ip === '::1' ||
        parts[0] === 127 ||
        parts[0] === 10 ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 169 && parts[1] === 254)
      );
    }

    var hostname = requestUrl.hostname;
    dns.lookup(hostname, function(err, address) {
      if (err || isPrivateIP(address)) return request.fail();

      tmp.tmpName(function(err, tmpPath) {
        var contentType = '';

        _request
          .get(request.payload.url)
          .on('error', function(err) {
            console.log('on error:', err);
          })
          .on('response', function(response) {
            contentType = response.headers['content-type'];
          })
          .on('end', function() {
            var fileupload = {
              path     : tmpPath,
              filename : path.basename(requestUrl.path),
              headers  : {
                'content-type' : contentType
              }
            };

            FileUtil.uploadUserAsset(fileupload, request.user, function(err, file) {
              if (err) return request.fail(err);
              return request.success({ file : file });
            });
          })
          .pipe(fs.createWriteStream(tmpPath));
      });
    });
  },
  changePassword : function(request, reply) {
    if (request.payload.newPassword === request.payload.confirmPassword) {
      request.user.comparePassword(request.payload.currentPassword, function(err, match) {
        if (err) {
          return request.fail({
            message : "Something went wrong when trying to change your password. Please try again."
          });
        }

        if (match) {
          request.user.password = request.payload.newPassword;
          request.user.save(function(err, user) {
            if (err) {
              return request.fail({
                message : "Something went wrong when trying to change your password. Please try again."
              });
            }

            return request.success({
              success : true
            });
          });
        }
        else {
          return request.fail({
            message : "The password you entered did not match what we have stored. Please try again."
          });
        }
      });
    }
    else {
      return request.fail({
        message : "Your new password entries did not match. Please try again."
      });
    }
  },

  getAvatar : function(request, reply) {
    var avatar;

    if (request.pre.user) {
      avatar = request.pre.user.normalizeAvatar();

      return request.success({
        src : avatar
      });
    }
    else {
      return reply(Boom.notFound());
    }
  },
  getInfo : function(request, reply) {
    if (request.pre.user) {
      return request.success({
          username    : request.pre.user.username
        , avatar      : request.pre.user.normalizeAvatar()
        , email       : request.pre.user.email
        , displayName : request.pre.user.name
      });
    }
    else {
      return reply(Boom.notFound());
    }
  },
  updateSettings : function(request, reply) {
    return request.user.updateSettings(request.payload)
      .then(function(result) {
        return request.success({
          success : true
        });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  sendEmailChange : function(request, reply) {
    if (!mailer.isConfigured()) {
      return request.fail({
        message: "Email is not configured. Email changes are not available."
      });
    }

    User.findByLogin(request.payload.email, function(err, user) {
      // if user found, send back error message
      if (user) {
        return request.fail({ message: 'Another account with that email address already exists.' });
      }

      // create random key and store new email with it
      require('crypto').randomBytes(48, function(ex, buf) {
        var email_key = buf.toString('hex').substring(0, 8); // send in email
        var user_key  = request.user.id.toString();

        var changeKey = Store.user.change_email_key(user_key);
        var changeVal = {
            key       : email_key
          , new_email : request.payload.email
        };

        Store.set(changeKey, JSON.stringify(changeVal), function(err) {
          send_email_confirmation(request, changeVal.new_email, changeVal.key);

          request.success({
            success : true
          });
        });
      });
    });
  },
  resendEmailChange : async function(request, reply) {
    if (!mailer.isConfigured()) {
      return request.fail({
        message: "Email is not configured. Email changes are not available."
      });
    }

    var user_key  = request.user.id.toString()
      , changeKey = Store.user.change_email_key(user_key);

    try {
      var changeVal = await Store.get(changeKey);
      if (!changeVal) return request.fail({ message: 'change email key not found' });

      changeVal = JSON.parse(changeVal);
      send_email_confirmation(request, changeVal.new_email, changeVal.key);

      request.success({
        success : true
      });
    } catch(err) {
      return reply(err);
    }
  },
  changeEmail : async function(request, reply) {
    // if no user, set next and redirect
    if (!request.user) {
      request.yar.set('next', '/change-email?key=' + request.query.key);
      return reply().redirect('/login');
    }

    var user_key  = request.user.id.toString()
      , changeKey = Store.user.change_email_key(user_key);

    try {
      var changeVal = await Store.get(changeKey);
      if (!changeVal) {
        request.yar.flash('email_result', 'error', true);
        return request.fail();
      }

      changeVal = JSON.parse(changeVal);

      if (changeVal.key !== request.query.key.toLowerCase()) {
        request.yar.flash('email_result', 'key_error', true);
        return request.fail();
      }

      request.user.email = changeVal.new_email;

      // since user must've received the change email
      // it is safe to also verify them
      request.user.verified = true;

      await Store.del(changeKey);
      await request.user.save();
      request.yar.flash('email_result', 'success', true);
      return request.success();
    } catch(err) {
      if (err.code === 11000) {
        request.yar.flash('email_result', 'duplicate', true);
      }
      else {
        request.yar.flash('email_result', 'error', true);
      }

      return request.fail();
    }
  },
  sendEmailVerification : function(request, reply) {
    if (!mailer.isConfigured()) {
      return request.fail({
        message: "Email is not configured. Email verification is not available."
      });
    }

    recaptcha.verify(request.payload['g-recaptcha-response'], function(recaptcha_result) {
      if (recaptcha_result.success) {
        // create random key and store
        require('crypto').randomBytes(48, async function(ex, buf) {
          var email_key = buf.toString('hex').substring(0, 16); // send in email
          var user_key  = request.user.id.toString();
          var verifyKey = Store.user.verify_email_key(user_key);

          await Store.set(verifyKey, email_key);
          send_email_verification(request, request.user.email, email_key);

          request.success({
            success : true
          });
        });
      }
      else {
        return request.fail();
      }
    });
  },
  verifyEmail : async function(request, reply) {
    // if no user, set next and redirect
    if (!request.user) {
      request.yar.set('next', '/verify-email?key=' + request.query.key);
      return reply().redirect('/login');
    }

    var user_key  = request.user.id.toString()
      , verifyKey = Store.user.verify_email_key(user_key);

    try {
      var verifyVal = await Store.get(verifyKey);
      if (!verifyVal) {
        request.yar.flash('email_result', 'verify_error', true);
        return request.fail();
      }

      if (verifyVal !== request.query.key) {
        request.yar.flash('email_result', 'key_error', true);
        return request.fail();
      }

      request.user.verified = true;

      await Store.del(verifyKey);
      await request.user.save();
      request.yar.flash('email_result', 'verified', true);
      return request.success();
    } catch(err) {
      request.yar.flash('email_result', 'verify_error', true);
      return request.fail();
    }
  },
  activateAccountForm : async function(request, reply) {
    if (request.user) {
      return request.fail({
        redirectTo : 'home'
      });
    }

    var activateKey = Store.user.activate_account_key(request.query.key);

    try {
      var activateVal = await Store.get(activateKey);
      if (!activateVal) {
        return request.success({
          invalid : true
        });
      }

      activateVal = JSON.parse(activateVal);
      return request.success({
          key   : request.query.key
        , email : activateVal.email
      });
    } catch(err) {
      return request.success({
        invalid : true
      });
    }
  },
  activateAccount : async function(request, reply) {
    if (request.user) {
      return request.fail({
        redirectTo : 'home'
      });
    }

    var activateKey = Store.user.activate_account_key(request.payload.key);

    try {
      var activateVal = await Store.get(activateKey);
      if (!activateVal) {
        return request.fail({
          redirectTo : 'activate-account'
        });
      }

      // update password, login user
      activateVal = JSON.parse(activateVal);
      User.findById(activateVal.email, function(err, user) {
        if (err || !user) {
          return request.fail({
            redirectTo : 'activate-account'
          });
        }

        user.password = request.payload.password;
        user.save(async function(err) {
          request.yar.set('loggedInWith', 'trinket');
          request.yar._logIn(user, async function(err) {
            await Store.del(activateKey);
            request.yar.flash("info", "<strong>Thank you!</strong> Your account has been activated.");
            request.success();
          });
        });
      });
    } catch(err) {
      return request.fail({
        redirectTo : 'activate-account'
      });
    }
  },

  // Bulk export endpoints
  requestExport : function(request, reply) {
    var userId = request.user.id;

    // Check for in-flight export
    Export.findPendingOrProcessing(userId)
      .then(function(existingExport) {
        if (existingExport) {
          request.fail({
            error: 'Export already in progress',
            exportId: existingExport._id.toString()
          });
          return Promise.reject({ handled: true });
        }

        // Check cooldown (1 hour between exports)
        return Export.findRecentCompleted(userId, 1);
      })
      .then(function(recentExport) {
        if (recentExport) {
          request.fail({
            error: 'Please wait 1 hour between exports',
            lastExport: recentExport.created
          });
          return Promise.reject({ handled: true });
        }

        // Create export record
        var exportRecord = new Export({
          _owner: userId,
          status: 'pending'
        });

        return exportRecord.save();
      })
      .then(function(saved) {
        var exportRecord = saved;

        // Queue the job
        exportsQueue.add({
          action: 'bulk-export',
          exportId: exportRecord._id.toString(),
          userId: userId
        });

        return request.success({
          success: true,
          data: {
            exportId: exportRecord._id.toString(),
            status: 'pending',
            message: 'Export started. You will receive an email when ready.'
          }
        });
      })
      .catch(function(err) {
        if (err && err.handled) return;
        console.log('Export request error:', err);
        return request.fail({ error: err.message || 'Failed to start export' });
      });
  },

  listExports : function(request, reply) {
    var limit = request.query.limit || 10;

    Export.findByOwner(request.user)
      .then(function(exports) {
        exports = exports || [];
        var data = exports.slice(0, limit).map(function(exp) {
          return {
            id: exp._id.toString(),
            status: exp.status,
            progress: exp.progress,
            trinketCount: exp.trinketCount,
            fileSize: exp.fileSize,
            created: exp.created ? exp.created.toISOString() : null,
            expiresAt: exp.expiresAt ? exp.expiresAt.toISOString() : null,
            downloadAvailable: exp.status === 'completed' && exp.expiresAt > new Date()
          };
        });
        return request.success({ success: true, data: data });
      })
      .catch(function(err) {
        return request.fail({ error: err.message });
      });
  },

  getExportStatus : function(request, reply) {
    try {
      var userId = request.user.id;
      var exportId = request.params.exportId;

      Export.findById(exportId, function(err, exportRecord) {
        try {
          if (err) {
            return request.fail({ error: err.message });
          }

          if (!exportRecord) {
            return reply(Boom.notFound('Export not found'));
          }

          if (exportRecord._owner.toString() !== userId) {
            return reply(Boom.forbidden('Access denied'));
          }

          var downloadAvailable = exportRecord.status === 'completed' &&
                                  exportRecord.expiresAt &&
                                  exportRecord.expiresAt > new Date();

          return request.success({
            success: true,
            data: {
              id: exportRecord._id.toString(),
              status: exportRecord.status,
              progress: {
                total: exportRecord.progress ? exportRecord.progress.total : 0,
                processed: exportRecord.progress ? exportRecord.progress.processed : 0,
                failed: exportRecord.progress ? exportRecord.progress.failed : 0
              },
              trinketCount: exportRecord.trinketCount,
              fileSize: exportRecord.fileSize,
              created: exportRecord.created ? exportRecord.created.toISOString() : null,
              expiresAt: exportRecord.expiresAt ? exportRecord.expiresAt.toISOString() : null,
              errorMessage: exportRecord.errorMessage,
              downloadAvailable: downloadAvailable,
              downloadUrl: downloadAvailable ? '/api/exports/' + exportRecord._id + '/download' : null
            }
          });
        } catch (innerErr) {
          console.log('getExportStatus inner error:', innerErr.stack || innerErr);
          return reply(Boom.internal('Export status error'));
        }
      });
    } catch (outerErr) {
      console.log('getExportStatus outer error:', outerErr.stack || outerErr);
      return reply(Boom.internal('Export status error'));
    }
  },

  downloadExport : function(request, reply) {
    var userId = request.user.id;
    var exportId = request.params.exportId;

    Export.findById(exportId, function(err, exportRecord) {
      if (err) {
        return request.fail({ error: err.message });
      }

      if (!exportRecord) {
        return reply(Boom.notFound('Export not found'));
      }

      if (exportRecord._owner.toString() !== userId) {
        return reply(Boom.forbidden('Access denied'));
      }

      if (exportRecord.status !== 'completed') {
        return reply(Boom.badRequest('Export not ready'));
      }

      if (!exportRecord.expiresAt || new Date() > exportRecord.expiresAt) {
        return reply(Boom.badRequest('Export has expired'));
      }

      // Generate a fresh presigned URL. The browser can't resolve the internal
      // S3 endpoint (e.g. garage:3900 / minio:9000), so the URL must be signed
      // for a browser-reachable host. Under SigV4 the host is part of the
      // signature (SignedHeaders=host), so we must SIGN against the public
      // endpoint — rewriting the host afterwards would invalidate the signature.
      // config.aws.publicEndpoint is the browser-facing S3 API endpoint
      // (e.g. http://localhost:3900 in dev; the public Garage endpoint in prod).
      var client = new aws.S3(
        config.aws.publicEndpoint ? { endpoint: config.aws.publicEndpoint } : {}
      );
      var downloadUrl = client.getSignedUrl('getObject', {
        Bucket: config.aws.buckets.exports.name,
        Key: exportRecord.s3Key,
        Expires: 3600  // 1 hour
      });

      // Legacy fallback for SigV2 backends (e.g. older MinIO setups), whose
      // query URLs don't sign the host so a post-hoc host swap is safe. With
      // SigV4 + publicEndpoint above this is unused; harmless if S3_PUBLIC_HOST
      // is unset.
      if (!config.aws.publicEndpoint && process.env.S3_PUBLIC_HOST) {
        downloadUrl = downloadUrl.replace(/^(https?:\/\/)[^/]+/, '$1' + process.env.S3_PUBLIC_HOST);
      }

      return reply().redirect(downloadUrl);
    });
  }
};

function send_email_confirmation(request, new_email, key) {
  var change_email_url = config.url + '/change-email?key=' + key;

  var message = nunjucks.render('emails/confirmEmailChange', {
    fullname         : request.user.fullname,
    username         : request.user.username,
    new_email        : new_email,
    change_email_url : change_email_url
  });
  mailer.send(new_email, 'Confirm new email address', { html : message, type : 'confirm-email-change' });
}

function send_email_verification(request, email, key) {
  var verify_email_url = config.url + '/verify-email?key=' + key;

  var message = nunjucks.render('emails/verifyEmail', {
    fullname         : request.user.fullname,
    username         : request.user.username,
    email            : email,
    verify_email_url : verify_email_url
  });
  mailer.send(email, 'Verify email address', { html : message, type : 'verify-email' });
}
