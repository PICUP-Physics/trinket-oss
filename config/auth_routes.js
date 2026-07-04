// Auth provider route tables.
//
// A deployment uses exactly ONE auth provider, selected by
// config.auth.provider ('local' | 'firebase', default 'local'). Each provider
// owns its complete page/session surface — login & signup pages, logout,
// session establishment, password flows, OAuth redirects — so no other route
// file needs to know which provider is active. Both providers converge on the
// same cookie session and the same post-login pipeline
// (ensureSeedAdminRole / ensureInstructorFlag in their controllers), so the
// rest of the app only ever sees `request.user`.
//
//  - local:    stock email/password auth (users.login/create, bcrypt hooks in
//              the User model, forgot-pass + activate-account flows).
//  - firebase: FirebaseUI page (login-firebase.html) + Google OAuth via
//              passport. Session establishment is POST /api/auth/session in
//              config/api_routes.js (client exchanges a Firebase ID token).

var Joi     = require('joi'),
    yaml    = require('js-yaml'),
    fs      = require('fs'),
    helpers = require('../lib/util/helpers'),
    config  = require('config');

var reservedUsernames = yaml.safeLoad(fs.readFileSync(__dirname + '/reserved.yaml', 'utf8'));

// Make recaptcha optional when not configured (same rule as routes.js)
var recaptchaValidation = (config.app.recaptcha && config.app.recaptcha.secretkey)
  ? Joi.string().required()
  : Joi.string().allow('').optional();

var providers = {};

// ── local: stock email/password ─────────────────────────────────────────────
providers.local = [
  {
    route : 'GET /signup pages.signup',
    html  : 'signup.html'
  },
  {
    route : 'GET /login pages.login',
    html  : 'login.html',
    config : {
      validate : {
        query : {
          next : Joi.string().optional()
        }
      }
    }
  },
  {
    route    : 'GET /logout users.logout',
    cookie   : true,
    redirect : '/'
  },
  {
    route   : 'POST /login users.login',
    cookie  : true,
    success : {
      redirect : '/home'
    },
    fail    : {
      redirect : '/login'
    },
    config  : {
      pre : [{ method : helpers.lowerUserFields }],
      validate : {
        payload : {
          email    : Joi.string().required(),
          password : Joi.string()
        }
      }
    }
  },
  {
    route : 'POST /users users.create',
    cookie  : true,
    success : {
      redirect : '/welcome'
    },
    fail : {
      redirect : '/{formName}'
    },
    config : {
      pre : [{ method: helpers.lowerUserFields }],
      validate  : {
        payload : {
          formName : Joi.string().required(),
          fullname : Joi.string().max(50).optional(),
          username : Joi.string().min(3).max(20).regex(/^[a-z][a-z0-9\-\_]*$/i).optional().invalid(...reservedUsernames),
          email    : Joi.string().email().required(),
          password : Joi.string().min(3).regex(/^[\w`~!@#$%^&*+=:;'"<>,.?{}\-\/\(\)\[\]\|\\\s]*$/).required(),
          interest : Joi.string().allow('').optional(),
          next     : Joi.string().allow('').optional(),
          'g-recaptcha-response' : recaptchaValidation
        },
        language : {
          username : {
            "regular expression" : "Usernames must begin with a letter and must only contain alphanumeric characters and hyphens (-)."
          }
        }
      }
    }
  },
  {
    route : 'GET /forgot-pass pages.forgotPasswordForm',
    html  : 'users/forgotpass.html'
  },
  {
    route : 'POST /send-pass-reset users.sendPassReset',
    html  : 'users/sendpassreset.html',
    fail  : {
      redirect : '/forgot-pass'
    },
    config : {
      pre : [{ method : helpers.lowerUserFields }],
      validate : {
        payload : {
          email : Joi.string().email().required(),
          'g-recaptcha-response' : recaptchaValidation
        }
      }
    }
  },
  {
    route : 'GET /reset-pass users.resetPasswordForm',
    html  : 'users/resetpass.html',
    fail  : {
      redirect : '/forgot-pass'
    },
    config : {
      validate : {
        query : {
          key : Joi.string().required()
        }
      }
    }
  },
  {
    route : 'POST /save-pass users.savePassword',
    html  : 'users/savepass.html',
    fail  : {
      redirect : '/forgot-pass'
    },
    config : {
      validate : {
        payload : {
          key             : Joi.string().required(),
          password        : Joi.string().required(),
          password_verify : Joi.string().required()
        }
      }
    }
  },
  {
    route : 'GET /activate-account users.activateAccountForm',
    html  : 'users/activateaccount.html',
    fail  : {
      redirect : '/{redirectTo}'
    },
    config : {
      validate : {
        query : {
          key : Joi.string().allow('').optional() // optional to allow for meaningful redirects
        }
      }
    }
  },
  {
    route : 'POST /activate-account users.activateAccount',
    success : {
      redirect : '/welcome'
    },
    fail  : {
      redirect : '/{redirectTo}'
    },
    config : {
      validate : {
        payload : {
          key      : Joi.string().required(),
          password : Joi.string().required()
        }
      }
    }
  }
];

// ── firebase: FirebaseUI + Google OAuth (passport) ──────────────────────────
providers.firebase = [
  {
    route : 'GET /signup auth.loginPage',
    html  : 'login-firebase.html'
  },
  {
    route : 'GET /login auth.loginPage',
    html  : 'login-firebase.html',
    config : {
      validate : {
        query : {
          next : Joi.string().optional()
        }
      }
    }
  },
  {
    route    : 'GET /logout auth.logout',
    cookie   : true,
    redirect : '/'
  },
  {
    route : 'GET /auth/google auth.google',
    config : {
      auth : false
    }
  },
  {
    route : 'GET /auth/google/callback auth.googleCallback',
    cookie  : true,
    success: {
      redirect:  '{redirectTo}'
    },
    fail: {
      redirect: '/signup'
    },
    config : {
      auth : false
    }
  }
];

var provider = (config.auth && config.auth.provider) || 'local';
if (!providers[provider]) {
  throw new Error("Unknown auth provider '" + provider + "' (expected 'local' or 'firebase')");
}

module.exports = providers[provider];
