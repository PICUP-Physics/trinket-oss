var config = require('config'),
    diff   = require('diff'),
    errors = require('@hapi/boom'),
    _      = require('underscore'),
    moment = require('moment'),
    csvStringify = require('csv').stringify,
    ObjectUtils = require('../util/objectUtils'),
    mailer = require('../util/mailer'),
    courseRoster = require('../util/courseRoster'),
    ltiNotifySubmission = require('../util/ltiNotifySubmission'),
    ltiGradebookUrl    = require('../util/ltiGradebookUrl'),
    LtiResourceLink    = require('../models/ltiResourceLink'),
    LtiPlatform        = require('../models/ltiPlatform'),
    LtiUserIdentity    = require('../models/ltiUserIdentity'),
    submissionsUtil    = require('../util/submissions'),
    Export             = require('../models/export'),
    exportsQueue       = require('../util/queues').exports(),
    exportGuard        = require('../util/exportGuard'),
    submissionView     = require('../util/submissionView'),
    ltiGradeSync       = require('../util/ltiGradeSync');

module.exports = {
  createCourse : function(request, reply) {
    var course = new Course(request.payload);

    course.setOwner(request.user);
    course.ownerSlug = request.user.username;

    // TODO: verify that user has permission to create a private course
    course.setGlobalSettings(request.payload);

    // New-course default comes from config, not the schema — the bridge's
    // policy knob (spec: markdown-engine-bridge). Explicit payload wins.
    if (!request.payload.markdownEngine) {
      var mdDefault = config.features && config.features.markdown
        && config.features.markdown.newCourseDefault;
      course.globalSettings.markdownEngine = mdDefault === 'modern' ? 'modern' : 'legacy';
    }

    course.save(function(err, course) {
      if (err) {
        if (err.code === 11000) {
          return request.fail({
              err     : err
            , message : "You already have a course with this name. Please choose another."
          });
        }

        // unknown failure
        return request.fail({
            err     : err
          , message : err.message
        });
      }

      // request.user.grant("course-owner", "course", { id : course.id })
      return course.addUser(request.user, ["course-owner"])
        .then(function() {
          request.success({ course : course });
        });
    });
  },

  getCourse : function(request, reply) {
    var course     = request.pre.course
      , checkDates = false
      , lessonsPopulate, materialsPopulate
      , canEdit, canViewSubmissions;

    if (course._owner && course._owner.serialize && typeof course._owner.serialize === 'function') {
      course._owner = course._owner.serialize();
    }

    if (!request.query.outline) {
      return request.success({ data : course });
    }

    lessonsPopulate = {
      path   : 'lessons',
      select : 'name slug materials'
    };
    materialsPopulate = {
      path   : 'materials',
      select : 'name slug type trinket'
    };

    if (request.query.withContent) {
      materialsPopulate.select += ' content';
    }

    if (request.user) {
      canEdit            = request.user.hasPermission('manage-course-content', 'course', { id : course.id });
      canViewSubmissions = request.user.hasPermission('view-assignment-submissions', 'course', { id : course.id });
    }

    if (request.query.withDraft && canEdit) {
      lessonsPopulate.select   += ' isDraft';
      materialsPopulate.select += ' isDraft';
    }
    else if (request.query.withDraftAssignments && canViewSubmissions) {
      lessonsPopulate.select   += ' isDraft';
      materialsPopulate.select += ' isDraft';
      materialsPopulate.match = { $or : [ { isDraft : { $ne : true } }, { type : "assignment" } ] };
    }
    else {
      lessonsPopulate.match   = { isDraft : { $ne : true } };
      materialsPopulate.match = { isDraft : { $ne : true } };
      checkDates = true;
    }

    return course.populate(lessonsPopulate)
      .then(function() {
        return Promise.all(course.lessons.map(function(lesson) {
          return lesson.populate(materialsPopulate);
        }));
      })
      .then(function() {
        if (checkDates) {
          // loop through materials, checking assignment dates...
          course.lessons = _.map(course.lessons, function(lesson) {
            lesson.materials = _.filter(lesson.materials, function(material) {
              return material.isVisible();
            });

            return lesson;
          });
        }

        return request.success({ data : course });
      });
  },

  // update name/description
  updateCourse : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("update-course-details", "course", { id : course.id })) {
      course.set(request.payload);
      course.setGlobalSettings(request.payload);

      course.save(function(err, course) {
        if (err) {
          if (err.code === 11000) {
            return request.fail({
                err     : err
              , message : "You already have a course with this name. Please choose another."
            });
          }

          // unknown failure
          return request.fail({
              err     : err
            , message : err.message
          });
        }

        return request.success({ course : course });
      });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  deleteCourse : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("delete-course", "course", { id : course.id })) {
      return course.deleteCourse()
        .then(request.success)
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  // archive or restore
  archiveCourse : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasRole("course-owner", "course", { id : request.pre.course.id })) {
      course.set({ archived: request.payload.archived });
      course.save(function(err, course) {
        return request.success({ course: course });
      });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  copyCourse : function(request, reply) {
    var url;

    if (request.user.hasRole("course-owner", "course", { id : request.pre.course.id })
    ||  request.pre.course.globalSettings.courseType === "public"
    ||  request.pre.course.globalSettings.courseType === "open"
    ||  request.user.hasPermission("create-private-course")
    ||  request.user.hasPermission("make-course-copy", "course", { id : request.pre.course.id })) {
      request.pre.course.name = request.payload.name;
      request.pre.course.copy(request.user, function(err, course) {
        if (err) {
          if (err.code === 11000) {
            return request.fail({
                err     : err
              , message : "You already have a course with this name. Please choose another."
            });
          }

          // unknown failure
          return request.fail({
              err     : err
            , message : err.message
          });
        }

        return course.addUser(request.user, ["course-owner"])
          .then(function() {
            // url needs to be fully qualified in case the copy is
            // happening from the original owner's subdomain
            url = config.url + '/' + course.ownerSlug + '/courses/' + course.slug;
            request.success({
                success : true
              , url     : url
            });
          });
      });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  addLesson : function(request, reply) {
    var course = request.pre.course
      , lesson, index;

    if (request.user.hasPermission("manage-course-content", "course", { id : course.id })) {
      lesson = new Lesson(request.payload);
      index  = Math.max(0, Math.min(course.lessons.length, request.query.index || course.lessons.length));

      lesson.setOwner(request.user);

      if (course.globalSettings.contentDefault === 'draft') {
        lesson.isDraft = true;
      }

      lesson.save()
        .then(function(savedLesson) {
          lesson = savedLesson;
          course.lessons.splice(index, 0, lesson.id);
          return course.save();
        })
        .then(function() {
          request.success({ data : lesson });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  getLesson : function(request, reply) {
    return request.success({ data : request.pre.lesson });
  },

  updateLesson : function(request, reply) {
    var course = request.pre.course
      , lesson = request.pre.lesson;

    if (request.user.hasPermission("manage-course-content", "course", { id : course.id })) {
      lesson.set(request.payload);
      lesson.save(function(err, lesson) {
        return request.success({
          lesson : {
            name    : lesson.name,
            slug    : lesson.slug,
            isDraft : lesson.isDraft || false
          }
        });
      });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  moveLesson : function(request, reply) {
    var course = request.pre.course
      , index;

    if (request.user.hasPermission("manage-course-content", "course", { id : course.id })) {
      index = course.lessons.indexOf(request.params.lessonId);
      course.lessons.splice(index, 1);
      course.lessons.splice(request.payload.index, 0, request.params.lessonId);

      course.save(function(err, course) {
        return request.success({
          oldParent : course.id,
          newParent : course.id,
          oldIndex  : index,
          newIndex  : request.payload.index
        });
      });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  deleteLesson : function(request, reply) {
    var course = request.pre.course,
        lesson = request.pre.lesson;

    if (request.user.hasPermission("manage-course-content", "course", { id : course.id })) {
      lesson.remove()
        .then(function(lesson) {
          course.lessons.pull(lesson.id);
          return course.save();
        })
        .then(function(course) {
          return request.success({ course : course });
        })
        .catch(request.fail);
    }
    else {
      return reply(errors.forbidden());
    }
  },

  addMaterial : function(request, reply) {
    var course = request.pre.course
      , lesson = request.pre.lesson
      , material, index, trinketPromise, blank;

    if (request.user.hasPermission("manage-course-content", "course", { id : course.id })) {
      material = new Material(request.payload);
      index    = Math.max(0, Math.min(lesson.materials.length, request.query.index || lesson.materials.length));

      material.setOwner(request.user);

      if (request.payload.type === "assignment") {
        // trinketId is optional in the route schema, so callers may legitimately omit
        // it — and doing so left trinketPromise undefined and 500'd on
        // `undefined.then`. Say what is missing instead of crashing.
        if (!request.payload.trinketId) {
          return reply(errors.badRequest(
            'An assignment needs trinketId: "_blank_" for a new starter trinket, or an existing trinket id.'));
        }
        if (request.payload.trinketId === "_blank_") {
          blank = Trinket.createBlankForAssignment(request.user, material.name, request.payload.lang);
          trinketPromise = blank.save();
        }
        else if (request.payload.trinketId) {
          trinketPromise = Trinket.findById(request.payload.trinketId);
        }
      }
      else {
        trinketPromise = Promise.resolve(null);
      }

      return trinketPromise
        .then(function(trinket) {
          if (trinket) {
            material.trinket = {
                trinketId : trinket.id
              , name      : trinket.name
              , lang      : trinket.lang
              , shortCode : trinket.shortCode
            };

            material.setDates(request.payload);
          }

          if (course.globalSettings.contentDefault === 'draft') {
            material.isDraft = true;
          }

          return material.save();
        })
        .then(function(savedMaterial) {
          material = savedMaterial;
          lesson.materials.splice(index, 0, material.id);
          return lesson.save();
        })
        .then(function() {
          request.success({ data : material });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  getMaterial : function(request, reply) {
    var promise, data;

    if (request.pre.material.type === "assignment" && request.query.with === "owner") {
      promise = Trinket.findById(request.pre.material.trinket.trinketId);
    }
    else {
      promise = Promise.resolve(null);
    }

    return promise.then(function(trinket) {
      data = ObjectUtils.serialize(request.pre.material);
      if (trinket) {
        data.trinket.owner = trinket._owner.toString() === request.user.id ? true : false;
      }
      // NOTE: do NOT normalize embed URLs here. This endpoint feeds the editor,
      // which diffs the content it receives against its edits and PUTs the diff
      // to patchContent — where the patch is applied to the RAW stored content.
      // Rewriting embeds on serve (e.g. https://host -> //host) makes the editor's
      // base differ from storage, so the patch never applies -> a permanent
      // "modified in another window" conflict for any imported material with an
      // embed (M&I #7). Embeds are already made absolute-to-this-host at import
      // (embedRewrite/#51); the editor edits that canonical content directly.

      return request.success({
        data : data
      });
    });
  },

  updateMaterial : function(request, reply) {
    var course   = request.pre.course
      , material = request.pre.material
      , trinketPromise, blank, materialData;

    if (request.user.hasPermission("manage-course-content", "course", { id : course.id })) {
      if (material.type === "assignment") {
        if (request.payload.trinketId === "_blank_") {
          blank = Trinket.createBlankForAssignment(request.user, material.name, request.payload.lang);
          trinketPromise = blank.save();
        }
        else if (request.payload.trinketId) {
          trinketPromise = Trinket.findById(request.payload.trinketId);
        }
        else {
          trinketPromise = Promise.resolve(null);
        }
      }
      else {
        trinketPromise = Promise.resolve(null);
      }

      return trinketPromise
        .then(function(trinket) {
          if (Array.isArray(trinket)) {
            trinket = trinket[0];
          }

          if (trinket) {
            material.trinket = {
                trinketId : trinket.id
              , name      : trinket.name
              , lang      : trinket.lang
              , shortCode : trinket.shortCode
            };

            material.setDates(request.payload);
          }

          material.set(request.payload);

          if (typeof(request.payload.patch) !== 'undefined') {
            var patched = diff.applyPatch(material.content ? material.content : '', request.payload.patch);
            if (patched === false) {
              // Conflict: the client's patch no longer applies. Return the fail
              // response directly. This MUST short-circuit — if it flowed into a
              // subsequent `.then(request.success)`, that Hapi Response object
              // would be handed to ObjectUtils.serialize, which then walks the
              // entire (huge, circular) response→request→server graph and blows
              // the heap (patchContent OOM / SIGABRT crash loop).
              return request.fail({
                data : _.extendOwn({
                    status  : "error"
                  , message : "This page may have been modified in another window. If you wish to make edits, please reload the page."
                }, material.toJSON())
              });
            }
            else {
              material.content = patched.match(/^\s*$/) ? null : patched;
            }
          }

          // Only the actual-save branch continues to request.success. Nesting it
          // here (rather than a trailing .then) keeps the conflict's fail response
          // as the resolved value instead of feeding it back into request.success.
          return material.save().then(function(savedMaterial) {
            return request.success({ material : savedMaterial });
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  moveMaterial : function(request, reply) {
    var course = request.pre.course
      , lesson = request.pre.lesson
      , index, parent;

    if (request.user.hasPermission("manage-course-content", "course", { id : course.id })) {
      index = lesson.materials.indexOf(request.params.materialId);
      parent= request.pre.parent || lesson;

      lesson.materials.splice(index, 1);
      parent.materials.splice(request.payload.index, 0, request.params.materialId);

      lesson.save()
        .then(function(lesson) {
          if (lesson.id !== parent.id) {
            return parent.save();
          }
          return lesson;
        })
        .then(function(lesson) {
          return request.success({
            oldParent : lesson.id,
            newParent : parent.id,
            oldIndex  : index,
            newIndex  : request.payload.index
          });
        })
        .catch(request.fail);
    }
    else {
      return reply(errors.forbidden());
    }
  },

  deleteMaterial : function(request, reply) {
    var course   = request.pre.course
      , lesson   = request.pre.lesson
      , material = request.pre.material;

    if (request.user.hasPermission("manage-course-content", "course", { id : course.id })) {
      material.remove()
        .then(function(material) {
          lesson.materials.pull(material.id);
          return lesson.save();
        })
        .then(function(lesson) {
          return request.success({ lesson : lesson });
        })
        .catch(request.fail);
    }
    else {
      return reply(errors.forbidden());
    }
  },

  listUsers : function(request, reply) {
    var course = request.pre.course
      , users  = course.users.toObject ? course.users.toObject() : course.users.slice()
      , myUserId;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      myUserId = request.user.id.toString();

      users.forEach(function(user) {
        // Convert userId to string to avoid ObjectId serialization issues
        if (user.userId && user.userId.toString) {
          user.userId = user.userId.toString();
        }
        user.isSelf      = myUserId === user.userId;
        user.onDashboard = !course.userHiddenFromDashboard(user);

        if (user.roles) {
          if (user.roles.indexOf("course-owner") >= 0) {
            user.isOwner = true;
          }
        }
      });

      return request.success({
        data : users
      });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  listInvitations : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      return CourseInvitation.findUnacceptedByCourse(course)
        .then(function(invitations) {
          return request.success({
            data : invitations
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  userLookup : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      return User.findByLogin(request.payload.user)
        .then(function(user) {
          if (user) {
            return course.addUser(user, ['course-student']);
          }
          else {
            throw errors.notFound();
          }
        })
        .then(function(result) {
          if (result.success) {
            result.user.onDashboard = true;
            request.success({
                success : true
              , user    : result.user
            });
          }
          else if (result.alreadyListed) {
            request.success({
              alreadyListed : true
            });
          }
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  removeUser : function(request, reply) {
    var course = request.pre.course
      , userId = request.params.userId
      , user;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      return User.findById(userId)
        .then(function(user) {
          if (user) {
            return course.removeUser(user);
          }
          else {
            return course.removeDeletedUser(userId);
          }
        })
        .then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  addUser : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      return User.findById(request.payload.user)
        .then(function(user) {
          if (user) {
            return course.addUser(user);
          }
          else {
            throw errors.notFound();
          }
        })
        .then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  updateRoles : function(request, reply) {
    var course = request.pre.course
      , role   = "course-" + request.payload.role;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      return User.findById(request.payload.user)
        .then(function(user) {
          if (user) {
            return course.updateRole(user, role);
          }
          else {
            throw errors.notFound();
          }
        })
        .then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  updateViews : function(request, reply) {
    var course = request.pre.course
      , userId = request.payload.user
      , view   = request.payload.view
      , action = request.payload.action;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      return course.updateView(userId, view, action)
        .then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },

  sendInvitations : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      // A roster may mix existing accounts and new emails. addRoster enrolls
      // existing accounts immediately and turns the rest into invitations.
      return courseRoster.addRoster(request.payload.students, course)
        .then(function(result) {
          // Email only the new-email invitations (existing accounts are already
          // enrolled — nothing to accept). No mailer (mandi/uindy) → invitations
          // still auto-accept on the invitee's next sign-in.
          if (mailer.isConfigured() && result.invitations.length) {
            return CourseInvitation.sendEmails(result.invitations, course, request.user)
              .then(function() { return result; });
          }
          return result;
        })
        .then(function(result) {
          return request.success({
              success     : true
            , enrolled    : result.enrolled
            , invitations : result.invitations
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  removeInvitation : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      return CourseInvitation.findById(request.params.invitationId)
        .then(function(invitation) {
          return invitation.remove();
        }).then(function() {
          return request.success({
            success : true
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  updateInvitation : function(request, reply) {
    var course     = request.pre.course
      , invitation = request.pre.invitation
      , canUpdate  = true
      , existingUser;

    if (!mailer.isConfigured()) {
      return request.fail({
        message: "Email is not configured. Course invitations cannot be sent."
      });
    }

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      if (request.payload.status) {
        invitation.status = request.payload.status;
      }
      else if (request.payload.email) {
        // check course.users for this email
        existingUser = _.find(course.users, function(user) {
          return user.email.toLowerCase() === request.payload.email.toLowerCase();
        });

        if (!existingUser) {
          invitation.updateEmail(request.payload.email);
        }
        else {
          canUpdate = false;
        }
      }

      if (canUpdate) {
        return invitation.save()
          .then(function(savedInvitation) {
            return CourseInvitation.sendEmails([savedInvitation], course, request.user)
              .then(function() {
                return savedInvitation;
              });
          })
          .then(function(invitation) {
            return request.success({
                success    : true
              , invitation : invitation
            });
          })
          .catch(function(err) {
            // could be a duplicate email
            if (err.code === 11000) {
              return request.fail({
                  err     : err
                , message : "An invitation with that email address already exists."
              });
            }

            // unknown failure
            return request.fail({
                err     : err
              , message : err.message
            });
          });
      }
      else {
        return request.success({
            success : false
          , message : "That email address is already in use by another user or an invitation."
        });
      }
    }
    else {
      return reply(errors.forbidden());
    }
  },
  generateAccessCode : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      course.accessCode = generateAccessCode();
      return course.save()
        .then(function(savedCourse) {
          return request.success({
              success    : true
            , accessCode : savedCourse.accessCode
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  getAccessCode : function(request, reply) {
    var course = request.pre.course;

    if (request.user.hasPermission("manage-course-access", "course", { id : course.id })) {
      return request.success({
          success    : true
        , accessCode : course.accessCode || ""
      });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  join : function(request, reply) {
    Course.findByAccessCode(request.payload.accessCode, function(err, course) {
      if (err) {
        return reply(err);
      }

      if (!course) {
        return request.success({
            success : false
          , message : "No course was found with that code. Please check your code and try again."
        });
      }

      return course.addUser(request.user, ["course-student"])
        .then(function(result) {
          if (result.alreadyListed) {
            request.success({
              alreadyListed : true
            });
          }
          else {
            request.success({
                success : true
              , course  : course
            });
          }
        })
        .catch(function(err) {
          return reply(err);
        });
    });
  },
  startAssignment : function(request, reply) {
    var assignment;

    return Trinket.findById(request.payload.parent)
      .then(function(trinket) {
        // TODO: double check that user doesn't already have a "started" one

        assignment = new Trinket({
            code            : trinket.code
          , assets          : trinket.assets
          , settings        : trinket.settings
          , _parent         : request.payload.parent
          , _creator        : request.user
          , materialId      : request.params.materialId
          , courseId        : request.params.courseId
          , lang            : trinket.lang
          , submissionState : "started"
          , startedOn       : new Date()
        });

        return assignment.save();
      })
      .then(function(savedAssignment) {
        assignment = savedAssignment;
        return request.success({
          assignment : {
              id              : assignment.id
            , lang            : assignment.lang
            , lastUpdated     : new Date(assignment.lastUpdated).toISOString()
            , startedOn       : new Date(assignment.startedOn).toISOString()
            , shortCode       : assignment.shortCode
            , submissionState : assignment.submissionState
          }
        });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  submitAssignment : function(request, reply) {
    var submissionState = "submitted"
      , serialized, submission, now;

    // get material to check dates...
    return Material.findById(request.params.materialId)
      .then(function(material) {
        // An assignment created without date settings has no submissionsDue at all,
        // and reaching through it threw a TypeError the catch below reported as 403 —
        // sending anyone debugging it after a permissions problem that did not exist.
        // Treat "no date config" as "no date restrictions".
        var dates = (material.trinket && material.trinket.submissionsDue) ? material.trinket : null;
        if (dates && dates.submissionsDue.enabled) {
          now = new Date();

          if (dates.availableOn && dates.availableOn.enabled && now < dates.availableOn.dateValue) {
            // Boom, not a bare Error, so the catch can tell a deliberate refusal from
            // an unexpected failure.
            throw errors.forbidden("Assignment is not available.");
          }
          else if (now > dates.submissionsDue.dateValue
          && dates.submissionsCutoff && dates.submissionsCutoff.enabled && now > dates.submissionsCutoff.dateValue) {
            throw errors.forbidden("Assignment is past due.");
          }
          else if (now > dates.submissionsDue.dateValue
          && ( !dates.submissionsCutoff || !dates.submissionsCutoff.enabled
               || now <= dates.submissionsCutoff.dateValue )) {
            submissionState = "submittedLate";
          }
        }

        return Trinket.findById(request.payload.parent);
      })
      .then(function(parent) {
        serialized = request.payload.code;
        submission = new Trinket({
            code            : serialized.code
          , assets          : serialized.assets
          , settings        : serialized.settings
          , _parent         : request.payload.parent // TODO? change to student "modified" trinket
          , _creator        : request.user
          , materialId      : request.params.materialId
          , courseId        : request.params.courseId
          , lang            : parent.lang
          , submissionState : submissionState
          , submittedOn     : new Date()
          , comments        : [{
                commentText : request.payload.comments
              , commentType : 'student'
            }]
        });

        return submission.save();
      })
      .then(function(savedSubmission) {
        submission = savedSubmission;
        // await so the AGS post completes within the request — fire-and-forget is unreliable on
        // serverless (Cloud Run reaps the instance after the response). notify never rejects.
        return ltiNotifySubmission.notify(submission).then(function() {
        return request.success({
          submission : _.extendOwn({
                id              : submission.id
              , comments        : JSON.parse(JSON.stringify(submission.comments))
              , lang            : submission.lang
              , lastUpdated     : new Date(submission.lastUpdated).toISOString()
              , submittedOn     : new Date(submission.submittedOn).toISOString()
              , shortCode       : submission.shortCode
              , submissionState : submission.submissionState
            }, JSON.parse(JSON.stringify(submission.submissionOpts || {})))
        });
        });
      })
      .catch(function(err) {
        // Only a deliberate refusal is a 403. Relabelling every failure as
        // "forbidden" hid a TypeError as a permissions problem and sent debugging in
        // entirely the wrong direction.
        if (err && err.isBoom) { return reply(err); }
        console.error('[submitAssignment] unexpected failure:', (err && err.stack) || err);
        return reply(errors.badImplementation(err));
      });
  },
  updateMySubmission : function(request, reply) {
    var submission      = request.pre.trinket
      , submissionState = "submitted"
      , serialized, now;

    if (request.user.id.toString() === submission._creator.toString()) {
      // get material to check dates...
      return Material.findById(submission.materialId)
        .then(function(material) {
          // Same guard as submitAssignment: no date config means no date
          // restrictions (#377), not a TypeError reported as 403.
          var dates = (material.trinket && material.trinket.submissionsDue) ? material.trinket : null;
          if (dates && dates.submissionsDue.enabled) {
            now = new Date();

            if (dates.availableOn && dates.availableOn.enabled && now < dates.availableOn.dateValue) {
              throw new Error("Assignment is not available.");
            }
            else if (now > dates.submissionsDue.dateValue
            && dates.submissionsCutoff && dates.submissionsCutoff.enabled && now > dates.submissionsCutoff.dateValue) {
              throw new Error("Assignment is past due.");
            }
            else if (now > dates.submissionsDue.dateValue
            && ( !dates.submissionsCutoff || !dates.submissionsCutoff.enabled
                 || now <= dates.submissionsCutoff.dateValue )) {
              submissionState = "submittedLate";
            }
          }

          serialized = request.payload.code;

          submission.code            = serialized.code;
          submission.assets          = serialized.assets;
          submission.settings        = serialized.settings;
          submission.submittedOn     = new Date();
          submission.submissionState = submissionState;
          submission.comments        = [{
              commentText : request.payload.comments
            , commentType : 'student'
          }];

          return submission.save();
        })
        .then(function(savedSubmission) {
          submission = savedSubmission;
          // await so the AGS post completes within the request (serverless-safe; notify never rejects)
          return ltiNotifySubmission.notify(submission).then(function() {
          return request.success({
            submission : _.extendOwn({
                  id              : submission.id
                , comments        : JSON.parse(JSON.stringify(submission.comments))
                , lang            : submission.lang
                , lastUpdated     : new Date(submission.lastUpdated).toISOString()
                , submittedOn     : new Date(submission.submittedOn).toISOString()
                , shortCode       : submission.shortCode
                , submissionState : submission.submissionState
              }, JSON.parse(JSON.stringify(submission.submissionOpts || {})))
          });
          });
        })
        .catch(function(err) {
          return reply(errors.forbidden(err));
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  autosaveComments : function(request, reply) {
    var submission = request.pre.trinket;

    if (request.user.id.toString() === submission._creator.toString()) {
      if (submission.comments.length) {
        submission.comments[0].commentText = request.payload.comments;
      }
      else {
        submission.comments.push({
            commentText : request.payload.comments
          , commentType : 'student'
        });
      }

      return submission.save().then(request.success);
    }
    else {
      return reply(errors.forbidden());
    }
  },
  getUserSubmissionsForMaterial : function(request, reply) {
    var submissions = []
      , userId;

    if (request.params.userId) {
      if (request.user.hasPermission("view-assignment-submissions", "course", { id : request.params.courseId })) {
        userId = request.params.userId;
      }
      else {
        return reply(errors.forbidden());
      }
    }
    else {
      userId = request.user.id;
    }

    return Trinket.findByUserAndMaterial(userId, request.params.materialId)
      .then(function(trinkets) {
        // Shared with the LTI review panel, which binds the same directive.
        submissions = _.map(trinkets, submissionView.toSubmissionView);

        return request.success({
          data : submissions
        });
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  dashboardOverview : function(request, reply) {
    var course             = request.pre.course
      , listBy             = request.query.listBy || "assignment"
      , assignmentIndex    = {}
      , assignmentOverview = []
      , studentIndex       = {}
      , studentOverview    = []
      , studentIdList      = []
      , assignmentCount    = 0
      , hiddenUserCount    = 0;

    if (request.user.hasPermission("view-assignment-submissions", "course", { id : course.id })) {
      course.users.forEach(function(user) {
        if (listBy === "assignment" && course.userHiddenFromDashboard(user)) {
          hiddenUserCount++;
          return;
        }

        var userIdStr = user.userId.toString();
        studentIdList.push(userIdStr);
        var userJson = user.toJSON ? user.toJSON() : user;
        // Convert userId to string to avoid ObjectId serialization issues
        if (userJson.userId) {
          userJson.userId = userJson.userId.toString();
        }
        studentOverview.push( _.extendOwn({
            "not-started"      : 0
          , "started"          : 0
          , "submitted"        : 0
          , "completed"        : 0
          , "assignment-count" : 0
          , "onDashboard"      : !course.userHiddenFromDashboard(user)
        }, userJson ));

        studentIndex[ userIdStr ] = studentOverview.length - 1;
      });

      return course.populate({
          path   : 'lessons',
          select : 'materials'
        })
        .then(function() {
          return Promise.all(course.lessons.map(function(lesson) {
            return lesson.populate({
              path   : 'materials',
              select : 'type',
              match  : { $or : [ { isDraft : { $ne : true } }, { type : "assignment" } ] }
            });
          }));
        })
        .then(function() {
          course.lessons.forEach(function(lesson) {
            lesson.materials.forEach(function(material) {
              assignmentOverview.push({
                  id            : material.id
                , "not-started" : studentOverview.length
                , "started"     : 0
                , "submitted"   : 0
                , "completed"   : 0
                , "user-count"  : studentOverview.length
                , "hidden"      : hiddenUserCount
              });

              assignmentIndex[ material.id ] = assignmentOverview.length - 1;

              if (material.type === "assignment") {
                assignmentCount++;
              }
            });
          });

          for (var i = 0; i < studentOverview.length; i++) {
            studentOverview[i]["not-started"] = studentOverview[i]["assignment-count"] = assignmentCount;
          }

          return Trinket.courseDashboard(request.params.courseId);
        })
        .then(function(result) {
          result.forEach(function(submission) {
            var thisStudent    = submission._id.user ? submission._id.user.toString() : '';
            var thisAssignment = submission._id.material ? submission._id.material.toString() : '';

            var thisAssignmentIndex = assignmentIndex[ thisAssignment ];
            var thisStudentIndex    = studentIndex[ thisStudent ];

            // likely an assignment that was removed from the course
            // also ensure this student still a member of the course
            // lastly, thisStudentIndex will be undefined if user hidden from dashboard view
            if (typeof thisAssignmentIndex === "undefined" || typeof thisStudentIndex === "undefined") {
              return;
            }

            if (submission.states.indexOf("submitted") >= 0) {
              assignmentOverview[ thisAssignmentIndex ].submitted++;
              studentOverview[ thisStudentIndex ].submitted++;
            }
            else if (submission.states.indexOf("completed") >= 0) {
              assignmentOverview[ thisAssignmentIndex ].completed++;
              studentOverview[ thisStudentIndex ].completed++;
            }
            else if (submission.states.indexOf("started") >= 0 || submission.states.indexOf("modified") >= 0) {
              assignmentOverview[ thisAssignmentIndex ].started++;
              studentOverview[ thisStudentIndex ].started++;
            }

            assignmentOverview[ thisAssignmentIndex ]["not-started"]--;
            studentOverview[ thisStudentIndex ]["not-started"]--;
          });

          return request.success({
            data : listBy === "assignment" ? assignmentOverview : studentOverview
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  materialDashboard : function(request, reply) {
    var course   = request.pre.course
      , userList = []
      , overview;

    if (request.user.hasPermission("view-assignment-submissions", "course", { id : course.id })) {
      course.users.forEach(function(user) {
        if (!course.userHiddenFromDashboard(user)) {
          userList.push(user.userId.toString());
        }
      });

      overview = {
          id            : request.params.materialId
        , "not-started" : userList.length
        , "started"     : 0
        , "submitted"   : 0
        , "completed"   : 0
        , "user-count"  : userList.length
      };

      // TODO: add filter option to this courseDashboard call/method
      return Trinket.courseDashboard(request.params.courseId)
        .then(function(result) {
          result.forEach(function(submission) {
            // ensure this student still a member of the course
            if (userList.indexOf(submission._id.user.toString()) < 0) {
              return;
            }

            if (submission._id.material.toString() === request.params.materialId) {
              if (submission.states.indexOf("submitted") >= 0) {
                overview.submitted++;
              }
              else if (submission.states.indexOf("completed") >= 0) {
                overview.completed++;
              }
              else if (submission.states.indexOf("started") >= 0 || submission.states.indexOf("modified") >= 0) {
                overview.started++;
              }

              overview["not-started"]--;
            }
          });

          return request.success({
            data : overview
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  // POST /api/courses/{courseId}/materials/{materialId}/lms-grades
  //
  // Ask the LMS which of this assignment's submissions a human has already graded, so
  // an instructor does not have to mark the same work done twice — once in the LMS,
  // once here.
  //
  // Deliberately its OWN endpoint rather than folded into the dashboard fetch. Each
  // check is an HTTP round trip to the LMS, and LMS-side trouble is invisible to us
  // (a platform that stalls or errors leaves no trace in our logs), so it must never
  // sit on the instructor's dashboard load and present as "trinket is slow". The
  // dashboard renders from local state first and calls this after.
  //
  // POST, not GET: it has a side effect (it records what the LMS said).
  lmsGrades : function(request, reply) {
    var course = request.pre.course;

    if (!request.user.hasPermission("view-assignment-submissions", "course", { id : course.id })) {
      return reply(errors.forbidden());
    }

    return Promise.resolve(Trinket.find({ materialId : request.params.materialId }))
      .then(function(subs) {
        var now = Date.now();
        var candidates = (subs || []).filter(function(s) {
          if (!s || s.lmsGraded) { return false; }                     // already known
          if (["submitted", "submittedLate", "modified"].indexOf(s.submissionState) < 0) {
            return false;                                              // nothing to grade yet
          }
          var last = s.lmsCheckedAt ? new Date(s.lmsCheckedAt).getTime() : 0;
          return !(last && (now - last) < ltiGradeSync.DEFAULT_THROTTLE_MS);
        });

        // Cap the work per request. A class where everyone was graded at once
        // converges over a couple of loads instead of making one request wait on
        // dozens of LMS round trips — and it keeps any batched read under the
        // backend's `in` limit.
        var batch = candidates.slice(0, ltiGradeSync.MAX_PER_REQUEST);
        var graded = [];

        // Bounded concurrency: a class is tens of students, and firing every request
        // at the platform at once is how you get rate-limited.
        function worker() {
          if (!batch.length) { return Promise.resolve(); }
          var sub = batch.shift();
          return ltiGradeSync.syncSubmission(sub, { now : now }).then(function(res) {
            if (res && res.graded) { graded.push(String(sub.id)); }
            return worker();
          });
        }
        var lanes = [];
        for (var i = 0; i < ltiGradeSync.SYNC_CONCURRENCY; i++) { lanes.push(worker()); }

        return Promise.all(lanes).then(function() {
          return request.success({
              checked   : Math.min(candidates.length, ltiGradeSync.MAX_PER_REQUEST)
            , graded    : graded
            , remaining : Math.max(0, candidates.length - ltiGradeSync.MAX_PER_REQUEST)
          });
        });
      })
      .catch(function(err) {
        // Never fail the caller: this is an enrichment, not the dashboard itself.
        console.error('[lmsGrades] sync failed (best-effort):', (err && err.message) || err);
        return request.success({ checked : 0, graded : [], remaining : 0 });
      });
  },
  getMaterialSubmissionsForAllUsers : function(request, reply) {
    var course = request.pre.course
      , submissions = []
      , userIndex   = {};

    if (request.user.hasPermission("view-assignment-submissions", "course", { id : course.id })) {
      submissions = _.map(course.users, function(user, index) {
        var userIdStr = user.userId ? user.userId.toString() : '';
        userIndex[ userIdStr ] = index;
        var userJson = user.toJSON ? user.toJSON() : user;
        // Convert userId to string to avoid ObjectId serialization issues
        if (userJson.userId) {
          userJson.userId = userJson.userId.toString();
        }
        return _.extendOwn({
            state       : "not-started"
          , lang        : ""
          , trinketId   : ""
          , shortCode   : ""
          , lastUpdated : ""
          , onDashboard : !course.userHiddenFromDashboard(user)
        }, userJson);
      });

      return Trinket.findSubmissionsByMaterial(request.params.materialId)
        .then(function(users) {
          users.forEach(function(user) {
            var odbc = user._id ? user._id.toString() : '';
            if (typeof userIndex[ odbc ] !== "undefined") {
              var thisIndex = userIndex[ odbc ];
              var states    = _.groupBy(user.submissions, "state");

              if (states.submittedLate) {
                _.extend(submissions[ thisIndex ], states.submittedLate[0] );
                submissions[ thisIndex ].submittedOn = new Date(submissions[ thisIndex ].submittedOn).toISOString();
              }
              else if (states.submitted) {
                _.extend(submissions[ thisIndex ], states.submitted[0] );
                submissions[ thisIndex ].submittedOn = new Date(submissions[ thisIndex ].submittedOn).toISOString();
              }
              else if (states.completed) {
                _.extend(submissions[ thisIndex ],
                  states.completed.length > 1 ? _.sortBy(states.completed, 'lastUpdated').pop() : states.completed[0]
                );

                // TODO? set lastUpdated to comments feedback commented date?
              }
              else if (states.started) {
                _.extend(submissions[ thisIndex ], states.started[0] );
                submissions[ thisIndex ].startedOn = new Date(submissions[ thisIndex ].startedOn).toISOString();
              }
              else if (states.modified) {
                _.extend(submissions[ thisIndex ], states.modified[0] );
                submissions[ thisIndex ].state = "started";
                submissions[ thisIndex ].startedOn = new Date(submissions[ thisIndex ].startedOn).toISOString();
              }

              // TODO? move this?
              submissions[ thisIndex ].lastUpdated = new Date(submissions[ thisIndex ].lastUpdated).toISOString();
              // Convert ObjectIds to strings to avoid serialization issues
              if (submissions[ thisIndex ].trinketId && submissions[ thisIndex ].trinketId.toString) {
                submissions[ thisIndex ].trinketId = submissions[ thisIndex ].trinketId.toString();
              }
              submissions[ thisIndex ].comments    = JSON.parse(JSON.stringify(submissions[ thisIndex ].comments));

              if (submissions[ thisIndex ].submissionOpts) {
                _.extendOwn(submissions[ thisIndex ], JSON.parse(JSON.stringify(submissions[ thisIndex ].submissionOpts)));
              }
            }
          });

          // Enrich with LMS gradebook links if this material has an LTI resource link.
          // Two lookups (link → platform) + one batched identity lookup — not on a hot path.
          return Promise.resolve(LtiResourceLink.findAssignmentLink(course.id, request.params.materialId))
            .then(function(link) {
              console.log('[submissions] ltiLink', { courseId: course.id, materialId: request.params.materialId, found: !!link, targetType: link && link.targetType, platformId: link && link.platformId });
              if (!link || !link.platformId) return request.success({ data: submissions });
              return Promise.resolve(LtiPlatform.findById(link.platformId))
                .then(function(platform) {
                  if (!platform) return request.success({ data: submissions });
                  var gradebookUrl = ltiGradebookUrl.buildCourseUrl(platform, link);
                  var lmsLabel     = ltiGradebookUrl.lmsName(platform);
                  var userIds      = submissions.map(function(s) { return s.userId; }).filter(Boolean);
                  return Promise.resolve(LtiUserIdentity.findByUsersAndIss(userIds, platform.issuer))
                    .then(function(identities) {
                      var subByUserId = {};
                      (identities || []).forEach(function(id) {
                        subByUserId[String(id.userId)] = id.sub;
                      });
                      submissions.forEach(function(s) {
                        s.lmsGradebookUrl = gradebookUrl;
                        s.lmsName         = lmsLabel;
                        s.lmsStudentUrl   = ltiGradebookUrl.buildStudentUrl(
                          platform, link, subByUserId[String(s.userId)]);
                      });
                      return request.success({ data: submissions });
                    })
                    .catch(function(err) { console.log('[submissions] identity-err', err && err.message); return request.success({ data: submissions }); });
                })
                .catch(function(err) { console.log('[submissions] platform-err', err && err.message); return request.success({ data: submissions }); });
            })
            .catch(function(err) { console.log('[submissions] link-err', err && err.message); return request.success({ data: submissions }); });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  exportMaterialFeedbackCsv : function(request, reply) {
    var course = request.pre.course;

    if (!request.user.hasPermission('view-assignment-submissions', 'course', { id : course.id })) {
      return reply(errors.forbidden());
    }

    var materialId = request.params.materialId;
    var material = null;
    course.lessons && course.lessons.forEach && course.lessons.forEach(function(lesson) {
      (lesson.materials || []).forEach(function(m) {
        if (m && m._id && m._id.toString() === String(materialId)) material = m;
      });
    });
    var materialSlug = (material && material.slug) || String(materialId);

    return Trinket.findSubmissionsByMaterial(materialId)
      .then(function(grouped) {
        var byUserId = {};
        grouped.forEach(function(g) {
          byUserId[ g._id ? g._id.toString() : '' ] = g.submissions || [];
        });

        var rows = [[
          'username', 'displayName', 'email',
          'state', 'submittedOn', 'lastUpdated',
          'feedbackText', 'feedbackOn', 'feedbackBy',
          'trinketShortCode', 'trinketLang', 'submissionUrl'
        ]];

        (course.users || []).forEach(function(courseUser) {
          var userJson = courseUser.toJSON ? courseUser.toJSON() : courseUser;
          var uid = userJson.userId ? userJson.userId.toString() : '';
          var submissions = byUserId[uid] || [];
          var current = submissionsUtil.pickCurrentSubmission(submissions);
          var feedback = submissionsUtil.latestFeedbackComment(submissions);

          var shortCode = current ? (current.shortCode || '') : '';
          var lang      = current ? (current.lang || '')      : '';
          var url       = shortCode ? ('/embed/' + lang + '/' + shortCode) : '';

          rows.push([
            userJson.username || '',
            userJson.displayName || '',
            userJson.email || '',
            current ? (current.state || '') : 'not-started',
            current && current.submittedOn ? new Date(current.submittedOn).toISOString() : '',
            current && current.lastUpdated ? new Date(current.lastUpdated).toISOString() : '',
            feedback ? (feedback.commentText || '') : '',
            feedback && feedback.commented ? new Date(feedback.commented).toISOString() : '',
            feedback ? (feedback.displayName || feedback.username || '') : '',
            shortCode,
            lang,
            url
          ]);
        });

        return new Promise(function(resolve, rejectPromise) {
          csvStringify(rows, function(err, output) {
            if (err) return rejectPromise(err);
            resolve(output);
          });
        });
      })
      .then(function(csvBody) {
        var filename = 'feedback-' + materialSlug + '-' + moment().format('YYYY-MM-DD') + '.csv';
        return reply(csvBody)
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', 'attachment; filename="' + filename + '"');
      })
      .catch(function(err) {
        return reply(err);
      });
  },
  exportCourseSubmissions : function(request, reply) {
    var course = request.pre.course;

    if (!request.user.hasPermission('view-assignment-submissions', 'course', { id : course.id })) {
      return reply(errors.forbidden());
    }

    var userId = request.user.id;

    return Export.findPendingOrProcessing(userId)
      .then(function(existingExport) {
        if (existingExport) {
          request.fail({
            error: 'Export already in progress',
            exportId: existingExport._id.toString()
          });
          return Promise.reject({ handled: true });
        }

        var exportRecord = new Export({
          _owner   : userId,
          type     : 'course-submissions',
          courseId : course.id,
          status   : 'pending'
        });

        return exportRecord.save();
      })
      .then(function(saved) {
        // Nowhere to store the archive? Refuse now. lib/workers/exports.js reads
        // config.aws.buckets.exports.name directly, and reaching it unconfigured
        // took down the whole Cloud Run instance on rba-merge-trial (2026-09-03).
        var noStorage = exportGuard.failIfNoStorage(saved, request);
        if (noStorage) { return noStorage; }

        // Build the archive INSIDE this request rather than queueing it.
        //
        // The queue cannot deliver here: on Cloud Run the worker registers only
        // under RUN_EXPORT_WORKER (which no Cloud Run deploy sets) and redis is
        // disabled, so the in-process queue discards the job — the export sat
        // 'pending' forever while the UI polled it. Worse, queued work would run
        // via setImmediate AFTER the response, exactly when Cloud Run throttles
        // CPU, so even with a worker registered it would crawl.
        //
        // Doing it in-request keeps CPU allocated for the whole build and is the
        // shape the sibling exports already use successfully on these same
        // deploys: Feedback CSV, the single-trinket zip, and the whole-course zip.
        // The record/download machinery is unchanged — the client still polls the
        // exportId and downloads from the stored archive — so by the time we
        // reply the status it sees is 'completed' rather than 'pending'.
        var runner = require('../workers/exports');
        return Promise.resolve(runner.processStudentWorkExport({
          data : {
            action   : 'student-work-export',
            exportId : saved._id.toString(),
            userId   : userId
          }
        }))
        .then(function() {
          return request.success({
            success : true,
            data    : {
              exportId : saved._id.toString(),
              status   : 'completed'
            }
          });
        });
      })
      .catch(function(err) {
        if (err && err.handled) return;
        return reply(err);
      });
  },
  exportAssignmentSubmissions : function(request, reply) {
    var course = request.pre.course;

    if (!request.user.hasPermission('view-assignment-submissions', 'course', { id : course.id })) {
      return reply(errors.forbidden());
    }

    var userId    = request.user.id;
    var materialId = request.params.materialId;

    return Export.findPendingOrProcessing(userId)
      .then(function(existingExport) {
        if (existingExport) {
          request.fail({
            error: 'Export already in progress',
            exportId: existingExport._id.toString()
          });
          return Promise.reject({ handled: true });
        }

        var exportRecord = new Export({
          _owner     : userId,
          type       : 'assignment-submissions',
          courseId   : course.id,
          materialId : materialId,
          status     : 'pending'
        });

        return exportRecord.save();
      })
      .then(function(saved) {
        // Nowhere to store the archive? Refuse now. lib/workers/exports.js reads
        // config.aws.buckets.exports.name directly, and reaching it unconfigured
        // took down the whole Cloud Run instance on rba-merge-trial (2026-09-03).
        var noStorage = exportGuard.failIfNoStorage(saved, request);
        if (noStorage) { return noStorage; }

        // Build the archive INSIDE this request rather than queueing it.
        //
        // The queue cannot deliver here: on Cloud Run the worker registers only
        // under RUN_EXPORT_WORKER (which no Cloud Run deploy sets) and redis is
        // disabled, so the in-process queue discards the job — the export sat
        // 'pending' forever while the UI polled it. Worse, queued work would run
        // via setImmediate AFTER the response, exactly when Cloud Run throttles
        // CPU, so even with a worker registered it would crawl.
        //
        // Doing it in-request keeps CPU allocated for the whole build and is the
        // shape the sibling exports already use successfully on these same
        // deploys: Feedback CSV, the single-trinket zip, and the whole-course zip.
        // The record/download machinery is unchanged — the client still polls the
        // exportId and downloads from the stored archive — so by the time we
        // reply the status it sees is 'completed' rather than 'pending'.
        var runner = require('../workers/exports');
        return Promise.resolve(runner.processStudentWorkExport({
          data : {
            action   : 'student-work-export',
            exportId : saved._id.toString(),
            userId   : userId
          }
        }))
        .then(function() {
          return request.success({
            success : true,
            data    : {
              exportId : saved._id.toString(),
              status   : 'completed'
            }
          });
        });
      })
      .catch(function(err) {
        if (err && err.handled) return;
        return reply(err);
      });
  },
  getUserSubmissionsForCourse : function(request, reply) {
    var course      = request.pre.course
      , user        = request.pre.user
      , submissions = {}
      , lastSubmission, i;

    /*
     * Assumption: client-side has full list of lessons and materials to appropriately display
     */

    if (request.user.hasPermission("view-assignment-submissions", "course", { id : course.id })) {
      // make sure this student is a member of the course
      if (!_.findWhere(course.users, { username : user.username })) {
        return reply(errors.notFound());
      }

      return Trinket.findSubmissionsByUserAndCourse(user._id, course._id)
        .then(function(trinkets) {
          for (i = 0; i < trinkets.length; i++) {
            var states = _.groupBy(trinkets[i].submissions, "state");

            if (states.submittedLate) {
              lastSubmission = states.submittedLate[0];
            }
            else if (states.submitted) {
              lastSubmission = states.submitted[0];
            }
            else if (states.completed) {
              lastSubmission = states.completed.length > 1
                ? _.sortBy(states.completed, 'lastUpdated').pop()
                : states.completed[0];
            }
            else if (states.started) {
              lastSubmission = states.started[0];
            }
            else if (states.modified) {
              lastSubmission = states.modified[0];
            }

            // Convert ObjectIds to strings for client compatibility
            var materialIdStr = trinkets[i]._id ? trinkets[i]._id.toString() : '';
            var trinketIdStr = lastSubmission.trinketId ? lastSubmission.trinketId.toString() : '';
            submissions[ materialIdStr ] = {
                id          : trinketIdStr
              , comments    : JSON.parse(JSON.stringify(lastSubmission.comments))
              , lang        : lastSubmission.lang
              , lastUpdated : new Date(lastSubmission.lastUpdated).toISOString()
              , startedOn   : lastSubmission.startedOn   ? new Date(lastSubmission.startedOn).toISOString()   : undefined
              , submittedOn : lastSubmission.submittedOn ? new Date(lastSubmission.submittedOn).toISOString() : undefined
              , shortCode   : lastSubmission.shortCode
              , state       : lastSubmission.state === "modified" ? "started" : lastSubmission.state
              , userId      : user.id
            };

            if (lastSubmission.submissionOpts) {
              submissions[ trinkets[i]._id ].submissionOpts = lastSubmission.submissionOpts;
            }
          }

          return request.success({
            data : submissions
          });
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  autosaveFeedbackComments : function(request, reply) {
    var submission = request.pre.trinket
      , index;

    if (request.user.hasPermission("send-submission-feedback", "course", { id : submission.courseId })) {
      index = _.findIndex(submission.comments, function(comment) {
        return comment.commentType === 'feedback-draft';
      });

      if (index >= 0) {
        submission.comments[index].commentText = request.payload.comments;
      }
      else {
        submission.comments.push({
            commentText : request.payload.comments
          , commentType : 'feedback-draft'
        });
      }

      return submission.save().then(request.success);
    }
    else {
      return reply(errors.forbidden());
    }
  },
  autosaveSubmissionOpt : function(request, reply) {
    var submission = request.pre.trinket;

    if (request.user.hasPermission("send-submission-feedback", "course", { id : submission.courseId })) {
      _.extendOwn(submission.submissionOpts, request.payload);

      return submission.save().then(request.success);
    }
    else {
      return reply(errors.forbidden());
    }
  },
  sendFeedback : function(request, reply) {
    var course = request.pre.course
      , submission, serialized, revision, lastIndex, feedbackIndex, previousRevisionId;

    if (request.user.hasPermission("send-submission-feedback", "course", { id : course.id })) {
      return Trinket.findById(request.payload.trinketId)
        .then(function(trinket) {
          submission = trinket;
          serialized = request.payload.code;

          if (submission.comments && submission.comments.length) {
            lastIndex = submission.comments.length - 1;
            if (submission.comments[lastIndex].commentType === "feedback") {
              feedbackIndex = lastIndex;
            }
          }

          if (submission.submissionState === "completed" && typeof feedbackIndex !== "undefined") {
            previousRevisionId = submission.comments[feedbackIndex].trinketId;
            return Trinket.findById(previousRevisionId);
          }
          else {
            return new Trinket({
                code            : serialized.code
              , assets          : serialized.assets
              , settings        : serialized.settings
              , _parent         : submission.id // << link back to submission...
              , _creator        : request.user
              , lang            : trinket.lang
            });
          }
        })
        .then(function(rev) {
          revision = rev;
          // updating a previous version
          if (previousRevisionId) {
            revision.code     = serialized.code;
            revision.assets   = serialized.assets;
            revision.settings = serialized.settings;
          }

          return revision.save();
        })
        .then(function(savedRevision) {
          revision = savedRevision;

          submission.submissionState = "completed";
          submission.submissionOpts  = {
              includeRevision : request.payload.includeRevision
            , allowResubmit   : request.payload.allowResubmit
          };

          if (feedbackIndex) {
            submission.comments[feedbackIndex].commentText = request.payload.comments;
          }
          else {
            submission.comments.push({
                userId           : request.user.id
              , username         : request.user.username
              , displayName      : request.user.name
              , email            : request.user.email
              , avatar           : request.user.normalizeAvatar()
              , commentText      : request.payload.comments
              , commentType      : 'feedback'
              , trinketId        : revision.id
              , trinketLang      : revision.lang
              , trinketShortCode : revision.shortCode
            });
          }

          return submission.save();
        })
        .then(function(savedSubmission) {
          submission = savedSubmission;
          return request.success({
            data : _.extendOwn({
                id              : submission.id
              , comments        : JSON.parse(JSON.stringify(submission.comments))
              , lang            : submission.lang
              , lastUpdated     : new Date(submission.lastUpdated).toISOString()
              , shortCode       : submission.shortCode
              , submissionState : submission.submissionState
            }, JSON.parse(JSON.stringify(submission.submissionOpts || {})))
          });
        })
        .catch(function(err) {
          return reply(err);
        });
    }
    else {
      return reply(errors.forbidden());
    }
  },
  acceptSubmission : function(request, reply) {
    var course  = request.pre.course
      , trinket = request.pre.trinket;

    if (request.user.hasPermission("send-submission-feedback", "course", { id : course.id })) {
      trinket.submissionState = "submitted";

      return trinket.save()
        .then(function(savedTrinket) {
          return request.success({
            data : savedTrinket
          });
        });
    }
    else {
      return reply(errors.forbidden());
    }
  }
}

function generateAccessCode() {
  var code     = []
    , possible = "ABCDEFGHJKLMNPRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    , i;

  for (i = 0; i < 6; i++) {
    code.push(possible.charAt(Math.floor(Math.random() * possible.length)));
  }

  return code.join("");
}
