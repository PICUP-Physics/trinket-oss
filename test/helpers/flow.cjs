// API/auth flow harness on Hapi's native server.inject (CommonJS, promise-based).
//
// Reuses the per-file booted server from the 2a harness (vitest-setup.cjs boots
// `require('../../app.js')`, whose module.exports is the serverPromise resolving
// to the running Hapi server). This harness awaits that same server and issues
// requests via server.inject() — no listener, no port, parallel-file safe.
//
// It keeps a per-user cookie jar (capturing `set-cookie`, replaying it on later
// requests) and the legacy state surface the tests read (lastResponse/wasOk/
// lastRedirect/lastContentType/activeUser/switchUser). Every request method
// returns a promise (await-able) instead of taking a callback.

// Disable node-config's runtime.json change-persistence BEFORE config is first
// required (./defaults requires it). Rendering an HTML view (e.g. /home) leaves
// the compiled nunjucks Environment reachable from the watched config tree;
// node-config's deferred JSON.stringify of that tree then throws "Converting
// circular structure to JSON" as an unhandled rejection, which fails the run
// even though every test passes. This is a no-op for app runtime config values.
process.env.NODE_CONFIG_PERSIST_ON_CHANGE = 'N';

var url      = require('url');
var path     = require('path');
var fs       = require('fs');
var querystring = require('querystring');
var FormData = require('form-data');
var defaults = require('./defaults');

var config;
try { config = require('config'); } catch (e) { config = {}; }

var _server;
async function getServer() {
  // app.js exports the init() promise; it resolves to the Hapi server.
  if (!_server) {
    _server = await require('../../app.js');
    // In the test config the listener is never started (config.app.start is
    // false → no server.start()), so Hapi never starts its caches. The session
    // store is a catbox engine (catbox-mongoose) whose client stays
    // "Disconnected" until cache startup runs, making every yar session op
    // throw. server.initialize() runs the full startup sequence — including
    // cache.start() — WITHOUT binding a port, which is exactly what inject()
    // needs and keeps parallel test files port-collision free.
    try {
      await _server.initialize();
    } catch (e) {
      // Already initialized/started (e.g. config.app.start was true) — fine.
      if (!/Cannot initialize server while it is/i.test(String(e && e.message))) {
        throw e;
      }
    }
  }
  return _server;
}

// set-cookie is an array of "name=value; Path=/; HttpOnly; ..." — for the
// replayed request `cookie` header we keep only the "name=value" pairs.
function cookieHeader(setCookie) {
  return (setCookie || []).map(function (c) { return c.split(';')[0]; }).join('; ');
}

var flow = {
  activeUser    : 'user',
  cookies       : {},      // { [user]: setCookieArray }
  lastResponse  : null,
  lastError     : null,
  wasOk         : false,
  lastRedirect  : null,
  lastContentType : null,

  // Core: map a Hapi inject result onto the legacy response shape the tests read.
  async _inject(method, path, payload) {
    var server = await getServer();
    var headers = { referer: (config && config.url) || '' };
    if (this.cookies[this.activeUser]) {
      headers.cookie = cookieHeader(this.cookies[this.activeUser]);
    }
    var opts = { method: method, url: path, headers: headers };
    if (payload !== undefined) opts.payload = payload;

    try {
      var res = await server.inject(opts);
    } catch (err) {
      this.lastError = err;
      this.wasOk = false;
      throw err;
    }

    return this._record(res);
  },

  // Map a Hapi inject result onto the legacy response shape the tests read.
  // Shared by the JSON (_inject) and multipart (injectMultipart) paths.
  _record(res) {
    // Persist the session cookie for the active user across injects.
    if (res.headers['set-cookie']) {
      this.cookies[this.activeUser] = res.headers['set-cookie'];
    }

    this.lastResponse = {
      statusCode : res.statusCode,
      headers    : res.headers,
      body       : res.result,   // parsed
      text       : res.payload,  // raw
      redirect   : res.statusCode >= 300 && res.statusCode < 400,
    };
    this.lastError       = null;
    this.wasOk           = true;
    this.lastContentType = res.headers['content-type'];
    this.lastRedirect    = res.headers.location ? url.parse(res.headers.location) : null;

    return this.lastResponse;
  },

  // Multipart upload over server.inject: build a fully-encoded multipart body
  // with form-data, then pass its buffer + headers (plus the active cookie)
  // to inject. supertest's .field()/.attach() aren't available without a port.
  async injectMultipart(urlPath, type, filePath) {
    var form = new FormData();
    if (type !== undefined) form.append('type', type);
    form.append('upload', fs.readFileSync(filePath), { filename: path.basename(filePath) });

    var server = await getServer();
    var headers = form.getHeaders();
    if (this.cookies[this.activeUser]) {
      headers.cookie = cookieHeader(this.cookies[this.activeUser]);
    }

    try {
      var res = await server.inject({
        method  : 'POST',
        url     : urlPath,
        payload : form.getBuffer(),
        headers : headers,
      });
    } catch (err) {
      this.lastError = err;
      this.wasOk = false;
      throw err;
    }

    return this._record(res);
  },

  // --- generic verbs ---
  get(p)        { return this._inject('GET', p); },
  post(p, body) { return this._inject('POST', p, body); },
  put(p, body)  { return this._inject('PUT', p, body); },
  del(p)        { return this._inject('DELETE', p); },

  // --- ported request methods (one per legacy flow method) ---
  register(body) {
    var data = defaults.extend(body || {}, 'user');
    if (!data.formName) data.formName = 'signup';
    return this.post('/users', defaults.extend(data, 'recaptcha'));
  },

  index()        { return this.get('/'); },
  login(body)    { return this.post('/login', defaults.extend(body || {}, 'login')); },
  viewCourse(user, course) { return this.get('/u/' + user + '/classes/' + course); },
  logout()       { return this.get('/logout'); },
  welcome()      { return this.get('/welcome'); },
  home()         { return this.get('/home'); },
  admin()        { return this.get('/admin/users'); },

  sendPassReset(body) {
    return this.post('/send-pass-reset', defaults.extend(body || {}, 'recaptcha'));
  },
  resetPassForm(query) { return this.get('/reset-pass?key=' + query); },
  savePass(body)       { return this.post('/save-pass', body || {}); },

  updateProfile(userId, profile) { return this.put('/api/users/' + userId, profile); },

  createCourse(body) { return this.post('/api/courses', defaults.extend(body || {}, 'course')); },
  deleteCourse(courseId) { return this.del('/api/courses/' + courseId); },
  copyCourse(courseId, body) { return this.post('/api/courses/' + courseId + '/copy', body); },
  updateCourse(courseId, body) { return this.put('/api/courses/' + courseId + '/metadata', body); },
  updateLesson(courseId, lessonId, body) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/name', body);
  },
  getCourse(id) { return this.get('/api/courses/' + id); },
  getCourseBySlug(userSlug, courseSlug) { return this.get('/u/' + userSlug + '/classes/' + courseSlug); },
  getCourseWithOutline(id) { return this.get('/api/courses/' + id + '?outline=yes'); },
  downloadCourse(u) { return this.get(u); },

  addNewLesson(courseId, body) {
    return this.post('/api/courses/' + courseId + '/lessons', defaults.extend(body || {}, 'lesson'));
  },
  getLesson(courseId, lessonId) { return this.get('/api/courses/' + courseId + '/lessons/' + lessonId); },
  moveLesson(courseId, lessonId, index) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/move', { index: index });
  },
  deleteLesson(courseId, lessonId) { return this.del('/api/courses/' + courseId + '/lessons/' + lessonId); },

  addNewMaterial(courseId, lessonId, body) {
    return this.post('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials',
      defaults.extend(body || {}, 'material'));
  },
  updateMaterial(courseId, lessonId, materialId, body) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId + '/name', body);
  },
  patchMaterialContent(courseId, lessonId, materialId, body) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId + '/patchContent', body);
  },
  deleteMaterial(courseId, lessonId, materialId) {
    return this.del('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId);
  },
  moveMaterial(courseId, lessonId, materialId, index) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId + '/move', { index: index });
  },
  getMaterial(courseId, lessonId, materialId) {
    return this.get('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId);
  },
  markMaterialDraft(courseId, lessonId, materialId) {
    return this.put('/api/courses/' + courseId + '/lessons/' + lessonId + '/materials/' + materialId + '/draft', { isDraft: true });
  },

  uploadFile()  { return this.injectMultipart('/file', defaults.file.type, defaults.file.upload); },
  uploadIpynb() { return this.injectMultipart('/file', defaults.ipynb.type, defaults.ipynb.upload); },

  downloadFile(fileId) { return this.get('/api/files/' + fileId + '/download'); },

  createTrinket() { return this.post('/api/trinkets', defaults.trinket); },
  getTrinket(trinketHash, lang) { return this.get('/' + lang + '/' + trinketHash); },
  getEmbeddedTrinket(trinketId, lang, query) {
    var u = '/embed/' + lang + '/' + trinketId;
    if (query && query.length) u += '?' + querystring.stringify(query);
    return this.get(u);
  },
  emailTrinket(trinketId, body) {
    return this.post('/api/trinkets/' + trinketId + '/email', defaults.extend(body || {}, 'recaptcha'));
  },
  runTrinket(trinketId) { return this.put('/api/trinkets/' + trinketId + '/metrics', { runs: true }); },
  forkTrinket(parentTrinketId, trinketData) {
    return this.post('/api/trinkets/' + parentTrinketId + '/forks', trinketData);
  },
  snapshotTrinket(trinketId) { return this.post('/api/trinkets/' + trinketId + '/snapshot'); },
  trinketRunError() { return this.post('/api/trinkets/codeerror', defaults.trinketRunError); },

  subscribe(list, email) { return this.post('/api/subscriptions/' + list, { email: email }); },
  unsubscribe(list, email) { return this.del('/api/subscriptions/' + list + '?email=' + email); },
  getSubscriptions(list) { return this.get('/api/subscriptions/' + list); },

  // Set the active cookie jar to `user`, logging them in (creating the user if
  // needed) the first time. Empty string => an anonymous/unauthenticated jar.
  // Under the firebase-auth profile (TEST_AUTH_PROVIDER=firebase) the POST
  // /login form route doesn't exist; login mints an ID token from the Auth
  // emulator and exchanges it at POST /api/auth/session — the same seam the
  // FirebaseUI client uses in production.
  async switchUser(user) {
    this.activeUser = user;
    if (!user) return;             // anonymous: no login
    if (this.cookies[user]) return;

    var creds = { email: defaults[user].email, password: defaults[user].password };

    var doc = await new Promise(function (resolve, reject) {
      User.findByLogin(creds.email, function (err, d) { err ? reject(err) : resolve(d); });
    });
    if (!doc) {
      await new User(defaults[user]).save();
    }

    if (require('config').auth.provider === 'firebase') {
      var idToken = await firebaseIdToken(creds);
      var r2 = await this.post('/api/auth/session', { idToken: idToken });
      if (r2.statusCode !== 200) {
        throw new Error('Failed firebase session login for "' + user + '": ' +
          r2.statusCode + ' ' + (r2.body && JSON.stringify(r2.body).slice(0, 200)));
      }
      return;
    }

    var r = await this.login(creds);
    if (r.statusCode !== 302) {
      throw new Error('Failed to log in "' + user + '"');
    }
  },
};

// Mint an ID token from the Firebase AUTH emulator for (email, password).
// signUp first (fresh emulator/account), fall back to signInWithPassword when
// the account already exists within a test file. Fixture passwords can be
// shorter than Firebase's 6-char minimum, so the emulator account uses a
// derived password — it never has to match the local-auth bcrypt one.
async function firebaseIdToken(creds) {
  var base = 'http://' + process.env.FIREBASE_AUTH_EMULATOR_HOST +
             '/identitytoolkit.googleapis.com/v1/accounts:';
  var body = JSON.stringify({
    email: creds.email,
    password: 'emu-' + creds.password + '-000000',
    returnSecureToken: true
  });
  var opts = { method: 'POST', headers: { 'content-type': 'application/json' }, body: body };

  var res  = await fetch(base + 'signUp?key=fake-api-key', opts);
  var json = await res.json();
  if (json.error && /EMAIL_EXISTS/.test(json.error.message || '')) {
    res  = await fetch(base + 'signInWithPassword?key=fake-api-key', opts);
    json = await res.json();
  }
  if (!json.idToken) {
    throw new Error('Auth emulator gave no idToken: ' + JSON.stringify(json.error || json).slice(0, 300));
  }
  return json.idToken;
}

module.exports = flow;
