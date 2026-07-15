(function(angular) {
  return angular
    .module("courseEditor")
    .controller("UsersController", ['$scope', '$timeout', '$modalInstance', 'course', 'canAssignAssocRole', 'canManageAccess', 'currentMaterial', 'assignmentDashboard', 'Restangular', 'trinketConfig', function($scope, $timeout, $modalInstance, course, canAssignAssocRole, canManageAccess, currentMaterial, assignmentDashboard, Restangular, trinketConfig) {
      $scope.course              = course;
      $scope.canAssignAssocRole  = canAssignAssocRole;
      $scope.canManageAccess     = canManageAccess;
      $scope.currentMaterial     = currentMaterial;
      $scope.assignmentDashboard = assignmentDashboard;
      $scope.emailEnabled        = trinketConfig.get('emailEnabled');

      $scope.users    = [];
      $scope.user     = {};
      $scope.undo     = {};
      $scope.working  = {};
      $scope.showInfo = false;

      var viewMethods = {
        hide : {
          dashboard : function(user) {
            this.users[ this.users.indexOf(user) ].onDashboard = false;
          }.bind($scope),
          dashboardMessage : function() {
            return "User will no longer appear on dashboard.";
          }
        },
        show : {
          dashboard : function(user) {
            this.users[ this.users.indexOf(user) ].onDashboard = true;
          }.bind($scope),
          dashboardMessage : function() {
            return "User will appear on dashboard.";
          }
        }
      };

      $scope.showUser       = {};
      $scope.showInvitation = {};

      $scope.inviteForm = {
        studentList : ""
      };

      function parseCsvInput(text) {
        return text.split('\n')
          .map(function(line) { return line.trim(); })
          .filter(function(line) { return line.length > 0; })
          .map(function(line) {
            var parts = line.split(',').map(function(p) { return p.trim(); });
            var email = parts[parts.length - 1];
            var name  = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
            return { email: email, name: name };
          });
      }

      $scope.addingUser         = false;
      $scope.sendingInvitations = false;
      $scope.generatingCode     = false;
      $scope.showAddUsers       = false;

      $scope.formToggles = {
          email      : false
        , accessCode : false
        , addStudent : false
      };

      $scope.invitations    = {};
      $scope.invitationList = [];
      $scope.resent         = {};

      $scope.accessCode    = "";
      $scope.accessCodeUrl = "";

      var defaultRole = "student";

      $scope.course.customGETLIST("users")
        .then(function(users) {
          angular.forEach(users, function(user) {
            // e.g. course-student
            if (user.roles && user.roles.length) {
              user.role = user.roles[0].substring( user.roles[0].indexOf('-') + 1 );
            }
            else {
              user.role = defaultRole;
            }

            $scope.users.push(user);
          });

          $(document).foundation('dropdown', 'reflow');
          $(document).foundation('equalizer', 'reflow');
        });

      $scope.course.customGETLIST("invitations")
        .then(function(invitations) {
          $scope.invitationList = invitations;
          angular.forEach(invitations, function(invitation) {
            $scope.invitations[ invitation.email ] = invitation;
          });
          $(document).foundation('dropdown', 'reflow');
        });

      $scope.course.customGET("accessCode")
        .then(function(result) {
          if (result.success && result.accessCode) {
            $scope.accessCode    = result.accessCode;
            $scope.accessCodeUrl = trinketConfig.getUrl("/courses/join/" + result.accessCode);
          }
        });

      $scope.addUserToCourse = function() {
        $scope.addingUser = true;
        $scope.course.customPOST({ user : $scope.user.lookup }, "userLookup")
          .then(function(result) {
            if (result.success) {
              result.user.role = defaultRole;
              $scope.users.push(result.user);
              $scope.user.lookup = "";
              $(document).foundation('dropdown', 'reflow');
            }
            else if (result.alreadyListed) {
              // user already listed
              $('#add-user-messages').notify(
                "That user is already a member of the group."
                , { className : 'warning' }
              );
            }
            else {
              // user not found
              $('#add-user-messages').notify(
                "We had a problem finding or adding that user. Please try again."
                , { className : 'alert' }
              );
            }

            $scope.addingUser = false;
          }, function(err) {
            if (err && err.status === 404) {
              $('#add-user-messages').notify(
                "That user wasn't found. Please try a different username or email address."
                , { className : 'alert' }
              );

              $scope.addingUser = false;
            }
          });
      }

      $scope.removeUserFromCourse = function(user) {
        $scope.working[ user.userId ] = true;
        $scope.course.customDELETE("users/" + user.userId)
          .then(
            function(result) {
              // remember role
              $scope.undo[ user.userId ]    = true;
              $scope.working[ user.userId ] = false;
            },
            function(err) {
              $scope.working[ user.userId ] = false;
            }
          );
      }
      $scope.undoUserRemove = function(user) {
        $scope.working[ user.userId ] = true;
        $scope.course.customPOST({ user : user.userId }, "users")
          .then(
            function(result) {
              $scope.undo[ user.userId ]    = false;
              $scope.working[ user.userId ] = false;
              $(document).foundation('dropdown', 'reflow');
            },
            function(err) {
              $scope.working[ user.userId ] = false;
            }
          );
      }

      $scope.updateUserRole = function(user, role) {
        $('#user-role-' + user.userId).foundation('dropdown', 'closeall');
        $scope.course.customPOST({ user : user.userId, role : role }, "roles")
          .then(
            function(result) {
              user.role = role;
            },
            function(err) {
            }
          );
      }

      $scope.haveInvitations = function() {
        return Object.keys($scope.invitations).length;
      }

      $scope.inviteUsersToCourse = function() {
        $scope.sendingInvitations = true;

        var students = parseCsvInput($scope.inviteForm.studentList);
        $scope.course.customPOST({ students : students }, "invitations")
          .then(
            function(result) {
              var invitationsSent = 0;

              $timeout(function() {
                $scope.sendingInvitations    = false;
                $scope.inviteForm.studentList = "";
              }, 500);

              if (result.success) {
                angular.forEach(result.invitations, function(invitation) {
                  $scope.invitations[ invitation.email.toLowerCase() ] = Restangular.restangularizeElement($scope.course, invitation, 'invitations');
                  if (invitation.status !== "invalid") {
                    invitationsSent++;
                  }
                });

                if (invitationsSent) {
                  $("#invitations-sent-messages").notify(
                    invitationsSent + " student(s) added. They can now sign up with their email address."
                    , { className : 'success' }
                  );
                }
                else {
                  $("#invitations-sent-messages").notify(
                    "No new students added."
                    , { className : 'warning' }
                  );
                }
              }
            },
            function(err) {
              $scope.sendingInvitations = false;
            }
          );
      }

      $scope.deleteInvitation = function(invitation) {
        $scope.course.customDELETE("invitations/" + invitation.id)
          .then(function(result) {
            delete $scope.invitations[ invitation.email ];
          });
      }

      $scope.resendInvitation = function(invitation) {
        if (invitation.status === "invalid") {
          return;
        }

        $scope.working[ invitation.email ] = true;
        invitation.customPUT({ status : "resend" }, "resend")
          .then(function(result) {
            $scope.working[ invitation.email ] = false;
            $scope.resent[ invitation.email ]  = true;
            $timeout(function() {
              delete $scope.resent[ invitation.email ];
            }, 3000);
          });
      }

      $scope.updateInvitationEmail = function(invitation, email) {
        var oldEmail = invitation.email;

        if (oldEmail.toLowerCase() !== email.toLowerCase()) {
          invitation.customPUT({ email : email }, 'email')
            .then(function(result) {
              if (result.success) {
                delete $scope.invitations[ oldEmail ];
                $scope.invitations[ email ] = Restangular.restangularizeElement($scope.course, result.invitation, 'invitations');
                $scope.invitations[ email ].acceptUrl = trinketConfig.getUrl("/courses/accept/" + $scope.invitations[ email ].token);
              }
              else if (result.message) {
                $("#invitations-update-messages").notify(
                  result.message
                  , { className : 'warning' }
                );
                invitation.email = oldEmail;
              }
            }, function(err) {
              invitation.email = oldEmail;
            });
        }
      }

      $scope.updateUserView = function(user, view, action) {
        $scope.working[ user.userId ] = true;
        $scope.course.customPOST({ user : user.userId, view : view, action : action }, "views")
          .then(
            function(result) {
              $scope.undo[ user.userId ]    = false;
              $scope.working[ user.userId ] = false;

              viewMethods[action][view](user);

              $(document).foundation('dropdown', 'reflow');

              if (viewMethods[action][view + 'Message']) {
                $('#course-users-messages').notify(
                  viewMethods[action][view + 'Message']()
                  , { className : 'success' }
                );
              }

              // if on an assignment, trigger dashboard update
              // (this should probably really be some sort of service...)
              if ($scope.currentMaterial && $scope.currentMaterial.type === 'assignment') {
                $scope.assignmentDashboard($scope.currentMaterial);
              }
            },
            function(err) {
              $scope.working[ user.userId ] = false;
            }
          );
      }

      $scope.toggleForm = function(name) {
        angular.forEach($scope.formToggles, function(val, key) {
          if (key === name) {
            $scope.formToggles[key] = !$scope.formToggles[key];
          }
          else {
            $scope.formToggles[key] = false;
          }
        });
      }

      $scope.uploadCsvFile = function(file) {
        if (!file) { return; }
        var reader = new FileReader();
        reader.onload = function(e) {
          $scope.$apply(function() {
            $scope.inviteForm.studentList = e.target.result;
          });
        };
        reader.readAsText(file);
      };

      $scope.openCsvUpload = function() {
        var el = document.getElementById('csv-upload-input');
        if (el) { el.click(); }
      };

      $scope.generateAccessCode = function() {
        $scope.generatingCode = true;
        $scope.course.customPOST({ payload : true }, "accessCode")
          .then(function(result) {
            $scope.accessCode    = result.accessCode;
            $scope.accessCodeUrl = trinketConfig.getUrl("/courses/join/" + result.accessCode);
            $scope.generatingCode = false;
          }, function(err) {
            $scope.generatingCode = false;
          });
      }

      $scope.toggleShowUser = function(user) {
        $scope.showUser[user.userId] = $scope.showUser[user.userId] === undefined ? true : !$scope.showUser[user.userId];
      }
      $scope.toggleShowInvitation = function(invitation) {
        invitation.acceptUrl = trinketConfig.getUrl("/courses/accept/" + invitation.token);
        $scope.showInvitation[invitation.id] = $scope.showInvitation[invitation.id] === undefined ? true : !$scope.showInvitation[invitation.id];
      }

      $scope.clickEditable = function(invitation) {
        $timeout(function() {
          angular.element("#invalid-" + invitation.id).trigger("click");
        });
      }

      $scope.close = function() {
        $modalInstance.close();
      }
    }]);
})(window.angular);
