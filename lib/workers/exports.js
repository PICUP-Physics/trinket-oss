var exportsQueue = require('../util/queues').exports()
  , db           = require('../../config/db')
  , config       = require('../../config/app.config')
  , nunjucks     = require('nunjucks')
  , moment       = require('moment')
  , Q            = require('q')
  , fs           = require('fs')
  , path         = require('path')
  , url          = require('url')
  , crypto       = require('crypto')
  , archiver     = require('archiver')
  , mailer       = require('../util/mailer')
  , FileUtil     = require('../util/file')
  , Export       = require('../models/export')
  , User         = require('../models/user')
  , Trinket      = require('../models/trinket')
  , Course       = require('../models/course')
  , submissions  = require('../util/submissions')
  , mongoose     = require('mongoose')
  , env;

var EXPORT_EXPIRY_DAYS = 3;

// Run a model query as a promise, backend-agnostically. The old
// Q.nsend(model, method, ...args) form passed a node callback, which
// double-executes the query on mongoose 6 ("Query was already executed").
// Call the method with no callback, then resolve the result: Mongoose
// find/findOne return a Query (needs .exec()), while the Firestore backend's
// findById/findByIdAndUpdate/count return a promise directly (no .exec()).
function runQuery(model, method) {
  var args = Array.prototype.slice.call(arguments, 2);
  var result = model[method].apply(model, args);
  return Q(result && typeof result.exec === 'function' ? result.exec() : result);
}

var langExtensions = {
  'python'     : '.py',
  'pyodide'    : '.py',
  'python3'    : '.py',
  'pygame'     : '.py',
  'html'       : '.html',
  'java'       : '.java',
  'R'          : '.R',
  'glowscript' : '.py',
  'blocks'     : '.xml',
  'console'    : '.py',
  'music'      : '.py',
  'skulpt'     : '.py'
};

// Download a user asset through the deploy's storage backend (S3 or GCS).
function downloadAsset(assetUrl) {
  var parsed = url.parse(assetUrl);
  var filename = path.basename(parsed.pathname);
  return Q(require('../util/storage-backend').downloadBuffer(config.aws.buckets.userassets.name, filename));
}

exportsQueue.on('error', function(err) {
  console.log('exports queue error:', err);
});

exportsQueue.on('failed', function(job, err) {
  console.log('exports failed job:', job.jobId, job.data);
  console.log('exports failed err:', err);

  if (job.data.exportId) {
    Export.findByIdAndUpdate(job.data.exportId, {
      status: 'failed',
      errorMessage: err.message || 'Unknown error'
    }, function() {});
  }
});

exportsQueue.on('completed', function(job, result) {
  job.remove();
});

// Register the queue handler ONLY when this process is meant to be a worker.
//
// app.js already require()s this module solely under that flag, so this is a
// no-op there. It matters because the module is now ALSO require()d by
// lib/controllers/course.js, which runs student-work exports inline (in-request)
// and just wants the function. Registering on any require would make
// queue.hasHandlers() true for every process, and exportGuard would then let the
// account bulk export enqueue into a handler that runs via setImmediate AFTER
// the response — precisely when Cloud Run throttles CPU. A clean refusal would
// have become a silent stall.
if (process.env.RUN_EXPORT_WORKER === 'true') {
  exportsQueue.process(function(job) {
    var action = job.data.action;

    if (action === 'bulk-export') {
      return processBulkExport(job);
    }
    else if (action === 'student-work-export') {
      return processStudentWorkExport(job);
    }
    else {
      return Promise.reject(new Error('Unknown action: ' + action));
    }
  });
}

// ⚠️ MONGOOSE-ONLY PATH. Unlike the student-work export below, this one still
// reaches for the raw model (`X.model || mongoose.model(...)`) because it needs
// Mongoose-specific APIs the public model layer does not offer: a `.count()`
// and a `.find().select().cursor()` stream over every trinket a user owns.
//
// Note what that fallback actually does in production: `X.model` is only
// exposed under NODE_ENV=test/migration (lib/models/model.js), so a deployed
// server ALWAYS takes the mongoose branch — fine on compose, fatal on a
// firestore deploy where no mongoose connection exists. The account bulk export
// is refused on such deploys anyway (exportGuard), so this stays as-is rather
// than being half-converted into something that looks portable but is not.
function processBulkExport(job) {
  var exportId = job.data.exportId
    , userId   = job.data.userId
    , exportRecord
    , user
    , tempFile
    , s3Key
    , filename;

  // Generate unique filename
  var timestamp = Date.now();
  var hash = crypto.createHash('sha1')
    .update(userId + timestamp.toString())
    .digest('hex')
    .substring(0, 12);

  filename = 'trinket-export-' + hash + '.zip';
  tempFile = '/tmp/' + filename;
  s3Key = 'exports/' + userId + '/' + filename;

  if (!config.isTest) {
    env = nunjucks.configure(config.app.templates);
  }

  return runQuery(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, { status: 'processing' })
    .then(function(record) {
      exportRecord = record;
      return runQuery(User.model || mongoose.model('User'), 'findById', userId);
    })
    .then(function(foundUser) {
      user = foundUser;
      if (!user) {
        throw new Error('User not found');
      }

      // Count total trinkets (live only — deletes are soft, so exclude
      // deletedAt != null or the count/export leaks trinkets the user removed)
      return runQuery(Trinket.model || mongoose.model('Snippet'), 'count', { _owner: userId, deletedAt: null });
    })
    .then(function(count) {
      // Update total count
      return runQuery(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, {
        'progress.total': count,
        trinketCount: count
      });
    })
    .then(function() {
      // Create the archive
      return createExportArchive(userId, exportId, tempFile);
    })
    .then(function(result) {
      // Upload to S3
      return uploadToS3(tempFile, s3Key, filename);
    })
    .then(function(downloadUrl) {
      var expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + EXPORT_EXPIRY_DAYS);

      // Get file size
      var stats = fs.statSync(tempFile);

      // Update export record with completion
      return runQuery(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, {
        status: 'completed',
        downloadUrl: downloadUrl,
        s3Key: s3Key,
        expiresAt: expiresAt,
        fileSize: stats.size
      }, { new: true });
    })
    .then(function(record) {
      exportRecord = record;
      // Send notification email
      return sendCompletionEmail(user, exportRecord);
    })
    .then(function() {
      // Cleanup temp file
      fs.unlink(tempFile, function() {});
      return Promise.resolve();
    })
    .fail(function(err) {
      // Cleanup on failure
      if (tempFile) {
        fs.unlink(tempFile, function() {});
      }

      return runQuery(Export.model || mongoose.model('Export'), 'findByIdAndUpdate', exportId, {
        status: 'failed',
        errorMessage: err.message
      })
      .then(function() {
        if (user) {
          return sendFailureEmail(user, err.message);
        }
      })
      .then(function() {
        return Promise.reject(err);
      });
    });
}

// Mirrors processBulkExport above, but builds a course/assignment submissions
// archive (via createSubmissionsArchive, Task 5) instead of an all-trinkets
// archive. The Export record itself carries the scope (type/courseId/
// materialId) — job.data only needs exportId/userId. Trinket count isn't
// known up front (it depends on how many assignments/submissions are in
// scope), so progress.total/trinketCount are set from the archive builder's
// returned `processed` count AFTER the build, rather than pre-counted like
// processBulkExport's owner-trinket count.
function processStudentWorkExport(job) {
  var exportId = job.data.exportId
    , userId   = job.data.userId
    , exportRecord
    , user
    , tempFile
    , s3Key
    , filename;

  // Generate unique filename
  var timestamp = Date.now();
  var hash = crypto.createHash('sha1')
    .update(userId + timestamp.toString())
    .digest('hex')
    .substring(0, 12);

  filename = 'student-work-' + hash + '.zip';
  tempFile = '/tmp/' + filename;
  s3Key = 'exports/' + userId + '/' + filename;

  if (!config.isTest) {
    env = nunjucks.configure(config.app.templates);
  }

  return runQuery(Export, 'findByIdAndUpdate', exportId, { status: 'processing' })
    .then(function(record) {
      exportRecord = record;
      return runQuery(User, 'findById', userId);
    })
    .then(function(foundUser) {
      user = foundUser;
      if (!user) {
        throw new Error('User not found');
      }

      // Create the archive (scope comes from exportRecord.type/courseId/materialId)
      return createSubmissionsArchive(exportRecord, tempFile);
    })
    .then(function(result) {
      // Update total/trinketCount now that we know how many submissions were
      // processed (createSubmissionsArchive already wrote the final
      // progress.processed/progress.failed tally itself).
      return runQuery(Export, 'findByIdAndUpdate', exportId, {
        'progress.total': result.processed,
        trinketCount: result.processed
      });
    })
    .then(function() {
      // Upload to S3
      return uploadToS3(tempFile, s3Key, filename);
    })
    .then(function(downloadUrl) {
      var expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + EXPORT_EXPIRY_DAYS);

      // Get file size
      var stats = fs.statSync(tempFile);

      // Update export record with completion
      return runQuery(Export, 'findByIdAndUpdate', exportId, {
        status: 'completed',
        downloadUrl: downloadUrl,
        s3Key: s3Key,
        expiresAt: expiresAt,
        fileSize: stats.size
      }, { new: true });
    })
    .then(function(record) {
      exportRecord = record;
      // Send notification email
      return sendCompletionEmail(user, exportRecord);
    })
    .then(function() {
      // Cleanup temp file
      fs.unlink(tempFile, function() {});
      return Promise.resolve();
    })
    .fail(function(err) {
      // Cleanup on failure
      if (tempFile) {
        fs.unlink(tempFile, function() {});
      }

      return runQuery(Export, 'findByIdAndUpdate', exportId, {
        status: 'failed',
        errorMessage: err.message
      })
      .then(function() {
        if (user) {
          return sendFailureEmail(user, err.message);
        }
      })
      .then(function() {
        return Promise.reject(err);
      });
    });
}

function createExportArchive(userId, exportId, tempFile) {
  var deferred = Q.defer();
  var archive = archiver('zip', { zlib: { level: 6 } });
  var output = fs.createWriteStream(tempFile);
  var processed = 0;
  var failed = 0;
  var manifest = {
    exportedAt: new Date().toISOString(),
    trinkets: []
  };

  output.on('close', function() {
    deferred.resolve({ processed: processed, failed: failed });
  });

  output.on('error', function(err) {
    deferred.reject(err);
  });

  archive.on('error', function(err) {
    deferred.reject(err);
  });

  archive.pipe(output);

  var TrinketModel = Trinket.model || mongoose.model('Snippet');
  // Live trinkets only: `deletedAt: null` matches every other trinket query in
  // the codebase (soft deletes must not reappear in a "Download All" archive).
  //
  // Load the set in one query and walk it sequentially. We previously streamed
  // via Mongoose `.cursor()`, but the Firestore backend's query builder has no
  // `.cursor()` (its find()/select() resolve to an array), so bulk export threw
  // `TrinketModel.find(...).select(...).cursor is not a function` on every
  // Firestore deploy. find().select() is thenable on BOTH backends; `.select()`
  // already trims to the fields we archive and exports are modest, so
  // materializing the list is fine. The sequential reduce preserves the old
  // one-at-a-time backpressure (each trinket's assets finish before the next).
  // Progress tracking is best-effort. A failed progress write (a transient
  // backend error, or the export record no longer existing) must not abort a
  // fully-built archive — nor, when called mid-loop, fall through to the
  // per-trinket fail handler and miscount a live trinket as failed.
  var progressUpdate = function() {
    return runQuery(Export, 'findByIdAndUpdate', exportId, {
      'progress.processed': processed,
      'progress.failed': failed
    }).fail(function(err) {
      console.log('export progress update failed (non-fatal):', err && err.message);
    });
  };

  Q(TrinketModel.find({ _owner: userId, deletedAt: null })
      .select('shortCode name description folder lang code assets settings created lastUpdated'))
    .then(function(trinkets) {
      return trinkets.reduce(function(chain, trinket) {
        return chain.then(function() {
          return addTrinketToArchive(archive, trinket)
            .then(function(trinketInfo) {
              processed++;
              manifest.trinkets.push(trinketInfo);
              // Update progress every 10 trinkets
              if (processed % 10 === 0) {
                return progressUpdate();
              }
            })
            .fail(function(err) {
              failed++;
              console.log('Failed to add trinket:', trinket.shortCode, err.message);
            });
        });
      }, Q());
    })
    .then(function() {
      // Add manifest
      manifest.totalTrinkets = processed;
      manifest.failedTrinkets = failed;
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

      // Final progress update
      return progressUpdate();
    })
    .then(function() {
      archive.finalize();
    })
    .fail(function(err) {
      deferred.reject(err);
    });

  return deferred.promise;
}

// Build a course/assignment submissions archive: <assignment-slug>/_assignment/
// (the prompt trinket, if one still exists) and <assignment-slug>/<student-slug>/
// (that student's current submission + feedback.md + submission.json) for every
// assignment material in scope. exportRecord.type selects the scope:
//   'assignment-submissions' -> only exportRecord.materialId
//   'course-submissions'     -> every assignment material in exportRecord.courseId
function createSubmissionsArchive(exportRecord, tempFile) {
  var deferred = Q.defer();
  var archive = archiver('zip', { store: true });
  var output = fs.createWriteStream(tempFile);
  var CourseModel = Course;
  var ExportModel = Export;

  var ctx = {
    exportRecord    : exportRecord,
    archive         : archive,
    course          : null,
    processed       : 0,
    failed          : 0,
    assignmentSlugs : new Set(),
    manifest        : {
      exportedAt  : new Date().toISOString(),
      scope       : exportRecord.type,
      course      : null,
      assignments : []
    }
  };

  output.on('close', function() {
    deferred.resolve({
      processed      : ctx.processed,
      failed         : ctx.failed,
      assignmentCount: ctx.manifest.assignments.length
    });
  });

  output.on('error', function(err) {
    deferred.reject(err);
  });

  archive.on('error', function(err) {
    deferred.reject(err);
  });

  archive.pipe(output);

  runQuery(CourseModel, 'findById', exportRecord.courseId)
    .then(function(course) {
      if (!course) {
        throw new Error('Course not found: ' + exportRecord.courseId);
      }
      ctx.course = course;
      ctx.manifest.course = { name: course.name, slug: course.slug };

      return getAssignmentMaterials(course, exportRecord);
    })
    .then(function(materials) {
      // Sequential, not parallel: keeps zip-entry writes ordered and the
      // processed/failed counters (and the every-10 progress update) simple
      // to reason about. Submission archives are not hot-path/high-volume
      // like the trinket-export cursor above.
      return materials.reduce(function(chain, material) {
        return chain.then(function() {
          return processSubmissionAssignment(ctx, material);
        });
      }, Q());
    })
    .then(function() {
      ctx.archive.append(JSON.stringify(ctx.manifest, null, 2), { name: 'manifest.json' });

      return runQuery(ExportModel, 'findByIdAndUpdate', exportRecord._id, {
        'progress.processed': ctx.processed,
        'progress.failed'   : ctx.failed
      });
    })
    .then(function() {
      ctx.archive.finalize();
    })
    .fail(function(err) {
      deferred.reject(err);
    });

  return deferred.promise;
}

// Two-step populate (course -> lessons -> materials), mirroring
// lib/controllers/course.js's materialDashboard. Keeps only type==="assignment"
// materials; assignment-submissions scope narrows further to the one material.
function getAssignmentMaterials(course, exportRecord) {
  return course.populate({
      path   : 'lessons',
      select : 'materials'
    })
    .then(function() {
      return Promise.all((course.lessons || []).map(function(lesson) {
        return lesson.populate({
          path   : 'materials',
          select : 'name slug type trinket',
          match  : { $or: [ { isDraft: { $ne: true } }, { type: 'assignment' } ] }
        });
      }));
    })
    .then(function() {
      var materials = [];

      (course.lessons || []).forEach(function(lesson) {
        (lesson.materials || []).forEach(function(material) {
          if (material && material.type === 'assignment') {
            materials.push(material);
          }
        });
      });

      if (exportRecord.type === 'assignment-submissions') {
        var targetId = exportRecord.materialId && exportRecord.materialId.toString();
        materials = materials.filter(function(material) {
          return material.id.toString() === targetId;
        });
      }

      return materials;
    });
}

// Student display info comes from the course roster (course.users) when the
// student is still enrolled; fall back to a User lookup (e.g. removed from
// the course after submitting) so the export doesn't silently drop them.
function findCourseUser(course, userId) {
  var idStr = userId && userId.toString();
  return (course.users || []).find(function(u) {
    return u.userId && u.userId.toString() === idStr;
  });
}

function resolveStudent(course, userId) {
  var courseUser = findCourseUser(course, userId);

  if (courseUser) {
    return Q({
      userId      : userId,
      username    : courseUser.username,
      email       : courseUser.email,
      displayName : courseUser.displayName
    });
  }

  var UserModel = User;
  return runQuery(UserModel, 'findById', userId)
    .then(function(user) {
      if (!user) {
        return { userId: userId, username: null, email: null, displayName: null };
      }

      return {
        userId      : userId,
        username    : user.username,
        email       : user.email,
        displayName : user.name || user.fullname
      };
    });
}

// Adds one assignment's manifest entry + writes its prompt (if any survives)
// and each student's current submission into the archive.
function processSubmissionAssignment(ctx, material) {
  var assignmentSlug = uniqueSlug(sanitizeFolderName(material.name), ctx.assignmentSlugs);
  var studentSlugs = new Set();
  var entry = {
    slug            : assignmentSlug,
    name            : material.name,
    materialId      : material.id,
    submissionCount : 0,
    students        : []
  };

  ctx.manifest.assignments.push(entry);

  var promptPromise;
  if (material.trinket && material.trinket.trinketId) {
    promptPromise = Q(Trinket.findById(material.trinket.trinketId))
      .then(function(prompt) {
        // Prompt trinket was deleted out from under the material — skip the
        // _assignment/ folder rather than failing the whole export.
        if (!prompt) return;
        return addTrinketToArchive(ctx.archive, prompt, { basePath: assignmentSlug + '/_assignment/' });
      })
      .fail(function(err) {
        console.log('Failed to add assignment prompt for material', material.id, err.message);
      });
  } else {
    promptPromise = Q();
  }

  return promptPromise
    .then(function() {
      // includeTrinket: this query already loads every submission trinket, so
      // carrying the document through avoids re-reading each one individually
      // below — that second, serial read is what made a large class slow (#202).
      return Q(Trinket.findSubmissionsByMaterial(material.id, { includeTrinket: true }));
    })
    .then(function(groups) {
      return (groups || []).reduce(function(chain, group) {
        return chain.then(function() {
          return processSubmissionGroup(ctx, material, assignmentSlug, studentSlugs, entry, group);
        });
      }, Q());
    });
}

// One student's current submission for one assignment: resolves the student,
// picks their current submission, and writes <slug>/main.py + feedback.md +
// submission.json. A student with no current submission (never
// started/withdrawn state) is skipped entirely, not recorded in the manifest.
function processSubmissionGroup(ctx, material, assignmentSlug, studentSlugs, entry, group) {
  var current = submissions.pickCurrentSubmission(group.submissions);
  if (!current) return Q();

  return resolveStudent(ctx.course, group._id)
    .then(function(student) {
      // Already in hand when the caller asked for it; the findById fallback
      // keeps this function correct for any caller that did not.
      var preloaded = current.trinket
        ? Q(current.trinket)
        : Q(Trinket.findById(current.trinketId));
      return preloaded.then(function(subTrinket) {
        if (!subTrinket) {
          throw new Error('Submission trinket not found: ' + current.trinketId);
        }

        var slugSource = sanitizeFolderName(
          student.username ||
          (student.email || '').split('@')[0] ||
          String(group._id)
        );
        var studentSlug = uniqueSlug(slugSource, studentSlugs);
        var basePath = assignmentSlug + '/' + studentSlug + '/';

        return addTrinketToArchive(ctx.archive, subTrinket, { basePath: basePath })
          .then(function() {
            ctx.archive.append(renderFeedbackMarkdown(current.comments), { name: basePath + 'feedback.md' });
            ctx.archive.append(
              JSON.stringify(buildSubmissionMeta({ student: student, submission: current }), null, 2),
              { name: basePath + 'submission.json' }
            );

            var hasFeedback = (current.comments || []).some(function(c) {
              return c.commentType === 'feedback';
            });

            entry.submissionCount++;
            entry.students.push({
              slug        : studentSlug,
              email       : student.email || null,
              state       : current.state || null,
              submittedOn : current.submittedOn ? new Date(current.submittedOn).toISOString() : null,
              hasFeedback : hasFeedback,
              folder      : basePath
            });

            ctx.processed++;

            // Progress update every 10 submissions (matches processBulkExport's
            // cadence); the final tally is written unconditionally at the end
            // of createSubmissionsArchive.
            if (ctx.processed % 10 === 0) {
              var ExportModel = Export;
              return runQuery(ExportModel, 'findByIdAndUpdate', ctx.exportRecord._id, {
                'progress.processed': ctx.processed,
                'progress.failed'   : ctx.failed
              });
            }
          });
      });
    })
    .fail(function(err) {
      ctx.failed++;
      console.log('Failed to add submission for material', material.id, 'student', group._id, err.message);
    });
}

// Appends -2, -3, ... to `base` until the result isn't already in `used`,
// then reserves it. Used to de-dupe student folder slugs within one
// assignment (e.g. two students who share a username-less email prefix).
function uniqueSlug(base, used) {
  var candidate = base;
  var n = 2;

  while (used.has(candidate)) {
    candidate = base + '-' + n;
    n++;
  }

  used.add(candidate);
  return candidate;
}

function addTrinketToArchive(archive, trinket, options) {
  var deferred = Q.defer();
  options = options || {};
  var basePath = options.basePath ||
    ((trinket.lang || 'other') + '/' + sanitizeFolderName(trinket.name || trinket.shortCode) + '_' + trinket.shortCode + '/');

  // Add metadata file
  var metadata = {
    shortCode: trinket.shortCode,
    name: trinket.name,
    description: trinket.description,
    lang: trinket.lang,
    created: trinket.created,
    lastUpdated: trinket.lastUpdated,
    settings: trinket.settings,
    url: config.url + '/' + trinket.lang + '/' + trinket.shortCode
  };
  // Record the trinket's folder (membership rides on each trinket; a trinket
  // belongs to at most one folder). Reconstructed on import.
  if (trinket.folder && trinket.folder.name) {
    metadata.folder = { name: trinket.folder.name, slug: trinket.folder.folderSlug };
  }
  archive.append(JSON.stringify(metadata, null, 2), { name: basePath + 'metadata.json' });

  // Add instructions (stored in description) as a readable markdown file
  if (trinket.description && trinket.description.length) {
    archive.append(trinket.description, { name: basePath + 'instructions.md' });
  }

  // Parse and add code files
  var codeFiles = parseCodeFiles(trinket);
  codeFiles.forEach(function(file) {
    archive.append(file.content || '', { name: basePath + file.name });
  });

  // Download and add assets
  var assetPromises = [];
  if (trinket.assets && trinket.assets.length) {
    trinket.assets.forEach(function(asset) {
      if (!asset.url) return;

      var assetFile = path.basename(url.parse(asset.url).pathname);

      var assetPromise = downloadAsset(asset.url)
        .then(function(buffer) {
          archive.append(buffer, { name: basePath + 'assets/' + (asset.name || assetFile) });
        })
        .fail(function(err) {
          // Log but don't fail entire trinket for one missing asset
          console.log('Asset download failed:', asset.name, err.message);
        });

      assetPromises.push(assetPromise);
    });
  }

  Q.allSettled(assetPromises)
    .then(function() {
      deferred.resolve({
        shortCode: trinket.shortCode,
        name: trinket.name,
        lang: trinket.lang
      });
    })
    .fail(function(err) {
      deferred.reject(err);
    });

  return deferred.promise;
}

function parseCodeFiles(trinket) {
  var code;
  try {
    code = JSON.parse(trinket.code);
    if (!Array.isArray(code)) {
      throw new Error('Not an array');
    }
  } catch(e) {
    // Single file trinket
    var extension = langExtensions[trinket.lang] || '.txt';
    var mainName = /blocks/.test(trinket.lang) ? 'main.xml' : 'main' + extension;

    code = [{
      name: mainName,
      content: trinket.code
    }];
  }
  return code;
}

function sanitizeFolderName(name) {
  return (name || 'untitled')
    .replace(/[^a-zA-Z0-9_\-\s]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 50);
}

// Upload the finished archive through the deploy's STORAGE BACKEND, not a raw
// aws.S3 client.
//
// This used `new aws.S3()` directly, which only ever had something to talk to on
// compose deploys (garage, S3-compatible). Cloud Run runs storage.backend 'gcs'
// with no S3 endpoint or credentials, so the upload could never succeed there —
// exports were broken on Cloud Run in this way as well as by the missing worker
// and the missing bucket. Everything else in the app already goes through
// lib/util/storage-backend; this is the outlier, now brought into line.
function uploadToS3(localPath, s3Key, filename) {
  var deferred = Q.defer();
  var backend = require('../util/storage-backend');
  var readStream = fs.createReadStream(localPath);

  backend.upload(
    config.aws.buckets.exports.name,
    s3Key,
    readStream,
    'application/zip',
    // Without this the browser saves the archive under the object key rather
    // than a readable filename.
    { contentDisposition: 'attachment; filename="' + filename + '"' },
    function(err) {
      if (err) { return deferred.reject(err); }
      deferred.resolve(config.aws.buckets.exports.host + '/' + s3Key);
    }
  );

  return deferred.promise;
}

function sendCompletionEmail(user, exportRecord) {
  var subject = 'Your Trinket Export is Ready';

  var templateData = {
    username: user.name || user.username,
    trinketCount: exportRecord.progress ? exportRecord.progress.processed : exportRecord.trinketCount,
    fileSize: formatFileSize(exportRecord.fileSize),
    expiresAt: moment(exportRecord.expiresAt).format('MMM D, YYYY'),
    downloadUrl: config.url + '/api/exports/' + exportRecord._id + '/download'
  };

  var html = nunjucks.render('emails/export-ready', templateData);

  return mailer.send(user.email, subject, { html: html, type: 'export-ready' });
}

function sendFailureEmail(user, errorMessage) {
  var subject = 'Your Trinket Export Failed';

  var templateData = {
    username: user.name || user.username,
    errorMessage: errorMessage || 'An unexpected error occurred'
  };

  var html = nunjucks.render('emails/export-failed', templateData);

  return mailer.send(user.email, subject, { html: html, type: 'export-failed' });
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderFeedbackMarkdown(comments) {
  // Filter for feedback comments only
  var feedbackComments = (comments || []).filter(function(c) {
    return c.commentType === 'feedback';
  });

  // Return no-feedback message if empty
  if (feedbackComments.length === 0) {
    return '_No feedback._\n';
  }

  // Sort by commented date, oldest first
  feedbackComments.sort(function(a, b) {
    var aTime = new Date(a.commented).getTime();
    var bTime = new Date(b.commented).getTime();
    return aTime - bTime;
  });

  // Render each feedback comment
  var lines = [];
  feedbackComments.forEach(function(comment) {
    var author = comment.displayName || comment.username || comment.email || 'Instructor';
    var timestamp = new Date(comment.commented).toISOString();
    lines.push('### ' + author + ' — ' + timestamp);
    lines.push('');
    lines.push(comment.commentText || '');
    lines.push('');
  });

  return lines.join('\n');
}

function buildSubmissionMeta(args) {
  var student = args.student;
  var submission = args.submission;

  var hasFeedback = (submission.comments || []).some(function(c) {
    return c.commentType === 'feedback';
  });

  return {
    student: student,
    email: student.email || null,
    state: submission.state || null,
    startedOn: submission.startedOn ? new Date(submission.startedOn).toISOString() : null,
    submittedOn: submission.submittedOn ? new Date(submission.submittedOn).toISOString() : null,
    lastUpdated: submission.lastUpdated ? new Date(submission.lastUpdated).toISOString() : null,
    shortCode: submission.shortCode || null,
    lang: submission.lang || null,
    hasFeedback: hasFeedback
  };
}

// This module is normally require()'d purely for its side effects (queue
// registration — see exportsQueue.process/.on above), e.g. app.js:
//   if (process.env.RUN_EXPORT_WORKER === 'true') require('./lib/workers/exports');
// Nothing currently destructures exports from it. Export the pure helpers
// here for testability without changing that side-effecting require.
module.exports = {
  // Run a student-work export to completion in the CALLER's process. Used by
  // lib/controllers/course.js to build the archive inside the request, the same
  // shape as the sibling exports that already work on Cloud Run (Feedback CSV,
  // single-trinket zip, whole-course zip). Takes the queue's job shape so the
  // queued path and the inline path stay identical.
  processStudentWorkExport: processStudentWorkExport,
  createExportArchive: createExportArchive,
  addTrinketToArchive: addTrinketToArchive,
  parseCodeFiles: parseCodeFiles,
  sanitizeFolderName: sanitizeFolderName,
  renderFeedbackMarkdown: renderFeedbackMarkdown,
  buildSubmissionMeta: buildSubmissionMeta,
  createSubmissionsArchive: createSubmissionsArchive
};
