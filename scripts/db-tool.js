#!/usr/bin/env node
/**
 * db-tool — local dev database management for the test stack.
 *
 * Usage (run inside the app container so it has deps + the DB connection):
 *   docker exec trinket node scripts/db-tool.js stats
 *   docker exec trinket node scripts/db-tool.js drop
 *   docker exec trinket node scripts/db-tool.js seed  <email|username>
 *   docker exec trinket node scripts/db-tool.js clear <email|username>
 *
 * Commands:
 *   stats  — print document counts per collection
 *   drop   — wipe the whole database (re-login afterward to recreate your user)
 *   seed   — create sample trinkets, a folder, and a course owned by the user
 *   clear  — delete just that user's trinkets/folders/courses/lessons/materials
 *
 * Seeding uses the app's Mongoose models (not raw inserts) so slugs, defaults,
 * and back-refs are valid. The seed/clear logic is therefore backend-agnostic
 * and should port to the Firestore adapter with only the connection and the
 * backend-specific `drop`/`stats` (which hit collections directly) swapped out.
 */

var mongoose = require('mongoose');

require('../config/db');               // opens the mongoose connection (side-effect)
var User     = require('../lib/models/user');
var Trinket  = require('../lib/models/trinket');
var Folder   = require('../lib/models/folder');
var Course   = require('../lib/models/course');
var Lesson   = require('../lib/models/lesson');
var Material = require('../lib/models/material');
var File     = require('../lib/models/file');

// app.js exposes the models as globals, and several model methods reference
// them (e.g. Folder.deleteFolder -> User/Trinket, Course.addUser -> User).
// Mirror that here so those methods work in this standalone script.
global.User = User; global.Trinket = Trinket; global.Folder = Folder;
global.Course = Course; global.Lesson = Lesson; global.Material = Material;
global.File = File;

var cmd   = process.argv[2];
var login = process.argv[3];

// Collections counted by `stats` and emptied (per-owner) by `clear`.
var OWNED_COLLECTIONS = ['snippets', 'folders', 'courses', 'lessons', 'materials'];
var ALL_COLLECTIONS   = ['users'].concat(OWNED_COLLECTIONS).concat(['exports']);

function usage() {
  console.log('Usage: node scripts/db-tool.js <stats|drop|seed|clear> [email|username]');
}

function findUser(loginValue) {
  return new Promise(function(resolve, reject) {
    if (!loginValue) return reject(new Error('this command needs an <email|username>'));
    // findByLogin matches email or username
    User.findByLogin(String(loginValue).toLowerCase(), function(err, user) {
      if (err) return reject(err);
      if (!user) return reject(new Error('user not found: ' + loginValue));
      resolve(user);
    });
  });
}

// ─── stats ───────────────────────────────────────────────────────────────────
function stats() {
  var db = mongoose.connection.db;
  return Promise.all(ALL_COLLECTIONS.map(function(name) {
    return db.collection(name).countDocuments({})
      .then(function(n) { return { name: name, n: n }; })
      .catch(function() { return { name: name, n: '(n/a)' }; });
  })).then(function(rows) {
    rows.forEach(function(r) { console.log(pad(r.name, 12) + r.n); });
  });
}

function pad(s, n) { while (s.length < n) s += ' '; return s; }

// ─── drop (backend-specific) ───────────────────────────────────────────────────
function drop() {
  return mongoose.connection.db.dropDatabase()
    .then(function() { console.log('dropped database "' + mongoose.connection.name + '"'); });
}

// ─── clear one user's data ─────────────────────────────────────────────────────
function clear() {
  return findUser(login).then(function(user) {
    var db = mongoose.connection.db;
    return Promise.all(OWNED_COLLECTIONS.map(function(name) {
      return db.collection(name).deleteMany({ _owner: user._id })
        .then(function(res) { return { name: name, n: res.deletedCount }; });
    })).then(function(rows) {
      console.log('cleared data for ' + (user.username || user.email) + ':');
      rows.forEach(function(r) { console.log('  ' + pad(r.name, 12) + r.n); });
    });
  });
}

// ─── seed sample data for a user ───────────────────────────────────────────────
function makeTrinket(user, spec) {
  var t = new Trinket({
    name        : spec.name,
    description : spec.description,
    lang        : spec.lang,
    code        : spec.code,
    _owner      : user.id,
    _creator    : user.id
  });
  return t.save();
}

function makeFolder(user, name) {
  var folder = new Folder({ name: name });
  folder.setOwner(user);
  folder.ownerSlug = user.username;
  return folder.save().then(function(saved) {
    return user.grant('folder-owner', 'folder', { id: saved.id }).then(function() { return saved; });
  });
}

function addToFolder(folder, trinket, user) {
  return folder.addTrinket(trinket, user).then(function() {
    trinket.folder = {
      folderId   : folder.id,
      name       : folder.name,
      folderSlug : folder.slug,
      ownerSlug  : folder.ownerSlug
    };
    return trinket.save();
  });
}

function makeCourse(user, assignmentTrinket) {
  var course = new Course({ name: 'Sample Course', ownerSlug: user.username });
  course.setOwner(user);
  return course.save()
    .then(function(saved) { return saved.addUser(user, ['course-owner']).then(function() { return saved; }); })
    .then(function(savedCourse) {
      var lesson = new Lesson({ name: 'Intro' });
      lesson.setOwner(user);
      return lesson.save().then(function(savedLesson) {
        var page = new Material({ name: 'Welcome', content: '# Welcome\n\nThis is a seeded page.', type: 'page', _owner: user.id });
        page.setOwner(user);

        var assignment = new Material({ name: 'First Assignment', content: 'Do the thing.', type: 'assignment', _owner: user.id });
        assignment.setOwner(user);
        assignment.trinket = {
          trinketId : assignmentTrinket.id,
          name      : assignmentTrinket.name,
          shortCode : assignmentTrinket.shortCode,
          lang      : assignmentTrinket.lang
        };

        return page.save()
          .then(function(p) { return assignment.save().then(function(a) { return [p, a]; }); })
          .then(function(mats) {
            savedLesson.materials.push(mats[0].id, mats[1].id);
            return savedLesson.save();
          })
          .then(function() {
            savedCourse.lessons.push(savedLesson.id);
            return savedCourse.save();
          });
      }).then(function() { return savedCourse; });
    });
}

function seed() {
  return findUser(login).then(function(user) {
    var trinkets;
    return Promise.all([
      makeTrinket(user, { name: 'Hello Python', lang: 'python',     description: '# Hello\n\nRun me.',            code: 'print("hello from python")\n' }),
      makeTrinket(user, { name: 'redSphere',    lang: 'glowscript', description: '**Click RUN** to see a sphere', code: 'GlowScript 3.2 VPython\nsphere(color=color.red)\n' }),
      makeTrinket(user, { name: 'A Page',       lang: 'html',       description: 'A simple page',                 code: '<h1>Hello</h1>\n' })
    ]).then(function(saved) {
      trinkets = saved;
      return makeFolder(user, 'Samples');
    }).then(function(folder) {
      // put the first two trinkets in the folder
      return addToFolder(folder, trinkets[0], user)
        .then(function() { return addToFolder(folder, trinkets[1], user); });
    }).then(function() {
      return makeCourse(user, trinkets[0]);
    }).then(function() {
      console.log('seeded for ' + (user.username || user.email) + ':');
      console.log('  3 trinkets (python, glowscript, html)');
      console.log('  1 folder "Samples" containing 2 trinkets');
      console.log('  1 course "Sample Course" (lesson + page + assignment)');
    });
  });
}

// ─── dispatch ──────────────────────────────────────────────────────────────────
var COMMANDS = { stats: stats, drop: drop, seed: seed, clear: clear };

function run() {
  var fn = COMMANDS[cmd];
  if (!fn) { usage(); process.exit(cmd ? 1 : 0); }
  fn()
    .then(function() { process.exit(0); })
    .catch(function(err) { console.error('Error:', err.message || err); process.exit(1); });
}

if (mongoose.connection.readyState === 1) run();
else mongoose.connection.once('open', run);

mongoose.connection.on('error', function(err) {
  console.error('MongoDB connection error:', err.message);
  process.exit(1);
});
