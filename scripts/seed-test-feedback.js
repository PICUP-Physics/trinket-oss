#!/usr/bin/env node
//
// scripts/seed-test-feedback.js
//
// Seeds a course with five students and one assignment so you can test the
// Feedback CSV export without going through signup → enroll → submit by hand.
//
// Usage (from the host, with the Firestore emulator running on 127.0.0.1:8080):
//
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
//   FIRESTORE_PROJECT_ID=demo-trinket \
//   INSTRUCTOR_EMAIL=you@example.com \
//   node scripts/seed-test-feedback.js
//
// INSTRUCTOR_EMAIL is the address you will sign in with via Firebase Auth.
// The seeded instructor record gets linked to your Firebase UID on first login
// (see lib/controllers/auth.js — email fallback when firebaseUid is empty).
//
// Output: prints courseId, materialId, course slug, and the direct CSV URL.

'use strict';

// Use 127.0.0.1, not localhost — Node prefers IPv6 (::1) and the emulator only binds IPv4.
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';

// Tell node-config we're using Firestore with a local-emulator project id.
// Merges with default.yaml so we don't have to enumerate everything.
var projectId = process.env.FIRESTORE_PROJECT_ID || 'demo-trinket';
process.env.NODE_CONFIG = process.env.NODE_CONFIG ||
  JSON.stringify({ db: { backend: 'firestore', firestore: { projectId: projectId } } });

var crypto = require('crypto');

// Models register themselves with the backend on require.
// They also reference each other via implicit globals set by app.js, so
// expose them the same way before any instance methods (save, grant) are called.
User     = global.User     = require('../lib/models/user');
Course   = global.Course   = require('../lib/models/course');
Lesson   = global.Lesson   = require('../lib/models/lesson');
Material = global.Material = require('../lib/models/material');
Trinket  = global.Trinket  = require('../lib/models/trinket');

var INSTRUCTOR_EMAIL = (process.env.INSTRUCTOR_EMAIL || 'test-instructor@example.com').toLowerCase();
var STUDENT_COUNT    = 5;

function shortCode() { return crypto.randomBytes(4).toString('hex'); }
function tag()       { return crypto.randomBytes(3).toString('hex'); }

async function ensureUser(spec) {
  var existing = await User.findOne({ email: spec.email });
  if (existing) return existing;
  var user = new User(spec);
  await user.save();
  return user;
}

async function main() {
  var runTag = tag();
  console.log('Seeding with tag', runTag);

  // 1. Instructor (linked to your Firebase login by email on first sign-in).
  var instructor = await ensureUser({
    email:        INSTRUCTOR_EMAIL,
    fullname:     'Test Instructor',
    username:     'test-instructor-' + runTag,
    approved:     true,
    isInstructor: true,
    verified:     true,
    source:       'firebase'
  });

  // 2. Five students. Mix of submission states is wired up below.
  var students = [];
  for (var i = 1; i <= STUDENT_COUNT; i++) {
    var s = await ensureUser({
      email:    'test-student-' + i + '-' + runTag + '@example.com',
      fullname: 'Student ' + i,
      username: 'test-student-' + i + '-' + runTag,
      approved: true,
      verified: true,
      source:   'firebase'
    });
    students.push(s);
  }

  // 3. Course owned by the instructor. ownerSlug is required by the schema.
  var course = new Course({
    name:        'CSV Export Test Course (' + runTag + ')',
    description: 'Seeded by scripts/seed-test-feedback.js',
    _owner:      instructor.id,
    ownerSlug:   instructor.username
  });
  await course.save();

  // Enroll everyone. addUser grants the course role on the User doc too.
  await course.addUser(instructor, ['course-owner']);
  for (var j = 0; j < students.length; j++) {
    await course.addUser(students[j], ['course-student']);
  }

  // 4. Lesson + assignment material wired into the course.
  var lesson = new Lesson({ name: 'Lesson 1', _owner: instructor.id });
  await lesson.save();

  var material = new Material({
    name:   'Assignment 1',
    type:   'assignment',
    _owner: instructor.id
  });
  await material.save();

  await Lesson.findByIdAndUpdate(lesson.id, { $push: { materials: material.id } }, { new: true });
  await Course.findByIdAndUpdate(course.id, { $push: { lessons: lesson.id } }, { new: true });

  // 5. Submission trinkets — one per student, exercising each CSV branch.
  //    student 1: submitted + final feedback comment       → row with feedback
  //    student 2: submitted + DRAFT feedback only          → row, blank feedback
  //    student 3: submitted, no feedback at all            → row, blank feedback
  //    student 4: started (modified), never submitted      → row, state=started
  //    student 5: no trinket at all                        → row, state=not-started
  var now = new Date();

  function commentBy(author, text, type) {
    return {
      userId:      author.id,
      username:    author.username,
      displayName: author.fullname,
      email:       author.email,
      commentText: text,
      commentType: type,
      commented:   new Date()
    };
  }

  async function submission(student, opts) {
    var t = new Trinket({
      lang:            'python',
      code:            opts.code || 'print("hello from ' + student.username + '")',
      shortCode:       shortCode(),
      _owner:          student.id,
      _creator:        student.id,
      courseId:        course.id,
      materialId:      material.id,
      submissionState: opts.state,
      startedOn:       opts.startedOn || now,
      submittedOn:     opts.submittedOn || null,
      lastUpdated:     opts.lastUpdated || now,
      comments:        opts.comments || []
    });
    await t.save();
    return t;
  }

  await submission(students[0], {
    state:       'submitted',
    submittedOn: now,
    comments: [ commentBy(instructor, 'Great work, the loop is correct.', 'feedback') ]
  });
  await submission(students[1], {
    state:       'submitted',
    submittedOn: now,
    comments: [ commentBy(instructor, 'Draft — do not show in CSV.', 'feedback-draft') ]
  });
  await submission(students[2], {
    state:       'submitted',
    submittedOn: now
  });
  await submission(students[3], {
    state: 'modified'  // appears as "started" in the export
  });
  // student 4 (index): no trinket.

  console.log('');
  console.log('Seeded:');
  console.log('  Course id:    ' + course.id);
  console.log('  Material id:  ' + material.id);
  console.log('  Instructor:   ' + instructor.email + ' (' + instructor.username + ')');
  console.log('');
  console.log('Sign in with ' + INSTRUCTOR_EMAIL + ' via Firebase, then visit:');
  console.log('  http://localhost:3001/api/courses/' + course.id +
              '/materials/' + material.id + '/feedback.csv');
  console.log('');
  console.log('Or browse the dashboard:');
  console.log('  http://localhost:3001/u/' + instructor.username +
              '/classes/' + course.slug);
}

main()
  .then(function() { process.exit(0); })
  .catch(function(err) {
    console.error('seed failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
