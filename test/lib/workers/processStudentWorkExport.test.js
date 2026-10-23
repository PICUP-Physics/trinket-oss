'use strict';
// Lazily required in beforeAll (not at module top): lib/workers/exports.js
// pulls in config/app.config -> routes -> controllers -> @hapi/hapi. The
// global test setup (test/helpers/vitest-setup.cjs) boots app.js and applies
// required config fixups (redis disabled + mocked, session secret, etc.)
// inside its own beforeAll. A top-level require here would run at test-file
// collection time, BEFORE that setup runs, and hits real Redis + a
// hapi/@hapi-validate version-skew crash that only happens on that early,
// unconfigured path. See createSubmissionsArchive.test.js for the same note.
const nunjucks = require('nunjucks');
const config = require('config');
const mongoose = require('mongoose');
// Export isn't one of app.js's "global for backwards compatibility" model
// assignments (Course/Lesson/Material/User/Trinket are), so pull it in
// directly, same as createSubmissionsArchive.test.js.
const Export = require('../../../lib/models/export');
// config/aws.js hands out S3 clients through s3Client(); stubbing that (see
// below) swaps in a fake client without touching lib/workers/exports.js.
const aws = require('../../../config/aws');

let exportsQueue;

beforeAll(() => {
  // This file tests the WORKER-process behaviour (the queue dispatch branch),
  // so it has to declare itself a worker: registration is now conditional on
  // RUN_EXPORT_WORKER, because lib/controllers/course.js require()s this module
  // to run student-work exports in-request and must NOT thereby register a
  // handler (that would make exportGuard let the account bulk export enqueue
  // into work that runs after the response, when Cloud Run throttles CPU).
  process.env.RUN_EXPORT_WORKER = 'true';
  // Side-effecting require: registers exportsQueue.process(...) (including
  // the 'student-work-export' dispatch branch under test) and the
  // 'failed'/'completed' queue listeners — see lib/workers/exports.js's own
  // header comment for why nothing is normally destructured from it.
  require('../../../lib/workers/exports');
  exportsQueue = require('../../../lib/util/queues').exports();

  // config.aws.buckets.exports is deploy-specific (filled in by a gitignored
  // local-production.yaml overlay in real deploys) and isn't set by
  // config/default.yaml or config/test.yaml. uploadToS3 reads
  // config.aws.buckets.exports.name/.host directly, so without this it
  // throws "Cannot read properties of undefined" before ever reaching the
  // (stubbed) S3 call.
  config.aws.buckets.exports = {
    name: 'test-exports-bucket',
    host: 'https://fake-exports.example.com'
  };
});

let putObjectMock;
let uploadedZip;
let uploadReadError;
let s3Spy;
let nunjucksRenderSpy;

beforeEach(() => {
  // Stub the S3 upload at the client seam: uploadToS3() goes through
  // lib/util/storage-backend, whose S3 backend gets its client from
  // config/aws.js's s3Client(). The fake client receives the SDK v3 command;
  // its input carries the PutObject params.
  uploadedZip = null;        // never let one test satisfy the next test's assertion
  uploadReadError = null;
  putObjectMock = vi.fn(function(params) {
    // Keep the bytes: asserting "an archive was uploaded" is not the same
    // as asserting the students' work is inside it. A seeding mistake that
    // produced EMPTY files passed every other assertion in this file.
    try { uploadedZip = require('fs').readFileSync(params.Body.path); }
    catch (e) { uploadedZip = null; uploadReadError = e; }
    return Promise.resolve({});
  });
  s3Spy = vi.spyOn(aws, 's3Client').mockImplementation(function() {
    return { send: function(command) { return putObjectMock(command.input); } };
  });

  // The worker only calls nunjucks.configure() when !config.isTest; in test
  // mode the module-level nunjucks.render() (used by sendCompletionEmail/
  // sendFailureEmail) has no loader configured and throws "template not
  // found", which would flip a genuinely-successful export to 'failed' at
  // the email step. Same stub test/lib/api/forgot_pass.test.js uses for the
  // password-reset email.
  nunjucksRenderSpy = vi.spyOn(nunjucks, 'render').mockReturnValue('<html>stub</html>');
});

afterEach(() => {
  s3Spy.mockRestore();
  nunjucksRenderSpy.mockRestore();
});

// The in-memory queue (redis disabled in tests — lib/util/queues.js) processes
// jobs via setImmediate and doesn't expose a promise that resolves when the
// handler finishes, so there's nothing to directly await after .add(). Poll
// the Export record instead until the worker's finalize (or fail) path has
// written a terminal status.
async function waitForExportSettled(exportId, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 5000);
  for (;;) {
    var record = await Export.findById(exportId);
    if (record && (record.status === 'completed' || record.status === 'failed')) {
      return record;
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for export ' + exportId + ' to settle');
    }
    await new Promise(function(resolve) { setTimeout(resolve, 20); });
  }
}

describe('student-work-export queue action / processStudentWorkExport', () => {
  let owner, student1, course, material;

  beforeEach(async () => {
    owner = new User({ fullname: 'Prof Owner', username: 'profowner', email: 'profowner@example.com', password: 'password' });
    await owner.save();

    student1 = new User({ fullname: 'Jane Student', username: 'janestudent', email: 'jane@example.com', password: 'password' });
    await student1.save();

    const promptTrinket = new Trinket({
      name: 'Assignment Prompt', lang: 'python3', code: 'print("prompt")',
      _owner: owner, _creator: owner
    });
    await promptTrinket.save();

    material = new Material({
      name: 'HW1', type: 'assignment', _owner: owner,
      trinket: {
        trinketId: promptTrinket.id,
        name: promptTrinket.name,
        shortCode: promptTrinket.shortCode,
        lang: promptTrinket.lang
      }
    });
    await material.save();

    const lesson = new Lesson({ name: 'Lesson 1', _owner: owner, materials: [material.id] });
    await lesson.save();

    course = new Course({ name: 'Physics 101', _owner: owner, ownerSlug: owner.username, lessons: [lesson.id] });
    await course.save();
    await course.addUser(owner, ['course-owner']);
    await course.addUser(student1, ['course-student']);

    const sub1 = new Trinket({
      name: 'Jane Submission', lang: 'python3', code: 'print("jane")',
      _owner: student1, _creator: student1,
      courseId: course.id, materialId: material.id,
      submissionState: 'submitted', submittedOn: new Date(),
      comments: [{ commentType: 'feedback', commentText: 'nice', commented: new Date(), displayName: 'Prof Owner' }]
    });
    await sub1.save();
  });

  it('dispatches to processStudentWorkExport, builds+uploads the archive, and marks the Export completed', async () => {
    const exportRecord = new Export({ _owner: owner, type: 'course-submissions', courseId: course.id, status: 'pending' });
    await exportRecord.save();

    await exportsQueue.add({ action: 'student-work-export', exportId: exportRecord.id, userId: owner.id });

    const settled = await waitForExportSettled(exportRecord.id);

    expect(settled.status).toBe('completed');
    expect(settled.s3Key).toMatch(new RegExp('^exports/' + owner.id + '/student-work-[0-9a-f]{12}\\.zip$'));
    expect(settled.downloadUrl).toBe('https://fake-exports.example.com/' + settled.s3Key);
    expect(settled.progress.processed).toBeGreaterThanOrEqual(1);
    expect(settled.trinketCount).toBeGreaterThanOrEqual(1);
    expect(settled.fileSize).toBeGreaterThan(0);
    expect(settled.expiresAt).toBeTruthy();

    expect(putObjectMock).toHaveBeenCalledTimes(1);
  });

  it('puts the students actual work inside the archive', async () => {
    const AdmZip = require('adm-zip');

    const exportRecord = new Export({ _owner: owner, type: 'course-submissions', courseId: course.id, status: 'pending' });
    await exportRecord.save();
    await exportsQueue.add({ action: 'student-work-export', exportId: exportRecord.id, userId: owner.id });
    await waitForExportSettled(exportRecord.id);

    expect(uploadedZip, 'the upload should have carried bytes' +
      (uploadReadError ? ' (capture failed: ' + uploadReadError.message + ')' : '')).toBeTruthy();
    const zip = new AdmZip(uploadedZip);
    const entries = zip.getEntries().map((e) => e.entryName);

    // One folder per student, plus the prompt and a manifest.
    expect(entries).toContain('manifest.json');
    expect(entries.some((n) => /_assignment\//.test(n))).toBe(true);

    // The manifest must agree with what the folders claim.
    const manifest = JSON.parse(zip.getEntry('manifest.json').getData().toString('utf8'));
    expect(JSON.stringify(manifest)).toMatch(/janestudent/);

    const code = entries.find((n) => /janestudent\/main\.py$/.test(n));
    expect(code, 'the student should have a code file: ' + entries.join(', ')).toBeTruthy();

    const body = zip.getEntry(code).getData().toString('utf8');
    expect(body, 'an empty file here means the export shipped nothing useful').toContain('print("jane")');

    const submission = JSON.parse(zip.getEntry(entries.find((n) => /janestudent\/submission\.json$/.test(n))).getData().toString('utf8'));
    expect(submission.state).toBe('submitted');
  });

  it('marks the Export failed (with errorMessage) when the course cannot be found, without touching S3', async () => {
    // The firestore backend stores ObjectId ref fields as string ids; a raw
    // ObjectId value fails to serialize on save (see export.test.js). Use its
    // string form — still a well-formed, non-existent id.
    const bogusCourseId = new mongoose.Types.ObjectId().toString();
    const exportRecord = new Export({ _owner: owner, type: 'course-submissions', courseId: bogusCourseId, status: 'pending' });
    await exportRecord.save();

    await exportsQueue.add({ action: 'student-work-export', exportId: exportRecord.id, userId: owner.id });

    const settled = await waitForExportSettled(exportRecord.id);

    expect(settled.status).toBe('failed');
    expect(settled.errorMessage).toMatch(/Course not found/);
    expect(putObjectMock).not.toHaveBeenCalled();
  });
});
