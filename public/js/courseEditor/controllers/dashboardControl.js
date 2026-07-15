(function(angular) {
  'use strict';

  return angular
    .module("courseEditor")
    .controller("dashboardControl", ['$scope', '$location', '$routeParams', '$filter', '$timeout', '$sce', 'Restangular', 'trinketCourse', 'trinketRoles', 'markdownParser', function($scope, $location, $routeParams, $filter, $timeout, $sce, Restangular, trinketCourse, trinketRoles, markdownParser) {
      var cache = TrinketIO.import("utils.cache");

      var parser = markdownParser({
        $scope:  $scope,
        preview: false
      });

      $scope.assignmentsOverview = {};
      $scope.studentsOverview    = {};

      $scope.users       = [];
      $scope.working     = {};
      $scope.hiddenUsers = [];
      $scope.showHidden  = false;

      $scope.loading = false;
      $scope.loadingError = false;

      $scope.prev = {
          student    : undefined
        , assignment : undefined
      };
      $scope.next = {
          student    : undefined
        , assignment : undefined
      };

      $scope.viewingSubmission = {
        user : null
        , id : null
      };

      $scope.stateDisplay = {
          "not-started" : {
              text : "Not Started"
            , icon : "fa-circle-o not-started"
          }
        , "started"     : {
              text      : "Started"
            , icon      : "fa-dot-circle-o started"
            , dateField : "startedOn"
          }
        , "submitted"   : {
              text      : "Submitted"
            , icon      : "fa-check-circle-o submitted"
            , dateField : "submittedOn"
          }
        , "submittedLate"     : {
              text      : "Late Submission"
            , icon      : "fa-check-circle-o submittedLate"
            , dateField : "submittedOn"
          }
        , "completed"   : {
              text      : "Feedback Sent"
            , icon      : "fa-check-circle completed"
            , dateField : "lastUpdated"
          }
      };

      $scope.viewType = cache.get("course-dashboard-view-type") || "assignment";

      $scope.viewOptions = {
          'assignment' : {
              label : 'Assignments'
            , class : 'fa fa-pencil-square-o fa-fw'
          }
        , 'student' : {
              label : 'Students'
            , class : 'fa fa-user fa-fw'
          }
      };

      $scope.showInstructions = false;

      $scope.feedbackForm = {
        comments : ""
      };

      $scope.students = undefined;
      $scope.hiddenStudents = undefined;
      $scope.showHidden = false;

      var viewMethods = {
        hide : {
          dashboard : function(user) {
            this.hiddenStudents.push( this.students.splice( this.students.indexOf(user), 1 )[0] );
          }.bind($scope)
        },
        show : {
          dashboard : function(user) {
            this.students.push( this.hiddenStudents.splice( this.hiddenStudents.indexOf(user), 1 )[0] );
          }.bind($scope)
        }
      };

      trinketCourse.getCourse($scope.courseId, { withDraftAssignments : true })
        .then(function(course) {
          var assignments = []
            , assignmentIndex;

          $scope.course = course;
          $scope.loading = true;

          // viewing a specific assignment for a list of users
          if ($routeParams.lessonSlug && $routeParams.materialSlug) { // material_dashboard
            angular.forEach($scope.course.lessons, function(lesson) {
              angular.forEach(lesson.materials, function(material) {
                if (material.type === "assignment") {
                  assignments.push({
                      lesson   : lesson
                    , material : material
                  });
                }

                if (lesson.slug === $routeParams.lessonSlug && material.slug === $routeParams.materialSlug) {
                  assignmentIndex = assignments.length - 1;
                  $scope.material = material;
                  if (!$scope.material.markup) {
                    $scope.material.get()
                      .then(function(result) {
                        if (result && result.content) {
                          $scope.material.content = result.content;
                          $scope.material.markup  = $sce.trustAsHtml('<div class="content">' + parser(result.content) + '</div>');
                          $timeout(function() {
                            MathJax.Hub.Queue(["Typeset",MathJax.Hub,"material"]);
                          });
                        }
                      });
                  }
                }
              });
            });

            // previous assignment
            if (assignmentIndex > 0 && assignments[ assignmentIndex - 1 ]) {
              $scope.prev.assignment = assignments[ assignmentIndex - 1 ];
            }
            else {
              $scope.prev.assignment = undefined;
            }

            // next assignment
            if (assignmentIndex < assignments.length && assignments[ assignmentIndex + 1 ]) {
              $scope.next.assignment = assignments[ assignmentIndex + 1 ];
            }
            else {
              $scope.next.assignment = undefined;
            }

            $scope.users = [];
            $scope.hiddenUsers = [];
            $scope.lmsGrading = null;

            $scope.material.customGETLIST("submissions")
              .then(function(users) {
                // Pick up LMS gradebook link from any entry (all share the same course-level URL).
                if (users.length && users[0].lmsGradebookUrl) {
                  $scope.lmsGrading = {
                    url:  users[0].lmsGradebookUrl,
                    name: users[0].lmsName || 'LMS'
                  };
                }
                // split user list into current and hidden lists
                angular.forEach(users, function(user) {
                  user.id = user.trinketId;
                  if (user.onDashboard) {
                    $scope.users.push(user);
                  }
                  else {
                    $scope.hiddenUsers.push(user);
                  }
                });

                $scope.loading = false;

                $timeout(function() {
                  $(document).foundation('dropdown', 'reflow');
                });
              }, function(err) {
                $scope.loadingError = true;
                $scope.loading = false;
              });
          }
          // viewing all assignments for a specific user
          else if ($routeParams.username) { // student_dashboard
            $scope.students = [];
            $scope.course.customGETLIST("users")
              .then(function(users) {
                var studentIndex;

                $scope.users       = users;
                $scope.student     = undefined;
                $scope.submissions = {};

                angular.forEach($filter('orderBy')(users, 'displayName'), function(user) {
                  if (!user.onDashboard) {
                    return;
                  }

                  $scope.students.push(user);

                  // ensure this user is in the course
                  if (user.username === $routeParams.username) {
                    $scope.student = user;
                    studentIndex = $scope.students.length - 1;
                  }
                });

                if (!$scope.student) {
                  throw new Error("Student not found.");
                }

                $scope.student.id = $scope.student.userId;

                // previous student
                if (studentIndex > 0 && $scope.students[ studentIndex - 1 ]) {
                  $scope.prev.student = $scope.students[ studentIndex - 1 ];
                }
                else {
                  $scope.prev.student = undefined;
                }

                // next student
                if (studentIndex < $scope.students.length && $scope.students[ studentIndex + 1 ]) {
                  $scope.next.student = $scope.students[ studentIndex + 1 ];
                }
                else {
                  $scope.next.student = undefined;
                }

                return $scope.student.customGET("submissions");
              })
              .then(function(submissions) {
                $scope.submissions = submissions;
                $scope.loading = false;

                $timeout(function() {
                  $(document).foundation('dropdown', 'reflow');
                });
              }, function(err) {
                $scope.viewDashboard();
              });
          }
          else { // course_dashboard
            // TODO? called too frequently...
            loadDashboardData();

            $timeout(function() {
              $(document).foundation('dropdown', 'reflow');
            });
          }
        });

      function loadDashboardData() {
        if ($scope.viewType === "assignment") {
          $scope.students = undefined;
          $scope.hiddenStudents = undefined;

          $scope.course.customGETLIST("dashboard")
            .then(function(results) {
              $scope.hiddenCount = 0;
              angular.forEach(results, function(material) {
                var materialId = material.id;
                delete material.id;
                $scope.assignmentsOverview[materialId] = Restangular.stripRestangular(material);

                if (typeof material.hidden !== "undefined") {
                  $scope.hiddenCount = material.hidden;
                }
              });
            });
        }
        else if ($scope.viewType === "student") {
          $scope.students = [];
          $scope.hiddenStudents = [];

          $scope.course.customGETLIST("dashboard", { listBy : "students" })
            .then(function(results) {
              angular.forEach(results, function(student) {
                if (student.onDashboard) {
                  $scope.students.push(student);
                }
                else {
                  $scope.hiddenStudents.push(student);
                }

                var studentId = student.userId;
                $scope.studentsOverview[studentId] = Restangular.stripRestangular(student);
              });
            });
        }
      }

      function scrollToTop($el) {
        $('html,body').animate({ scrollTop : $el.offset().top - 80 }, "slow");
      }

      $scope.toggleStudent = function(user) {
        if ($scope.viewingSubmission.user) {
          if ($scope.viewingSubmission.user !== user.userId) {
            $timeout(function() {
              $scope.toggleStudent(user);
            }, 800);
          }

          $scope.viewingSubmission.user = $scope.viewingSubmission.id = null;

          return;
        }

        if ($scope.isUserSubmissionViewable(user)) {
          $scope.viewingSubmission.user = $scope.viewingSubmission.id = null;

          var submission = $filter('filter')($scope.users, { userId : user.userId }, true);

          if (!submission.length && $scope.hiddenUsers.length) {
            submission = $filter('filter')($scope.hiddenUsers, { userId : user.userId }, true);
          }

          if (submission.length) {
            $scope.viewingSubmission.user = user.userId;

            scrollToTop( angular.element( document.querySelector("#student-row-" + user.userId) ) );
          }
        }
      }

      $scope.toggleAssignment = function(material) {
        // close any open cards
        if ($scope.viewingSubmission.id) {
          if ($scope.viewingSubmission.id !== $scope.submissions[ material.id ].id) {
            $timeout(function() {
              $scope.toggleAssignment(material);
            }, 800);
          }

          $scope.viewingSubmission.id = $scope.viewingSubmission.user = null;

          return;
        }

        if ($scope.isUserSubmissionViewable($scope.submissions[ material.id ])) {
          $scope.viewingSubmission.user = null;

          $scope.viewingSubmission.id = $scope.submissions[ material.id ].id;

          scrollToTop( angular.element( document.querySelector("#assignment-row-" + material.id) ) );
        }
      }

      $scope.canSendFeedback = function() {
        return trinketRoles.hasPermission("send-submission-feedback", "course", { id : $scope.courseId });
      }

      $scope.cancelFeedback = function() {
        $scope.viewingSubmission.user = $scope.viewingSubmission.id = null;
      }

      $scope.viewAssignment = function(lesson, material) {
        $location.path('/_dashboard/' + lesson.slug + '/' + material.slug);
      }

      $scope.viewDashboard = function() {
        $location.path('/_dashboard');
      }

      $scope.backToCourse = function() {
        $location.path('/');
      };

      $scope.backToPage = function() {
        $location.path('/' + $routeParams.lessonSlug + '/' + $routeParams.materialSlug);
      }

      $scope.viewStudent = function(student) {
        $location.path('/_dashboard/' + student.username);
      }

      $scope.changeView = function(viewType) {
        $scope.viewType = viewType;
        loadDashboardData();
      }
      $scope.$watch('viewType', function(newValue, oldValue) {
        cache.set("course-dashboard-view-type", newValue);
      });

      $scope.updateUserView = function(user, view, action) {
        $scope.working[ user.userId ] = true;
        $scope.course.customPOST({ user : user.userId, view : view, action : action }, "views")
          .then(
            function(result) {
              $scope.working[ user.userId ] = false;

              viewMethods[action][view](user);

              $(document).foundation('dropdown', 'reflow');
            },
            function(err) {
              $scope.working[ user.userId ] = false;
            }
          );
      }

      $scope.usingDates = function(material) {
        return material && material.trinket &&
          ( (material.trinket.availableOn    && material.trinket.availableOn.enabled) ||
            (material.trinket.hideAfter      && material.trinket.hideAfter.enabled)   ||
            (material.trinket.submissionsDue && material.trinket.submissionsDue.enabled) );
      }

      $scope.isUserSubmissionViewable = function(user) {
        return user && (user.state === 'submitted' || user.state === 'completed' || user.state === 'submittedLate');
      }
    }]);
})(window.angular);
