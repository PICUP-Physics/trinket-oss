#!/usr/bin/env node
//
// scripts/seed-test-course.js — create a throwaway owner + course in the emulator, for use as an
// LTI launch target (custom param trinket_course=<id>). Run in-container:
//   docker exec trinket-gcr node /usr/local/node/trinket/scripts/seed-test-course.js ["Course Name"]
'use strict';

var projectId = process.env.GOOGLE_CLOUD_PROJECT || 'demo-trinket';
process.env.NODE_CONFIG = process.env.NODE_CONFIG ||
  JSON.stringify({ db: { backend: 'firestore', firestore: { projectId: projectId } } });

global.User     = require('../lib/models/user');
global.Course   = require('../lib/models/course');
global.Lesson   = require('../lib/models/lesson');
global.Material = require('../lib/models/material');
global.Trinket  = require('../lib/models/trinket');
global.File     = require('../lib/models/file');

var name = process.argv[2] || ('LTI Test Course ' + Date.now().toString(36));

(async function () {
  var tag = Date.now().toString(36);
  var owner = new User({ email: 'lti-owner-' + tag + '@local.test', username: 'ltiowner' + tag, fullname: 'LTI Test Owner', approved: true, source: 'seed', verified: true });
  await owner.save();
  var course = new Course({ name: name, description: 'LTI launch target', ownerSlug: owner.username });
  course.setOwner(owner);
  await course.save();

  console.log('Created course:');
  console.log('  trinket_course (custom param) = ' + course.id);
  console.log('  name                          = ' + course.name);
  console.log('  landing path                  = /' + owner.username + '/courses/' + course.slug);
  process.exit(0);
})().catch(function (e) { console.error('seed error:', e && e.stack || e); process.exit(1); });
