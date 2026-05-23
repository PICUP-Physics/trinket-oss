var errors = require('@hapi/boom'),
    _      = require('underscore'),
    config = require('config'),
    ObjectUtils = require('../util/objectUtils');

function getCoursePageData(user, course) {
  return {
    instructor : {
      slug   : user.username,
      id     : user.id,
      name   : user.name,
      avatar : user.avatar
    },
    course : {
      id          : course.id,
      slug        : course.slug,
      name        : course.name,
      ownerSlug   : course.ownerSlug,
      description : course.description
    }
  };
}

module.exports = {
  viewCourses : function(request, reply) {
    var visibleCourses;

    // get all owned courses for user we're viewing
    return request.pre.user.getOwnedCourses()
      .then(function(courses) {
        // ensure no null or undefined values
        courses = courses.filter(function(course) {
          return course && !course.archived;
        });

        if (request.user && request.user.id === request.pre.user.id) {
          visibleCourses = courses;
        }
        else {
          // filter by visibility and permissions
          visibleCourses = courses.filter(function(course) {
            if ((course.globalSettings.courseType === 'public' || course.globalSettings.courseType === 'open')
            ||  (request.user && request.user.hasPermission('view-course-content', 'course', { id : course.id }))) {
              return true;
            }
          });
        }

        request.success({
          instructor : {
            slug : request.pre.user.username,
            name : request.pre.user.name
          },
          courses : visibleCourses
        });
      });
  },

  viewClass : function(request, reply) {
    var course = request.pre.course
      , result;

    if (!course.archived && ((course.globalSettings.courseType === 'public' || course.globalSettings.courseType === 'open')
    ||  (request.user && request.user.hasPermission('view-course-content', 'course', { id : course.id })))) {
      result = getCoursePageData(request.pre.user, course);

      if (request.user) {
        result.canEdit            = request.user.hasPermission("manage-course-content", "course", { id : course.id });
        result.canViewSubmissions = request.user.hasPermission("view-assignment-submissions", "course", { id : course.id });

        // special setting to allow anyone to make a copy of the course
        // this setting isn't yet publicly available
        result.canCopy = !result.canEdit && (course.globalSettings.copyable || course.globalSettings.courseType === "open");
      }

      request.success(result);
    }
    else {
      return Course.findFeaturedForUser(request.user)
        .then(function(courses) {
          courses = _.map(courses, function(course) {
            page        = course.page;
            course      = ObjectUtils.serialize(course);
            course.page = page || "";

            return course;
          });

          return request.success({
            course: {},
            courses: courses,
          });
        })
    }
  },

  getClass : function(request, reply) {
    var course = request.pre.course,
        result;

    result = {
      course : {
        id:   course.id,
        name: course.name
      },
      sessions : []
    };

    course.sessions.forEach(function(session) {
      var sessionData = {
        id: session.id,
        name: session.name,
        slug: session.slug,
        materials: []
      };

      session.materials.forEach(function(material) {
        if (material.canView()) {
          sessionData.materials.push({
            id: material.id,
            name: material.name,
            slug: material.slug,
            content: material.content
          });
        }
      });

      result.sessions.push(sessionData);
    });

    request.success(result);
  },

  acceptInvitation : function(request, reply) {
    var courseUrl;

    return CourseInvitation.findByToken(request.params.token)
      .then(function(invitation) {
        if (invitation) {
          return Course.findById(invitation.courseId)
            .then(function(course) {
              if (request.user) {
                if (invitation.status === "accepted") {
                  if (request.user.inCourse(invitation.courseId.toString())) {
                    courseUrl = "/" + course.ownerSlug + "/courses/" + course.slug;
                    request.yar.flash("info", "You've already joined that course! View <a href='" + courseUrl + "' class='text-link'><strong>" + course.name + "</strong></a> now.");
                  }
                  else {
                    request.yar.flash("warning", "Sorry, that invitation has already been used. Please contact your instructor to get another link.");
                  }

                  return reply().redirect("/home");
                }
                else {
                  return course.addUser(request.user, ['course-student'])
                    .then(function() {
                      invitation.status = "accepted";
                      return invitation.save();
                    })
                    .then(function() {
                      request.yar.flash("acceptedCourseInvitation", { course : { name: course.name, ownerSlug: course.ownerSlug, slug: course.slug } }, true);
                      return reply().redirect('/home');
                    });
                }
              }
              else {
                request.yar.set("next", request.url.path);
                return reply().redirect("/login");
              }
            })
            .catch(function(err) {
              return reply(err);
            });
        }
        else {
          request.yar.flash("warning", "Sorry, that link isn't valid. Please check the link and try again or contact your instructor for help.");

          return request.user ? reply().redirect("/home") : reply().redirect("/login");
        }
      })
      .catch(function(err) {
        return reply(err);
      });
  },

  joinFromLink : function(request, reply) {
    var courseUrl;

    Course.findByAccessCode(request.params.accessCode, function(err, course) {
      if (err) {
        return reply(err);
      }

      if (request.user) {
        if (!course) {
          request.yar.flash("warning", "Sorry, that link isn't valid. Please check the link and try again or contact your instructor for help.");
          return reply().redirect("/home");
        }

        if (request.user.inCourse(course.id)) {
          courseUrl = "/" + course.ownerSlug + "/courses/" + course.slug;
          request.yar.flash("info", "You've already joined that course! View <a href='" + courseUrl + "' class='text-link'><strong>" + course.name + "</strong></a> now.");
          return reply().redirect("/home");
        }
        else {
          return course.addUser(request.user, ["course-student"])
            .then(function(result) {
              request.yar.flash("acceptedCourseInvitation", { course : { name: course.name, ownerSlug: course.ownerSlug, slug: course.slug } }, true);
              return reply().redirect('/home');
            })
            .catch(function(err) {
              request.yar.flash("warning", "Sorry, we had a problem adding you to that course. Please try again.");
              return reply().redirect("/home");
            });
        }
      }
      else {
        request.yar.set("next", request.url.path);
        return reply().redirect("/login");
      }
    });
  }
};
