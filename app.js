#!/usr/bin/env node

// Add Q-compatible methods to native Promise for Mongoose 6 compatibility
if (!Promise.prototype.spread) {
  Promise.prototype.spread = function(fn) {
    return this.then(function(result) {
      if (Array.isArray(result)) {
        return fn.apply(null, result);
      }
      return fn(result);
    });
  };
}
if (!Promise.prototype.fail) {
  Promise.prototype.fail = Promise.prototype.catch;
}


// initialize the global logger
log = require('./config/log');

const startupCheck   = require('./lib/util/startup-check');
const Hapi           = require('@hapi/hapi');
const Boom           = require('@hapi/boom');
const Inert          = require('@hapi/inert');
const Vision         = require('@hapi/vision');
const Yar            = require('@hapi/yar');
const config         = require('./config/app.config');
const Helpers        = require('./lib/util/helpers');
const Authentication = require('./lib/auth/passport.js');
// gleak is not compatible with Node 16+ (uses GLOBAL which was removed)
// Use a no-op fallback for now
let gleak;
try {
  gleak = require('gleak')();
} catch (e) {
  gleak = { detectNew: () => [], ignore: () => {} };
}
const mailer         = require('./lib/util/mailer');
const viewEngine     = require('./lib/util/nunjucks');
const dbBackend    = (config.db && config.db.backend) || 'mongoose';
const sessionCacheBackend = (config.app.plugins.session.cache && config.app.plugins.session.cache.backend) || dbBackend;
const CatboxEngine = sessionCacheBackend === 'memory'
  ? { Engine: require('@hapi/catbox-memory') }
  : sessionCacheBackend === 'firestore'
    ? require('./lib/util/catbox-firestore')
    : require('./lib/util/catbox-mongoose');
const fs             = require('fs');
const path           = require('path');


const cache_control = 'private, s-maxage=0, max-age=0, no-cache, no-store, must-revalidate, proxy-revalidate';

// Main async initialization
const init = async () => {
  // Validate required configuration — allow env var override for Cloud Run
  const sessionPassword = process.env.SESSION_PASSWORD || config.app.plugins.session.cookieOptions.password;
  if (process.env.SESSION_PASSWORD) {
    config.app.plugins.session.cookieOptions.password = process.env.SESSION_PASSWORD;
  }

  if (process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CALLBACK_URL) {
    if (!config.app.auth) config.app.auth = {};
    if (!config.app.auth.google) config.app.auth.google = {};
    if (process.env.GOOGLE_CLIENT_ID) config.app.auth.google.clientID = process.env.GOOGLE_CLIENT_ID;
    if (process.env.GOOGLE_CLIENT_SECRET) config.app.auth.google.clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (process.env.GOOGLE_CALLBACK_URL) config.app.auth.google.callbackURL = process.env.GOOGLE_CALLBACK_URL;
  }
  if (!sessionPassword || sessionPassword.length < 32) {
    console.error('\n' + '='.repeat(70));
    console.error('ERROR: Session cookie password not configured!');
    console.error('');
    console.error('You must set a secure password (min 32 characters) in config/local.yaml:');
    console.error('');
    console.error('  app:');
    console.error('    plugins:');
    console.error('      session:');
    console.error('        cookieOptions:');
    console.error("          password: 'your-secure-password-at-least-32-characters'");
    console.error('');
    console.error('See config/local.example.yaml for a template.');
    console.error('='.repeat(70) + '\n');
    process.exit(1);
  }
  // Create server with Hapi 20+ configuration
  const server = Hapi.server({
    host: config.app.hostname || 'localhost',
    port: process.env.PORT || config.app.port || 3000,
    routes: {
      cors: config.app.cors || false,
      state: {
        failAction: 'log'
      }
    },
    // Disable built-in debug logging; we install our own listener below (includes path)
    debug: false,
    // Configure server-side session cache
    cache: [{
      name: 'sessions',
      provider: {
        constructor: CatboxEngine.Engine,
        options: {}
      }
    }]
  });

  // Log request errors with path so we can identify the source
  if (config.isDev) {
    server.events.on({ name: 'request', filter: ['error'] }, function(request, event) {
      // Suppress browser devtools source-map probes — harmless 404s
      if (/\.map$/.test(request.path)) return;
      var data = event.error || event.data;
      var msg  = data ? '\n    ' + (data.stack || (typeof data === 'object' ? JSON.stringify(data) : data)) : '';
      console.error('Debug:', event.tags.join(', '), request.method.toUpperCase(), request.path + msg);
    });
  }

  // The session cookie is SameSite=None;Secure in any HTTPS context — production (config isSecure:true)
  // or a tunnel where app.url.protocol=https — so it is sent when trinket is embedded cross-site in an
  // LMS iframe (LTI). Over plain http, SameSite=None is invalid (it requires Secure), so fall back to Lax.
  const sessionSecure = config.app.plugins.session.cookieOptions.isSecure !== false
    || !!(config.app.url && config.app.url.protocol === 'https');

  // Register plugins
  await server.register([
    Inert,  // Static file serving
    Vision, // Template rendering
    {
      plugin: Yar,
      options: {
        storeBlank: false,
        cookieOptions: {
          password: config.app.plugins.session.cookieOptions.password,
          isSecure: sessionSecure,
          isSameSite: sessionSecure ? 'None' : 'Lax'
        },
        // Store sessions in the cookie when they fit (most cases), fall
        // back to the server-side cache for anything that exceeds the
        // cookie size limit.
        maxCookieSize: 3500,
        name: config.app.plugins.session.name || 'session',
        cache: {
          cache: 'sessions',
          expiresIn: 24 * 60 * 60 * 1000 // 24 hours
        }
      }
    }
  ]);

  // Add _logIn method to yar for session-based login
  // Also ensure request.user is set from auth credentials (for inject() calls)
  // Touch session on each request to implement sliding expiration
  server.ext('onPreHandler', (request, h) => {
    if (request.yar) {
      request.yar._logIn = function(user, cb) {
        // Store user id in session
        request.yar.set('userId', user._id ? user._id.toString() : user.id);
        // Also attach user to request for immediate use
        request.user = user;
        if (cb) cb(null);
      };

      // Sliding expiration: touch session to reset TTL on each authenticated request
      if (request.yar.get('userId')) {
        request.yar.touch();
      }
    }
    // Set request.user from auth credentials if not already set
    // This handles inject() calls that pass credentials directly
    if (!request.user && request.auth.credentials && request.auth.credentials._id) {
      request.user = request.auth.credentials;
    }
    return h.continue;
  });

  // Configure view engine (Vision) - use nunjucks compile function
  server.views({
    engines: {
      html: {
        compile: viewEngine.compile
      }
    },
    relativeTo: path.join(__dirname, config.app.templates),
    path: '.',
    isCached: config.isProd
  });

  // Add onPreResponse extension for cache headers and error pages
  server.ext('onPreResponse', (request, h) => {
    const response = request.response;
    const addXFrame = config.app.xframeDeny && config.app.xframeDeny.indexOf(request.url.pathname) >= 0;

    if (response.isBoom) {
      const statusCode = response.output.statusCode;

      // Check if this is an HTML request (not API/JSON)
      const acceptHeader = request.headers.accept || '';
      const isApiRequest = request.path.startsWith('/api/') ||
                           acceptHeader.includes('application/json') ||
                           request.path.startsWith('/partials/');

      // Render HTML error pages for browser requests
      const wantsHtml = acceptHeader.includes('text/html') ||
                        (!acceptHeader.includes('application/json') && !isApiRequest);

      if (!isApiRequest && wantsHtml) {
        if (statusCode === 401) {
          // Redirect to login for unauthorized page requests
          return h.redirect('/login').takeover();
        } else if (statusCode === 404) {
          return h.view('404.html').code(404);
        } else if (statusCode === 403) {
          return h.view('50x.html').code(403);
        } else if (statusCode >= 500) {
          return h.view('50x.html').code(statusCode);
        }
      }

      response.output.headers['Cache-Control'] = cache_control;
      response.output.headers['Pragma'] = 'no-cache';
      response.output.headers['Expires'] = '0';

      if (addXFrame) {
        response.output.headers['X-Frame-Options'] = 'deny';
      }
    }
    else if (response.header) {
      response.header('Cache-Control', cache_control);
      response.header('Pragma', 'no-cache');
      response.header('Expires', '0');

      if (addXFrame) {
        response.header('X-Frame-Options', 'deny');
      }
    }

    return h.continue;
  });

  // Inject request hostname into every view context so templates render
  // correctly regardless of which domain served the request.
  server.ext('onPreResponse', (request, h) => {
    const response = request.response;
    if (response && response.variety === 'view' &&
        response.source && response.source.context) {
      response.source.context._hostname = request.info.hostname;
    }
    return h.continue;
  });

  // Add onPreResponse extension for cookie expiration (SameSite/Secure are set on the cookie by
  // Yar's cookieOptions above, driven by sessionSecure).
  server.ext('onPreResponse', (request, h) => {
    // if this is a cookie-setting request and we have a _header method
    if (request.cookie && request.response && typeof request.response._header === "function") {
      const header = request.response._header;
      const sessionName = config.app.plugins.session.name || 'session';

      request.response._header = function(key, value) {
        // find the 'set-cookie' header
        if (key.match(/^set\-cookie$/i)) {
          if (!Array.isArray(value)) {
            value = [value];
          }
          const nextYear = new Date();
          nextYear.setFullYear(nextYear.getFullYear() + 1);

          for (let i = 0; i < value.length; i++) {
            // find the session portion of the cookie
            if (value[i].indexOf(sessionName) === 0) {
              // add a custom expires if an expires is not already present
              if (!value[i].match(/;\s*Expires=/i)) {
                value[i] += "; Expires=" + nextYear.toUTCString();
              }
            }
          }
        }
        // call the original _header method
        header.call(request.response, key, value);
      }
    }

    return h.continue;
  });

  // Simple session-based auth scheme for Hapi 20+
  server.auth.scheme('session', (server, options) => {
    return {
      authenticate: async (request, h) => {
        // Get user from session via yar
        const userId = request.yar.get('userId');

        if (!userId) {
          // Not authenticated - continue as guest (for 'try' mode)
          return h.unauthenticated(Boom.unauthorized('Not logged in'), { credentials: {} });
        }

        try {
          const user = await new Promise((resolve, reject) => {
            User.findById(userId, (err, user) => {
              if (err) reject(err);
              else resolve(user);
            });
          });

          if (!user) {
            request.yar.clear('userId');
            return h.unauthenticated(Boom.unauthorized('User not found'), { credentials: {} });
          }

          if (user.hasRole && user.hasRole("disabled")) {
            request.yar.clear('userId');
            return h.unauthenticated(Boom.unauthorized('Account disabled'), { credentials: {} });
          }

          // Attach user to request
          request.user = user;
          return h.authenticated({ credentials: user });
        } catch (err) {
          log.error('Auth error:', err);
          return h.unauthenticated(Boom.unauthorized('Auth error'), { credentials: {} });
        }
      }
    };
  });

  // Register the session auth strategy
  server.auth.strategy('session', 'session');

  // Make session auth the default but don't require it
  server.auth.default({ strategy: 'session', mode: 'try' });

  // Load models (global for backwards compatibility)
  User     = require('./lib/models/user');
  Course   = require('./lib/models/course');
  Lesson   = require('./lib/models/lesson');
  Material = require('./lib/models/material');
  File     = require('./lib/models/file');
  Trinket  = require('./lib/models/trinket');
  Interaction = require('./lib/models/interaction');
  Folder   = require('./lib/models/folder');
  CourseInvitation = require('./lib/models/courseInvitation');

  // Register helpers
  Helpers.register(server);

  // Register routes
  server.route(config.routes);

  // Verify backend connectivity before accepting traffic
  const checkPassed = await startupCheck.run();
  if (!checkPassed) {
    process.exit(1);
  }

  // Start the server
  if (config.app.start) {
    await server.start();
    log.info('Server started on port: ' + server.info.port);

    detectLeaks();
  }

  return server;
};

const detectLeaks = function() {
  let leakData = "";

  gleak.detectNew().forEach(function(name) {
    let value = "unknown", json;
    try {
      value = eval(name);
      if (typeof value === "function") {
        value = value.toString();
      }
      else {
        json  = JSON.stringify(value);
        value = json;
      }
    } catch(e) {}

    leakData += name + "=" + value + "\n";
  });

  if (leakData) {
    console.log('leaked!', leakData);
  }
};

gleak.ignore("User", "Course", "Lesson", "Material", "File", "Trinket");
gleak.ignore("Interaction");
gleak.ignore("Folder", "CourseInvitation");
gleak.ignore("log", "NODE_CONFIG", "tokenizer", "$V", "$M", "$L", "$P");
gleak.ignore("DEFAULT_FILE_PATH", "Promise");

// Poll for new leaks every 60 seconds
setInterval(detectLeaks, 60*1000);

// Initialize and export
const serverPromise = init().catch(err => {
  log.error('Failed to start server:', err);
  process.exit(1);
});

// Optionally register the bulk-export queue worker in this process. Used by the
// local test stack (RUN_EXPORT_WORKER=true); production runs workers separately.
// Loaded after init() resolves so config/app.config and the route layer are
// already initialized — requiring the worker cold elsewhere mis-compiles their
// validation schemas.
if (process.env.RUN_EXPORT_WORKER === 'true') {
  serverPromise.then(() => {
    require('./lib/workers/exports');
    console.log('[app] bulk-export worker registered in-process');
  });
}

module.exports = serverPromise;
