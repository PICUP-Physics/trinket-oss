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


// node-config 0.4 persists any runtime config mutation to config/runtime.json
// and reloads that file WITH TOP PRIORITY on the next boot — so a stale file
// silently overrides yaml/env config edits (it burned both the test harness
// and a deploy). We never use the runtime.json paradigm; disable it before
// the first require('config').
process.env.NODE_CONFIG_PERSIST_ON_CHANGE = process.env.NODE_CONFIG_PERSIST_ON_CHANGE || 'N';
process.env.NODE_CONFIG_DISABLE_FILE_WATCH = process.env.NODE_CONFIG_DISABLE_FILE_WATCH || 'Y';

// Resolve the per-deploy overlay folder (TRINKET_DEPLOY) BEFORE anything
// requires 'config' — it extends NODE_CONFIG_DIR, which node-config reads once.
require('./config/deploy-dir');

// initialize the global logger
log = require('./config/log');

const startupCheck   = require('./lib/util/startup-check');
const publicHostname = require('./lib/util/publicHostname');
const sessionCookie  = require('./lib/util/sessionCookie');
const Hapi           = require('@hapi/hapi');
const Boom           = require('@hapi/boom');
const Inert          = require('@hapi/inert');
const Vision         = require('@hapi/vision');
const Yar            = require('@hapi/yar');
const config         = require('./config/app.config');
const Helpers        = require('./lib/util/helpers');
const embedCsp       = require('./lib/util/embedCsp');
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
const routeParser    = require('./lib/util/routeParser');
const dbBackend    = (config.db && config.db.backend) || 'mongoose';
const sessionCacheBackend = (config.app.plugins.session.cache && config.app.plugins.session.cache.backend) || dbBackend;
const CatboxEngine = sessionCacheBackend === 'memory'
  ? { Engine: require('@hapi/catbox-memory') }
  : sessionCacheBackend === 'firestore'
    ? require('./lib/util/catbox-firestore')
    : require('./lib/util/catbox-mongoose');
const fs             = require('fs');
const path           = require('path');


// Which responses may be cached — see lib/util/cacheControl. Dynamic responses
// keep the exact header this constant always carried; only version-stamped
// static assets are allowed to differ, and only when a deploy opts in via
// app.cache.enabled.
const cacheControl = require('./lib/util/cacheControl');

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

    // One embed policy for both branches below. knownHosts is included so a
    // deploy behind a CDN front door (Firebase Hosting, Cloudflare) still names
    // the origin the BROWSER is actually using — request.url.origin is only the
    // backend's own host there (see lib/util/publicHostname.js for the same
    // problem on the template side).
    const embedPolicy = embedCsp.policyFor(config.app.csp, request.url && request.url.pathname,
      request.query && request.query.runMode,
      [config.url, request.url && request.url.origin]
        .concat((config.app.url && config.app.url.knownHosts) || []));

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
        // A route that declares `fail: { html: ... }` means that page to be its
        // failure surface — including when a PRE-handler rejects. Previously
        // `fail.html` was consulted only by request.fail() (a controller choosing
        // to fail), so `isAdmin` throwing Boom.forbidden fell through to the
        // generic "Something went wrong" page: on /admin that reads as a broken
        // site rather than "you need to sign in" (issue #74). Checked before the
        // generic pages below so the route's own choice wins.
        const failHtml = request.route && request.route.settings
          && request.route.settings.app && request.route.settings.app.failHtml;
        if (failHtml && statusCode !== 401) {
          const failContext = {};
          try {
            routeParser.addUserContext(failContext, request);

            // A route's fail page (typically login.html) assumes the visitor is
            // NOT signed in. Handing a login form to someone who already is
            // hides the actual problem — "this account lacks permission" — which
            // is how the original report described /admin. So: authenticated and
            // forbidden gets a real 403 page; everyone else gets the route's
            // declared fail page.
            if (statusCode === 403 && request.user) {
              return h.view('403.html', failContext).code(403);
            }
            return h.view(failHtml, failContext).code(statusCode);
          } catch (e) {
            // Never let the failure page become its own failure — fall through
            // to the generic handling below.
          }
        }

        if (statusCode === 401) {
          // A framed request that arrived with NO cookies at all cannot be
          // repaired by signing in: the browser will refuse the session cookie
          // /login sets for the same reason it refused the first one, so the
          // user just bounces between the two. Explain it instead (#217).
          //
          // Deliberately narrow — only where we were ALREADY sending them to
          // /login (so anonymous-by-design pages like embeds are untouched),
          // and only when no cookie arrived at all, which is the observed
          // signature of third-party blocking. A framed request that DID send
          // cookies is an ordinary signed-out user and still gets /login.
          const dest = request.headers['sec-fetch-dest'];
          if ((dest === 'iframe' || dest === 'frame') && !request.headers.cookie) {
            return h.view('lti/framed-cookies.html', {
              siteName : (config.app && config.app.siteName) || 'Trinket',
              siteHost : publicHostname.resolve(
                request.headers,
                request.info.hostname,
                [config.app.url.hostname].concat(config.app.url.knownHosts || [])
              )
            }).code(200).takeover();
          }

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

      const boomHeaders = cacheControl.headersFor(request.path, statusCode, config.app);
      Object.keys(boomHeaders).forEach((name) => {
        response.output.headers[name] = boomHeaders[name];
      });

      if (addXFrame) {
        response.output.headers['X-Frame-Options'] = 'deny';
      }

      if (embedPolicy) {
        response.output.headers['Content-Security-Policy'] = embedPolicy;
      }
    }
    else if (response.header) {
      const headers = cacheControl.headersFor(request.path, response.statusCode, config.app);
      Object.keys(headers).forEach((name) => {
        response.header(name, headers[name]);
      });

      if (addXFrame) {
        response.header('X-Frame-Options', 'deny');
      }

      if (embedPolicy) {
        response.header('Content-Security-Policy', embedPolicy);
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
      // Behind a CDN/proxy the request host is the backend's own, not the
      // browser's — honour a forwarded host, but only one this deploy claims.
      response.source.context._hostname = publicHostname.resolve(
        request.headers,
        request.info.hostname,
        [config.app.url.hostname].concat(config.app.url.knownHosts || [])
      );
    }
    return h.continue;
  });

  // Session cookie plumbing, both directions (#286; SameSite/Secure are set on
  // the cookie by Yar's cookieOptions above, driven by sessionSecure).
  //
  // In: a cross-site LMS frame with third-party cookies blocked never stores
  // the session cookie, but it does store a `Partitioned` copy of it, same
  // name. Where the browser holds both, both arrive under one name; collapse
  // them to the first BEFORE hapi parses cookies (onRequest runs ahead of the
  // state step), so yar and every session-backed route work unchanged. See
  // lib/util/sessionCookie.js for why it is a same-named copy, not an attribute.
  //
  // Out: rewrite the session Set-Cookie at the raw response, which every
  // response path shares — a takeover in the Boom hook above or hapi's own
  // wrapping of a Boom replaces the hapi response object but not `raw.res`:
  //  - Expires: a year, on routes flagged `cookie: true` (routeParser), as before.
  //  - a partitioned copy of the session cookie on responses to navigations
  //    into a frame, whenever the cookie is Secure (`Partitioned` is invalid
  //    without it).
  server.ext('onRequest', (request, h) => {
    const sessionName = config.app.plugins.session.name || 'session';
    const single = sessionCookie.dedupe(request.headers.cookie, sessionName, (kept, dropped) => {
      log.info('[session] duplicate session cookies differ; kept the first', {
        path: request.path, kept: kept.slice(0, 12) + '…', dropped: dropped.slice(0, 12) + '…'
      });
    });
    if (single !== request.headers.cookie) {
      request.headers.cookie = single;
    }

    const res = request.raw && request.raw.res;
    if (res && typeof res.setHeader === 'function') {
      const setHeader = res.setHeader;
      const wantCopy = sessionSecure && sessionCookie.wantsCopy(request.headers);
      const sessionRe = new RegExp('^' + sessionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=');

      res.setHeader = function(key, value) {
        if (typeof key === 'string' && /^set-cookie$/i.test(key)) {
          value = [].concat(value);
          // request.cookie is set by routeParser during the handler, so read it here, not above.
          if (request.cookie) {
            const nextYear = new Date();
            nextYear.setFullYear(nextYear.getFullYear() + 1);
            value = value.map((v) => (sessionRe.test(v) && !/;\s*Expires=/i.test(v))
              ? v + "; Expires=" + nextYear.toUTCString() : v);
          }
          if (wantCopy) {
            value = value.concat(sessionCookie.partitionedCopies(value, sessionName));
          }
        }
        return setHeader.call(res, key, value);
      };
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
