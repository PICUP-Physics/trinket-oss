var Joi               = require('joi'),
    yaml              = require('js-yaml'),
    fs                = require('fs'),
    helpers           = require('../lib/util/helpers'),
    config            = require('config'),
    constants         = require('./constants'),  // Ensure constants is loaded
    reservedUsernames = yaml.safeLoad(fs.readFileSync(__dirname + '/reserved.yaml', 'utf8')),
    routes;

// Make recaptcha optional when not configured
var recaptchaValidation = (config.app.recaptcha && config.app.recaptcha.secretkey)
  ? Joi.string().required()
  : Joi.string().allow('').optional();

routes = [
  {
    route  : 'GET / pages.index',
    html   : 'index.html',
    enable : true
  },
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
    route  : 'GET /welcome pages.welcome',
    config : { auth: 'session' }
  },
  {
    route  : 'GET /home pages.home',
    html   : 'home.html',
    config : { auth: 'session' }
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
    route    : 'GET /logout users.logout',
    cookie  : true,
    redirect : '/'
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
    route : 'GET /account-deleted users.deleted'
  },
  {
    route : 'PUT /api/users/{userId} users.updateProfile',
    config : {
      auth: 'session',
      validate : {
        payload : {
          name     : Joi.string().min(1).max(140),
          avatar   : Joi.string().allow('').optional(),
          username : Joi.string().min(3).max(20).regex(/^[a-z][a-z0-9\-\_]*$/i).required().invalid(...reservedUsernames)
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
    route  : 'GET /courses/new courses.creationForm',
    html   : 'courses/create.html',
    config : {
      auth: 'session',
      pre : [helpers.coursesEnabled]
    }
  },
  {
    route : 'POST /courses courses.create',
    html  : {
      redirect : '/{user.username}/courses/{course.slug}'
    },
    fail  : {
      redirect : '/courses/new'
    },
    config : {
      auth: 'session',
      pre : [helpers.coursesEnabled],
      validate: {
        payload : {
          name: Joi.string().min(1).max(140).required(),
          description: Joi.string().max(500),
          courseType: Joi.string().valid('public', 'private', 'open').optional(),
          contentDefault: Joi.string().valid('publish', 'draft').optional()
        }
      }
    }
  },
  {
    route: 'POST /{userSlug}/courses/{courseSlug}/copy courses.copy',
    success: {
      redirect: '{classPageUrl}'
    },
    fail : {
      redirect : '/welcome'
    },
    config : {
      auth: 'session',
      pre:  [helpers.coursesEnabled, 'user(params.userSlug)', {method:helpers.courseBySlug, assign:'course'}]
    }
  },
  {
    route  : 'GET /{userSlug}/courses/{courseSlug}/download.zip courses.download',
    config : {
      auth: 'session',
      pre  : [helpers.coursesEnabled, 'user(params.userSlug)', {method:helpers.courseBySlug, assign:'course'}],
      validate : {
        query : {
          format : Joi.string().valid('md', 'html').required()
        }
      }
    }
  },
  {
    route  : 'GET /{userSlug}/courses/{courseSlug} courses.coursePage',
    html   : 'courses/view.html',
    config : {
      pre  : [helpers.coursesEnabled, 'user(params.userSlug)', {method:helpers.courseBySlug, assign:'course'}]
    }
  },
  {
    route : 'GET /api/classes/{userSlug}/{courseSlug} classes.getClass',
    config: {
      pre : [helpers.coursesEnabled, 'user(params.userSlug)', {method:helpers.courseBySlug, assign:'course'}]
    }
  },
  {
    route : 'GET /courses/accept/{token} classes.acceptInvitation',
    html  : 'classes/view.html',
    config : {
      pre : [helpers.coursesEnabled]
    }
  },
  {
    route : 'GET /courses/join/{accessCode} classes.joinFromLink',
    html : 'classes/view.html',
    config : {
      pre : [helpers.coursesEnabled]
    }
  },
  {
    route  : 'GET /api/files/{fileId}/{fileName} files.download',
    config : {
      pre : ['file(params.fileId)']
    }
  },
  {
    route  : 'GET /admin admin.index',
    html   : 'admin/index.html',
    fail   : {
      html : 'login.html'
    },
    config : {
      auth: 'session',
      pre  : [
        'isAdmin(user)'
      ]
    }
  },
  {
    route : 'GET /admin/{adminPage*} admin.index',
    html  : 'admin/index.html',
    fail  : {
      html : 'login.html'
    },
    config : {
      auth: 'session',
      pre  : [
        'isAdmin(user)'
      ]
    }
  },
  {
    route : 'POST /admin/upload admin.uploadUsers',
    html : 'admin/index.html',
    config : {
      auth: 'session',
      pre : ['isAdmin(user)']
    }
  },
  {
    route : 'GET /account users.account',
    html  : 'users/account.html',
    config : {
      auth: 'session'
    }
  },
  {
    route : 'GET /account/{accountPage} users.account',
    html  : 'users/account.html',
    config : {
      auth: 'session'
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
  },
  {
    route  : 'POST /file files.upload',
    config : {
      auth: 'session',
      payload : {
        maxBytes  : 1048576 * 10, // 10MB
        output : 'file',
        multipart : true // Hapi v19+ rejects multipart/form-data with 415 unless opted in
      },
      validate : {
        payload : {
          type   : Joi.string().valid('embed', 'download').optional(),
          upload : Joi.any().required()
        }
      }
    }
  },
  {
    route : 'POST /file/avatar files.uploadAvatar',
    config : {
      auth: 'session',
      payload : {
        maxBytes  : 1048576 * 5, // 5MB
        output: 'file',
        multipart : true // Hapi v19+ rejects multipart/form-data with 415 unless opted in
      },
      validate : {
        payload : {
          upload : Joi.any().required()
        }
      }
    },
    reply : {
      host : true,
      path : true
    }
  },
  {
    route  : 'GET /u/{username}/classes classes.viewCourses',
    html   : 'classes/courses.html',
    config : {
      pre : [helpers.coursesEnabled, { method : helpers.userByUsername, assign : 'user' }]
    }
  },
  {
    route  : 'GET /u/{username}/classes/{courseSlug} classes.viewClass',
    html   : 'classes/view.html',
    config : {
      pre : [helpers.coursesEnabled, { method : helpers.userByUsername, assign : 'user' }, { method : helpers.courseBySlug, assign : 'course' }]
    }
  },
  {
    // published-trinket "site" — the vanity URL produced by the Publish modal
    route  : 'GET /u/{username}/sites/{trinketSlug} trinket.getByShortCode',
    html   : 'trinket/{trinket.lang}/{trinket.lang}.html',
    config : {
      pre : [
        { method : helpers.userByUsername, assign : 'user' },
        { method : helpers.trinketByOwnerAndSlug, assign : 'trinket' },
        helpers.requirePublished,
        { method : helpers.findFeaturedTrinkets, assign : 'featuredTrinkets' }
      ]
    }
  },
  {
    route : 'GET /embed/beta/{type} trinket.beta',
    html  : 'embed/beta/{type}.html',
    config : {
      pre : [{ method: helpers.findFeaturedTrinkets, assign: 'featuredTrinkets' }]
    }
  },
  {
    route : 'GET /embed/{lang}/{trinketId} trinket.embed',
    html  : 'embed/{lang}.html',
    config : {
      pre : [helpers.trinketTypeEnabled, helpers.validLang, helpers.findTrinket]
    }
  },
  {
    route : 'GET /assignment-embed/{lang}/{trinketId} trinket.assignment', // regular "student" view, auto save
    html : 'embed/{lang}.html',
    config : {
      auth: 'session',
      pre : [helpers.trinketTypeEnabled, helpers.validLang, helpers.findTrinket]
    }
  },
  {
    route : 'GET /assignment-embed-feedback/{lang}/{trinketId} trinket.assignmentFeedback', // "teacher" feedback view, draft
    html : 'embed/{lang}.html',
    config : {
      auth: 'session',
      pre : [helpers.trinketTypeEnabled, helpers.validLang, helpers.findTrinket]
    }
  },
  {
    route : 'GET /assignment-embed-viewonly/{lang}/{trinketId} trinket.viewOnly', // view-only, no auto save or draft
    html : 'embed/{lang}.html',
    config : {
      pre : [helpers.trinketTypeEnabled, helpers.validLang, helpers.findTrinket]
    }
  },
  {
    route : 'GET /embed/blocks-iframe trinket.index',
    html  : 'embed/blocks-iframe.html'
  },
  {
    route : 'GET /embed/glowscript-blocks-iframe trinket.index',
    html  : 'embed/glowscript-blocks-iframe.html'
  },
  {
    route : 'GET /embed/{lang} trinket.embed',
    html: 'embed/{lang}.html',
    config : {
      pre : [helpers.trinketTypeEnabled, helpers.validLang, { method: helpers.getDefaultTrinket, assign: 'trinket' }]
    }
  },
  {
    route : 'GET /tools/{version}/jekyll/embed/{lang} trinket.embed',
    html: 'embed/{lang}.html',
    config : {
      pre : [helpers.trinketTypeEnabled, helpers.validLang]
    }
  },
  {
    route : 'GET /skulpt trinket.index',
    success: {
      redirect: '/python'
    }
  },
  {
    route : 'GET /skulpt/{hash} trinket.index',
    success : {
      redirect: '/python/{hash}'
    }
  },
  {
    route : 'POST /python trinket.create',
    config : {
      validate : {
        payload : {
          code : Joi.string().required(),
        }
      }
    }
  },
  {
    route : 'GET /vpython trinket.index',
    success : {
      redirect : '/glowscript'
    }
  },
  {
    route : 'GET /vpython/{shortCode} trinket.index',
    success : {
      redirect : '/glowscript/{shortCode}'
    }
  },
  {
    route : 'GET /webvpython trinket.index',
    success : {
      redirect : '/glowscript'
    }
  },
  {
    route : 'GET /webvpython/{shortCode} trinket.index',
    success : {
      redirect : '/glowscript/{shortCode}'
    }
  },
  {
    route : 'GET /r trinket.index',
    success : {
      redirect : '/R'
    }
  },
  {
    route : 'GET /r/{shortCode} trinket.index',
    success : {
      redirect : '/R/{shortCode}'
    }
  },
  {
    route : 'GET /legacy/embed/{lang}/{shortCode} trinket.legacyEmbedRedirect'
  },
  {
    route : 'GET /legacy/embed/{shortCode} trinket.legacyEmbedRedirect'
  },
  {
    route : 'GET /legacy/{lang}/{shortCode} trinket.legacyRedirect'
  },
  {
    route : 'GET /legacy/{shortCode} trinket.legacyRedirect'
  },
  {
    route : 'GET /library/trinkets/{path*} trinket.library',
    config : {
      pre : [helpers.trinketTypeEnabled],
      validate : {
        query : {
          lang : Joi.string().optional(),
          user : Joi.string().optional(),
          go   : Joi.string().optional(),
          _3d  : Joi.string().optional()
        }
      }
    },
    html  : 'trinket/library.html'
  },
  {
    route : 'GET /library/folder/{slug} folders.listView',
    config : {
      auth: 'session'
    },
    html : 'trinket/library.html'
  },
  {
    route : 'GET /docs/colors pages.index',
    html  : 'docs/colors.html'
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
  },
];

// trinket language specific routes
config.constants.trinketLangs.forEach(function(lang) {
  // language landing page
  routes.push({
      route  : 'GET /' + lang + ' trinket.index'
    , html   : 'trinket/' + lang + '/' + lang + '.html'
    , config : {
        pre  : [
            helpers.trinketTypeEnabled
          , {
                method : helpers.findFeaturedTrinkets
              , assign : 'featuredTrinkets'
            }
        ]
    }
  });

  // trailing slash landing page
  routes.push({
      route   : 'GET /' + lang + '/ pages.index'
    , success : {
        redirect : '/' + lang
      }
    , config  : {
        pre : [helpers.trinketTypeEnabled, helpers.validLang]
      }
  });

  // specific trinket landing page
  routes.push({
      route  : 'GET /' + lang + '/{shortCode} trinket.getByShortCode'
    , html   : 'trinket/' + lang + '/' + lang + '.html'
    , config : {
        pre  : [
            helpers.trinketTypeEnabled
          , helpers.findTrinket
          , {
                method : helpers.findFeaturedTrinkets
              , assign : 'featuredTrinkets'
            }
        ]
      }
  });

  // download the "main" file for a trinket
  routes.push({
      route : 'GET /' + lang + '/{shortCode}/ trinket.downloadMain'
    , config : {
        pre : [helpers.trinketTypeEnabled]
      }
  });

  // download specific file for a trinket
  routes.push({
      route : 'GET /' + lang + '/{shortCode}/{path*} trinket.downloadFile'
    , config : {
        pre : [helpers.trinketTypeEnabled]
      }
  });
});

module.exports = routes;
