(function(angular) {
  'use strict';

  angular.module('trinket.assignment', [
    'ngAria',
    'trinket.submissions',
    'trinket.util'
  ]).filter('escape', function() {
    return window.encodeURIComponent;
  }).directive('trinketAssignment', ['$window', '$compile', '$templateRequest', '$timeout', '$filter', '$sce', 'trinketSubmissions', 'trinketConfig', 'markdownParser', function($window, $compile, $templateRequest, $timeout, $filter, $sce, trinketSubmissions, trinketConfig, markdownParser) {
    function link(scope, element, attrs) {
      init_scope.call(scope);

      scope.stateDateFields = {
          "submitted"     : "submittedOn"
        , "completed"     : "submittedOn"
        , "submittedLate" : "submittedOn"
        , "feedback"      : "lastUpdated"
      };

      var url, latestSubmission, feedbackComments;
      var parser = markdownParser({
          $scope  : scope
        , preview : false
      });

      $templateRequest('/partials/directives/trinket-assignment.html').then(function(html) {
        element.html(html);
        $compile(element.contents())(scope);

        $window.addEventListener('message', function(ev) {
          if (ev.data === "TrinketApp ready") {
            scope.loadingAssignment = false;
            scope.assignmentVisible = true;

            if (!scope.preview && scope.allowResubmit !== false) {
              scope.canSubmit = true;
            }

            scope.$apply();
          }
          else if (ev.data === "trinket.code.autosave") {
            scope.setOriginal();
          }
          else if (ev.data.code) {
            scope.serialized = ev.data;
            if (!ev.data._initial) {
              scope.indicateChange();
            }
          }
        });
      });

      /**
       * when a user starts an assignment
       */
      scope.startAssignment = function() {
        scope.loadingAssignment = true;

        if (scope.userId) {
          trinketSubmissions.startAssignment(scope.material)
            .then(function(result) {
              scope.submission.id = result.assignment.id;
              url = "/assignment-embed/" + result.assignment.lang + "/" + result.assignment.shortCode;
              set_iframe.call(scope, url);
            }, function(err) {
              // TODO: show error
            });
        }
        else {
          url = "/assignment-embed-viewonly/" + scope.material.trinket.lang + "/" + scope.material.trinket.shortCode + "?noStorage=true";
          set_iframe.call(scope, url);
        }
      }

      /**
       * for preview mode
       */
      scope.showAssignment = function() {
        scope.loadingAssignment = true;

        // noStorage prevents local storage prompts/confusion
        url = "/assignment-embed-viewonly/" + scope.material.trinket.lang + "/" + scope.material.trinket.shortCode + "?noStorage=true";
        set_iframe.call(scope, url);
      }

      /**
       * when a user submits an assignment
       */
      scope.submitAssignment = function() {
        if (!scope.canSubmit || scope.submittingCode || !scope.submissionsAllowed) {
          return;
        }

        scope.submittingCode = true;
        latestSubmission     = null;

        angular.forEach(scope.submissions, function(submission, index) {
          if (submission.submissionState === "submitted" || submission.submissionState === "submittedLate") {
            latestSubmission = index;
          }
        });

        if (latestSubmission != null) {
          trinketSubmissions.updateSubmission(scope.submissions[latestSubmission], scope.serialized, scope.submission.comments)
            .then(function(result) {
              $timeout(function() {
                scope.submissions[latestSubmission] = result.submission;

                scope.codeSubmitted  = true;
                scope.isModified     = false;

              }, 500);
            }, function(err) {
              if (err.status === 403) {
                // TODO: transition error display
                scope.errorMessage = err.data.message;
              }
              else {
                // same as above?
              }
            })
            .finally(function() {
              scope.submittingCode = false;
            });
        }
        else {
          trinketSubmissions.submitAssignment(scope.material, scope.serialized, scope.submission.comments)
            .then(function(result) {
              $timeout(function() {
                scope.submissions.unshift(result.submission);

                scope.submittingCode = false;
                scope.codeSubmitted  = true;
                scope.isModified     = false;

              }, 500);
            }, function(err) {
              if (err.status === 403) {
                // TODO: transition error display
                scope.errorMessage = err.data.message;
              }
              else {
                // same as above?
              }
            })
            .finally(function() {
              scope.submittingCode = false;
            });
        }
      }

      /**
       * when a user views a previous submission
       */
      scope.toggleSubmission = function(submission) {
        if (scope.showSubmission[submission.id]) {
          scope.showSubmission[submission.id] = false;

          if (submission.feedback) {
            scope.showSubmission[submission.feedback.id] = false;
          }
        }
        else {
          scope.showSubmission[submission.id] = true;

          if (!scope.submissionSrc[submission.id]) {
            scope.submissionSrc[submission.id] = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + submission.lang + "/" + submission.shortCode));
          }

          if (submission.feedback) {
            scope.showSubmission[submission.feedback.id] = true;

            if (!scope.submissionSrc[submission.feedback.id]) {
              scope.submissionSrc[submission.feedback.id] = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + submission.feedback.lang + "/" + submission.feedback.shortCode));
            }
          }
        }
      }

      scope.toggleOriginal = function() {
        scope.showOriginal = scope.showOriginal ? false : true;
      }

      /**
       * on initial load and anytime page changes
       */
      attrs.$observe("assignmentTrinket", function(val) {
        if (!val) {
          return;
        }

        init_scope.call(scope);

        if (!scope.preview) {
          scope.loadingAssignment = true;

          if (!scope.userId) {
            scope.loadingAssignment = false;
            return;
          }

          trinketSubmissions.getSubmissionsForMaterial(scope.material)
            .then(function(submissions) {
              if (submissions.length) {
                var hasActiveAssignment = false;
                // check status of each submission
                angular.forEach(submissions, function(submission) {
                  switch (submission.submissionState) {
                    case "started":
                    case "modified":
                      scope.submission.id = submission.id;

                      if (submission.comments.length && submission.comments[0].commentText.length) {
                        scope.submission.comments = submission.comments[0].commentText;
                      }

                      url = "/assignment-embed/" + submission.lang + "/" + submission.shortCode;
                      set_iframe.call(scope, url);
                      scope.original = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + scope.material.trinket.lang + "/" + scope.material.trinket.shortCode));

                      if (submission.submissionState === "modified" && scope.submissionsAllowed) {
                        scope.isModified = true;
                      }

                      hasActiveAssignment = true;
                      break;
                    case "submitted":
                    case "submittedLate":
                      scope.submissions.push(submission);

                      scope.canUpdate = true;

                      break;
                    case "completed":
                      if (scope.allowResubmit === undefined) {
                        // can student submit again
                        scope.allowResubmit = submission.allowResubmit || false;
                      }

                      if (submission.comments.length) {
                        feedbackComments = $filter('filter')(submission.comments, { commentType : 'feedback' }, true);

                        if (feedbackComments.length) {
                          submission.feedback = {
                              id              : feedbackComments[0]._id
                            , lang            : feedbackComments[0].trinketLang
                            , shortCode       : feedbackComments[0].trinketShortCode
                            , comment         : feedbackComments[0]
                            , lastUpdated     : feedbackComments[0].commented
                            , submissionState : "feedback"
                            , includeRevision : submission.includeRevision || false
                          };
                        }
                      }

                      scope.submissions.push(submission);

                      scope.canSubmit = false;

                      break;
                    default:
                  }
                });

                if (!hasActiveAssignment) {
                  scope.loadingAssignment = false;
                }
              }
              else {
                // no "submissions" means user hasn't started yet
                scope.loadingAssignment = false;
              }
            });
        }
        else {
          if (scope.canEdit) {
            // link for original edit page
            scope.editLink = "/library/trinkets/" + scope.material.trinket.shortCode;
          }
        }
      });

      scope.setOriginal = function() {
        if (!scope.original) {
          scope.original = $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + scope.material.trinket.lang + "/" + scope.material.trinket.shortCode));
          scope.$apply();
        }
      }

      scope.indicateChange = function() {
        if (scope.submissionsAllowed) {
          scope.isModified = true;
          scope.codeSubmitted = false;

          scope.$apply();
        }
      }

      scope.autosaveComments = function() {
        // TODO! be sure to get the latest code if scope.serialized isn't set...

        trinketSubmissions.autosaveStudentComments(scope.submission);
        scope.indicateChange();
      }

      scope.commentSrc = function(comment) {
        return $sce.trustAsResourceUrl(trinketConfig.getUrl("/assignment-embed-viewonly/" + comment.trinketLang + "/" + comment.trinketShortCode));
      }

      scope.hasDueDate = function() {
        return scope.material.trinket.submissionsDue.enabled;
      }

      scope.beforeDue = function() {
        var now = moment();

        return now < moment(scope.material.trinket.submissionsDue.dateValue);
      }

      scope.pastCutoff = function() {
        var now = moment();

        if (scope.material.trinket.submissionsCutoff.enabled && now > moment(scope.material.trinket.submissionsCutoff.dateValue)) {
          scope.canSubmit = false;
          return true;
        }

        return false;
      }

      scope.betweenDueAndCutoff = function() {
        var now = moment();

        return now > moment(scope.material.trinket.submissionsDue.dateValue)
            && ( !scope.material.trinket.submissionsCutoff.enabled || now < moment(scope.material.trinket.submissionsCutoff.dateValue) );
      }

      scope.displayFeedback = function(commentText) {
        return $sce.trustAsHtml( parser( commentText ) );
      }

      scope.goto = function(path) {
        var page = $window.location.href
          , next = $filter('escape')(page)
          , url  = trinketConfig.getUrl("/" + path + "?next=" + next);

        $window.location.href = url;
      }
    }

    function init_scope() {
      this.canSubmit      = false;
      this.isModified     = false;
      this.submitted      = false;

      this.loadingAssignment = false;
      this.assignmentVisible = false;
      this.submittingCode    = false;
      this.codeSubmitted     = false;
      this.canUpdate         = false;

      this.allowResubmit  = undefined;

      this.showOriginal   = false;

      this.api            = null;
      this.serialized     = null;
      this.original       = null;

      this.submissions    = [];
      this.showSubmission = {};
      this.submissionSrc  = {};

      this.submission     = {
          id       : null
        , comments : ""
      };

      this.editLink       = null;
      this.errorMessage   = "";
    }

    function set_iframe(url) {
      url = trinketConfig.getUrl(url);

      // add a small diff to the URL to trigger a change and force reload
      if ($sce.valueOf(this.trinketIframe) === url) {
        url += "?diff=true";
      }

      this.trinketIframe = $sce.trustAsResourceUrl(url);
    }

    return {
        restrict : 'E'
      , link     : link
      , scope    : {
            material           : '='
          , canEdit            : '='
          , submissionsAllowed : '='
          , userId             : '='
          , preview            : '='
          , assignmentTrinket  : '@'
        }
    };
  }]);
})(window.angular);
