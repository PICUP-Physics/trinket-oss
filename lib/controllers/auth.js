var config         = require('config'),
    Boom           = require('@hapi/boom'),
    firebaseAdmin  = require('../util/firebase-admin'),
    instructorAuth = require('../util/instructorAuth'),
    siteAdmin      = require('../util/siteAdmin'),
    userUtil       = require('../util/user');

module.exports = {

  // GET /login  GET /signup — single FirebaseUI page for both
  loginPage: function(request, reply) {
    var raw = process.env.FIREBASE_CLIENT_CONFIG;
    var firebaseConfig;
    if (!raw) {
      console.error('[auth] FIREBASE_CLIENT_CONFIG env var is not set');
      firebaseConfig = {};
    } else {
      try {
        firebaseConfig = JSON.parse(raw);
        console.log('[auth] FIREBASE_CLIENT_CONFIG loaded, keys:', Object.keys(firebaseConfig).join(', '));
      } catch(e) {
        console.error('[auth] FIREBASE_CLIENT_CONFIG parse error:', e.message);
        firebaseConfig = {};
      }
    }
    // When using the Auth emulator, force the browser to use the emulator's
    // project ID so issued tokens match what the admin SDK will verify against.
    if (process.env.FIREBASE_AUTH_EMULATOR_URL && process.env.GOOGLE_CLOUD_PROJECT) {
      firebaseConfig.projectId = process.env.GOOGLE_CLOUD_PROJECT;
    }
    return request.success({
      firebaseConfig: firebaseConfig,
      authEmulatorUrl: process.env.FIREBASE_AUTH_EMULATOR_URL || null
    });
  },

  // POST /api/auth/session
  // Client sends a fresh Firebase ID token; server verifies it, creates or
  // loads the user, sets a yar session, and returns a redirect URL.
  session: async function(request, reply) {
    var idToken = request.payload && request.payload.idToken;
    if (!idToken) return reply(Boom.badRequest('idToken required'));

    var decoded;
    try {
      decoded = await firebaseAdmin.auth.verifyIdToken(idToken);
    } catch (err) {
      console.error('[auth] verifyIdToken failed:', err && (err.code || err.message), err && err.stack);
      console.error('[auth] FIREBASE_AUTH_EMULATOR_HOST=', process.env.FIREBASE_AUTH_EMULATOR_HOST || '(unset)');
      return reply(Boom.unauthorized('Invalid or expired token'));
    }

    var uid   = decoded.uid;
    var email = (decoded.email || '').toLowerCase();
    if (!email) return reply(Boom.badRequest('Token must include an email address'));

    // Prefer lookup by Firebase UID; fall back to email for pre-existing accounts
    var user = await User.findOne({ firebaseUid: uid });
    if (!user) {
      user = await new Promise(function(resolve, reject) {
        User.findByLogin(email, function(err, doc) { if (err) reject(err); else resolve(doc); });
      });
    }

    var enrolledCourseFlash = null;

    if (!user) {
      var approval = await instructorAuth.isApprovedToSignup(email);
      if (!approval.approved) {
        return reply(Boom.forbidden(
          'Your email (' + email + ') is not on a course roster. ' +
          'Please check that you signed in with the same email address your instructor used to add you. ' +
          'If the problem persists, contact your instructor.'
        ));
      }

      var emailLocal = email.split('@')[0];
      var invitationName = null;
      var preCheckInvitation = await CourseInvitation.findOne({ email: email, status: { $in: ['pending', 'sent'] } });
      if (preCheckInvitation && preCheckInvitation.name) invitationName = preCheckInvitation.name;
      user = new User({
        email:        email,
        fullname:     invitationName || decoded.name || emailLocal,
        username:     userUtil.generate_username_with_suffix(emailLocal),
        firebaseUid:  uid,
        approved:     true,
        isInstructor: approval.isInstructor,
        avatar:       decoded.picture || null,
        source:       'firebase',
        verified:     true
      });
      await user.save();
      request.yar.set('grantDemoTrinkets', true);

      // Auto-accept any pending invitations for this email and enroll in courses
      var invitations = await CourseInvitation.find({ email: email, status: { $in: ['pending', 'sent'] } });
      for (var i = 0; i < invitations.length; i++) {
        var inv = invitations[i];
        var course = await Course.findById(inv.courseId.toString());
        if (course) {
          await course.addUser(user, ['course-student']);
          if (!enrolledCourseFlash) {
            enrolledCourseFlash = {
              name:      course.name,
              ownerSlug: course.ownerSlug,
              slug:      course.slug
            };
          }
        }
        inv.status = 'accepted';
        await inv.save();
      }

    } else if (!user.firebaseUid) {
      user.firebaseUid = uid;
      if (!user.approved) user.approved = true;
      await user.save();
    }

    // Seed the site 'admin' role from the admin-email allowlist (idempotent; writes only when the
    // role is newly added). Gates check hasRole('admin'); the email list is just the seed source.
    await siteAdmin.ensureSeedAdminRole(user);

    // Refresh the instructor flag from the authorized allowlist (idempotent; writes only when
    // flipping false -> true). isInstructor is otherwise set only at first Firebase signup, so
    // this heals accounts made via other paths or authorized after signup.
    await instructorAuth.ensureInstructorFlag(user);

    var next = request.yar.get('next');
    request.yar.reset();
    request.yar._logIn(user, function() {});
    request.yar.flash('requested', user.username);
    if (enrolledCourseFlash) {
      request.yar.flash('acceptedCourseInvitation', { course: enrolledCourseFlash }, true);
    }

    return reply({ status: 'success', redirect: next || '/welcome' });
  },

  // POST /api/auth/logout
  logout: function(request, reply) {
    if (request.yar) { request.yar.clear('userId'); request.yar.reset(); }
    return request.success({ status: 'success' });
  },

  // Legacy Google OAuth - kept for reference, superseded by Firebase Auth
  google : function(request, h) {
    if (!config.app.auth || !config.app.auth.google || !config.app.auth.google.clientID) {
      return request.fail({
        message: 'Google OAuth is not configured. Please set up Google OAuth credentials.'
      });
    }

    request.yar.flash('auth', 'Google', true);
    if (request.query.next) {
      request.yar.set('next', request.query.next);
    }

    // Build Google OAuth URL
    var googleAuthUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
    var params = new URLSearchParams({
      client_id: config.app.auth.google.clientID,
      redirect_uri: config.app.auth.google.callbackURL,
      response_type: 'code',
      scope: 'profile email',
      access_type: 'online'
    });

    return request.success({ redirectTo: googleAuthUrl + '?' + params.toString() });
  },

  googleCallback : function(request, h) {
    if (!config.app.auth || !config.app.auth.google || !config.app.auth.google.clientID) {
      return request.fail({
        message: 'Google OAuth is not configured.'
      });
    }

    var code = request.query.code;
    if (!code) {
      return request.fail({ message: 'No authorization code received from Google.' });
    }

    // Exchange code for token
    return new Promise(function(resolve, reject) {
      _request.post({
        url: 'https://oauth2.googleapis.com/token',
        form: {
          code: code,
          client_id: config.app.auth.google.clientID,
          client_secret: config.app.auth.google.clientSecret,
          redirect_uri: config.app.auth.google.callbackURL,
          grant_type: 'authorization_code'
        },
        json: true
      }, function(err, response, body) {
        if (err || !body.access_token) {
          return reject(err || new Error('Failed to get access token: ' + JSON.stringify(body)));
        }
        resolve(body.access_token);
      });
    })
    .then(function(accessToken) {
      // Get user profile
      return new Promise(function(resolve, reject) {
        _request.get({
          url: 'https://www.googleapis.com/oauth2/v2/userinfo',
          headers: { Authorization: 'Bearer ' + accessToken },
          json: true
        }, function(err, response, profile) {
          if (err || !profile.email) {
            return reject(err || new Error('Failed to get user profile'));
          }
          profile.accessToken = accessToken;
          resolve(profile);
        });
      });
    })
    .then(function(profile) {
      // Find or create user
      return new Promise(function(resolve, reject) {
        User.findByMultiple({
          email: profile.email,
          username: userUtil.generate_username(profile.email),
          'profiles.google.id': profile.id
        }, function(err, user) {
          if (err) reject(err);
          else resolve(user);
        });
      })
      .then(function(user) {
        var next = request.yar.get('next');
        var promises = [];
        var updateUser = false;

        request.yar.reset();
        if (next) {
          request.yar.set('next', next);
        }
        request.yar.set('loggedInWith', 'google');

        if (user) {
          request.yar.flash('requested', user.username);
          if (!user.avatar && profile.picture) {
            updateUser = true;
            user.avatar = profile.picture;
          }
          if (!user.profiles) {
            user.profiles = {};
          }
          if (!user.profiles.google) {
            updateUser = true;
            user.profiles.google = {
              id: profile.id,
              token: profile.accessToken
            };
          }

          if (updateUser) {
            promises.push(user.save());
          }

          return Promise.all(promises).then(function() {
            return user;
          });
        }
        else {
          // Create new user
          user = new User();
          user.email = profile.email;
          user.fullname = profile.name || profile.email.split('@')[0];
          user.username = userUtil.generate_username(profile.email);
          request.yar.flash('requested', user.username);
          user.source = 'google';
          user.avatar = profile.picture;
          user.profiles = {
            google: {
              id: profile.id,
              token: profile.accessToken
            }
          };

          return user.save()
            .then(function(newUser) {
              if (!next) {
                request.yar.set('next', '/welcome');
              }
              request.yar.set('grantDemoTrinkets', true);
              request.yar.flash('userAccountCreated', JSON.stringify({}));

              return newUser;
            });
        }
      });
    })
    .then(function(user) {
      // Seed the site 'admin' role from the allowlist before login (same as the Firebase path).
      return Promise.resolve(siteAdmin.ensureSeedAdminRole(user)).then(function() { return user; });
    })
    .then(function(user) {
      // Refresh the instructor flag (same as the Firebase path). The Google-OAuth signup path
      // never set isInstructor, so without this every google-sourced instructor stays false.
      return Promise.resolve(instructorAuth.ensureInstructorFlag(user)).then(function() { return user; });
    })
    .then(function(user) {
      // Log in user - store userId in session
      request.yar.set('userId', user.id);
      request.user = user;

      var redirectTo = request.yar.get('next') || '/home';
      request.yar.clear('next');

      var educatorsFormData = request.yar.get('educatorsFormData');
      var registrationPayload = request.yar.get('registration-payload');

      if (educatorsFormData) {
        request.yar.set('educatorsFormData', educatorsFormData, true);
      }
      if (registrationPayload) {
        request.yar.set('registration-payload', registrationPayload);
      }

      // Grant demo trinkets if needed
      if (request.yar.get('grantDemoTrinkets')) {
        request.yar.clear('grantDemoTrinkets');
        // Demo trinket granting would happen here via server.methods
      }

      return request.success({ redirectTo: redirectTo });
    })
    .catch(function(err) {
      log.error('Google OAuth error:', err);
      return request.fail({ message: 'Authentication failed. Please try again.' });
    });
  }
};
