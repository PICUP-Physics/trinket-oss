(function(angular) {
  'use strict';

  function CourseControl($rootScope, $scope, $route, $sce, $timeout, $compile, $location, $filter, $window, $modal, $http, $q, Restangular, FileSaver, Blob, notifyjs, markdownParser, trinketConfig, trinketUtil, trinketRoles) {
    this.$rootScope  = $rootScope;
    this.$scope      = $scope;
    this.$sce        = $sce;
    this.$timeout    = $timeout;
    this.$compile    = $compile;
    this.$location   = $location;
    this.$filter     = $filter;
    this.$window     = $window;
    this.$http       = $http;
    this.$q          = $q;
    this.Restangular = Restangular;
    this.parser      = markdownParser({
      $scope:  $scope,
      preview: false
    });
    this.trinketConfig = trinketConfig;
    this.trinketUtil   = trinketUtil;
    this.trinketRoles  = trinketRoles;
    this.slides = [];
    this.defineListeners();
    this.defineScope();
    this.switchingMaterial = false;
    this.defaultCoursePageUrl;

    var lastRoute = $route.current;
    var self = this;
    $scope.$on('$locationChangeSuccess', function(event) {
      if (self.switchingMaterial) {
        $route.current = lastRoute;
        self.switchingMaterial = false;
      }
    });

    this.$scope.thisPage        = null;
    this.$scope.thisLesson      = null;
    this.$scope.thisLessonIndex = null;

    this.$scope.contentLoaded   = false;
    this.$scope.haveLessons     = false;
    this.$scope.haveContent     = false;
    this.$scope.editingOutline  = false;

    this.$rootScope.focusMe = false;

    this.$scope.isOwner          = trinketRoles.hasRole("course-owner", "course", { id : this.$scope.courseId });
    this.$scope.canDeleteCourse  = trinketRoles.hasPermission("delete-course", "course", { id : this.$scope.courseId });
    this.$scope.canUpdateCourse  = trinketRoles.hasPermission("update-course-details", "course", { id : this.$scope.courseId });
    this.$scope.canUpdateContent = this.$scope.canEdit || trinketRoles.hasPermission("manage-course-content", "course", { id : this.$scope.courseId });
    this.$scope.canManageAccess  = trinketRoles.hasPermission("manage-course-access", "course", { id : this.$scope.courseId });
    this.$scope.canCopyThisCourse = this.$scope.canCopyThisCourse || trinketRoles.hasPermission("make-course-copy", "course", { id : this.$scope.courseId });
    this.$scope.canArchiveThisCourse = this.$scope.isOwner;

    this.$scope.canManageAssignments = trinketRoles.hasPermission("manage-course-assignments", "course", { id : this.$scope.courseId });
    this.$scope.canEditTrinketAssignment = false;

    // can only create new assignments if user has site-wide course-assignments permission (i.e. trinket-connect subscription)
    this.$scope.canCreateAssignments
      =  trinketRoles.hasPermission("course-assignments")
      && this.$scope.canManageAssignments;

    this.$scope.canAssignAssocRole
      =  this.$scope.isAdmin
      && this.$scope.canManageAccess;

    this.$scope.canViewSubmissions = trinketRoles.hasPermission("view-assignment-submissions", "course", { id : this.$scope.courseId });

    this.$scope.trinketTypes = [];
    angular.forEach(trinketConfig.get('trinketTypes'), function(type) {
      if (trinketRoles.hasPermission("create-" + type.lang + "-trinket")) {
        self.$scope.trinketTypes.push(type);
      }
    });

    this.$scope.courseCopyName   = "";

    this.$scope.$modal = $modal;
    this.$scope.openUserModal = function() {
      var $modalInstance = $modal.open({
          templateUrl : "courseUserModal.html"
        , controller  : "UsersController"
        , resolve     : {
            course : function() {
              return self.$scope.course;
            },
            canAssignAssocRole : function() {
              return self.$scope.canAssignAssocRole;
            },
            canManageAccess : function() {
              return self.$scope.canManageAccess;
            },
            currentMaterial : function() {
              return self.$scope.currentMaterial;
            },
            assignmentDashboard : function() {
              return self.$scope.assignmentDashboard;
            }
          }
      });
    }

    this.$scope.openSettingsModal = function() {
      $('#courseEditModal').foundation('reveal', 'open');
    }
    this.$scope.openDownloadCourseModal = function() {
      $('#downloadCourseModal').foundation('reveal', 'open');
    }
    this.$scope.openArchiveCourseModal = function() {
      $('#archiveCourseModal').foundation('reveal', 'open');
    }

    // Same dialog the trash icon in the course-details modal opens; this lets
    // the course-actions menu reach it too, next to Archive.
    this.$scope.openDeleteCourseModal = function() {
      $('#deleteCourseDialog').foundation('reveal', 'open');
    }

    // for downloading a course
    this.$scope.generatingDownload = {
        html : false
      , md   : false
    };

    this.FileSaver = FileSaver;
    this.Blob      = Blob;
    this.notifyjs  = notifyjs;
  }

  angular.extend(CourseControl.prototype, {
    defineListeners : function() {
      this.$scope.$on('$destroy', angular.bind(this, this.destroy));
      var menu = $('#outline,#outline-expander');
      this.onWindowScroll = function() {
        var top = window.pageYOffset || document.body.scrollTop;
        if (top <= 45 && top >= 0) {
          menu.css('top', (125-top) + 'px');
        }
        else {
          menu.css('top', '');
        }
      };
      $(window).on('scroll', this.onWindowScroll);
    },

    defineScope : function() {
      var self = this;

      self.Restangular
        .one('courses', self.$scope.courseId)
        .get({outline:true,withDraft:true,with:['_owner']})
        .then(function(course) {
          self.$scope.course = course;
          self.$scope.courseForm = {
            name        : course.name,
            description : course.description,
            contentDefault : course.globalSettings.contentDefault
          };
          self.$scope.coursePageUrl = self.defaultCoursePageUrl = self.trinketConfig.getClassUrl(self.$scope.userSlug, self.$scope.courseSlug)

          if (course.lessons.length) {
            self.$scope.haveLessons = true;
          }

          course.lessons = self.Restangular.restangularizeCollection(course,course.lessons,'lessons');

          self.$scope.privateOption;
          if (self.trinketRoles.hasPermission("create-private-course")
          || (course.globalSettings.courseType === "private" && self.$scope.canUpdateCourse)) {
            self.$scope.privateOption = true;
            self.$scope.courseForm.courseType = course.globalSettings.courseType;
          }

          self.$scope.canCopyThisCourse;
          if (self.$scope.isOwner || course.globalSettings.courseType === "public" || self.trinketRoles.hasPermission("create-private-course")) {
            self.$scope.canCopyThisCourse = true;
          }

          var startingPath = self.$location.path().substring(1);
          var materialPath = startingPath.split('/');
          var checkPath    = materialPath.length == 2 ? true : false;
          var startingMaterial;

          angular.forEach(course.lessons, function(lesson) {
            lesson.materials = self.Restangular.restangularizeCollection(lesson,lesson.materials,'materials');
            if (checkPath) {
              angular.forEach(lesson.materials, function(material) {
                if (lesson.slug === materialPath[0] && material.slug === materialPath[1]) {
                  startingMaterial = material;
                  checkPath = false;
                }
              });
            }
          });

          self.$scope.contentLoaded = true;
          self.compileSlides(startingMaterial, true);

          if (!self.$scope.haveContent) {
            self.$scope.editingOutline = true;
            $(document).foundation('dropdown', 'reflow');
          }

          course.addRestangularMethod('copy', 'post', 'copy');
        });

      self.$scope.outlineDragOptions = {
        accept  : angular.bind(self, self.canAcceptDrop),
        dropped : angular.bind(self, self.onItemDropped)
      };
      self.$scope.editOutlineDragOptions = {
        accept  : angular.bind(self, self.canAcceptDrop),
        dropped : angular.bind(self, self.onItemDropped)
      }

      self.$scope.menuOpen           = self.trinketUtil.isLarge() ? true : false;
      self.$scope.currentSlideIndex  = 0;
      self.$scope.addLesson          = angular.bind(self, self.addLesson);
      self.$scope.addMaterial        = angular.bind(self, self.addMaterial);
      self.$scope.editLesson         = angular.bind(self, self.editLesson);
      self.$scope.editMaterial       = angular.bind(self, self.editMaterial);
      self.$scope.viewMaterial       = angular.bind(self, self.viewMaterial);

      self.$scope.assignmentDashboard    = angular.bind(self, self.assignmentDashboard);

      self.$scope.compareLessonNames     = angular.bind(self, self.compareLessonNames);
      self.$scope.removeLesson           = angular.bind(self, self.removeLesson);
      self.$scope.openRemoveLessonDialog = angular.bind(self, self.openRemoveLessonDialog);
      self.$scope.cancelLessonRemove     = angular.bind(self, self.cancelLessonRemove);

      self.$scope.comparePageNames     = angular.bind(self, self.comparePageNames);
      self.$scope.removeMaterial       = angular.bind(self, self.removeMaterial);
      self.$scope.openRemovePageDialog = angular.bind(self, self.openRemovePageDialog);
      self.$scope.cancelPageRemove     = angular.bind(self, self.cancelPageRemove);

      self.$scope.compareCourseNames = angular.bind(self, self.compareCourseNames);
      self.$scope.deleteCourse       = angular.bind(self, self.deleteCourse);
      self.$scope.cancelCourseDelete = angular.bind(self, self.cancelCourseDelete);
      self.$scope.archiveCourse      = angular.bind(self, self.archiveCourse);
      self.$scope.cancelCourseArchive = angular.bind(self, self.cancelCourseArchive);
      self.$scope.restoreCourse      = angular.bind(self, self.restoreCourse);

      self.$scope.nextMaterial       = angular.bind(self, self.nextMaterial);
      self.$scope.previousMaterial   = angular.bind(self, self.previousMaterial);
      self.$scope.editContent        = angular.bind(self, self.editContent);
      self.$scope.toggleDraft        = angular.bind(self, self.toggleDraft);

      self.$scope.copyCourse         = angular.bind(self, self.copyCourse);
      self.$scope.downloadMarkdown   = angular.bind(self, self.downloadMarkdown);
      self.$scope.downloadHTML       = angular.bind(self, self.downloadHTML);

      self.$scope.savingCourse = false;

      self.$scope.updateCourse            = angular.bind(self, self.updateCourse);
      self.$scope.openNewTopicDialog      = angular.bind(self, self.openNewTopicDialog);
      self.$scope.openNewPageDialog       = angular.bind(self, self.openNewPageDialog);
      self.$scope.openNewAssignmentDialog = angular.bind(self, self.openNewAssignmentDialog);
      self.$scope.addAssignment           = angular.bind(self, self.addAssignment);
      self.$scope.addSelectedTrinket      = angular.bind(self, self.addSelectedTrinket);
      self.$scope.addBlankTrinket         = angular.bind(self, self.addBlankTrinket);
      self.$scope.closeAssignmentDialog   = angular.bind(self, self.closeAssignmentDialog);

      self.$scope.editOutline = angular.bind(self, self.editOutline);
      self.$scope.doneOutline = angular.bind(self, self.doneOutline);

      self.$scope.viewDashboard  = angular.bind(self, self.viewDashboard);
      self.$scope.viewAssignment = angular.bind(self, self.viewAssignment);
      self.$scope.usingDates     = angular.bind(self, self.usingDates);
    },

    destroy : function() {
      $(window).off('scroll', this.onWindowScroll);
    },

    updateCourse : function($event) {
      $event.preventDefault();

      var self = this
        , location, message;

      self.$scope.savingCourse = true;

      return self.$scope.course.customPUT(self.$scope.courseForm, 'metadata')
        .then(function(result) {
          self.$timeout(function() {
            self.$scope.savingCourse = false;

            if (result && result.course) {
              if (result.course.slug != self.$scope.course.slug) {
                location = self.$window.location.pathname.split('/');
                location.pop();
                location.push(result.course.slug);
                self.$window.location = location.join('/');
              }
              else {
                angular.forEach(self.$scope.courseForm, function(value, key) {
                  self.$scope.course[key] = result.course[key];
                });

                $('#course-settings-messages').notify(
                  "Course info updated."
                  , { className : 'success' }
                );
              }
            }
            else if (result.err) {
              message = result.message || "We had a problem saving your course. Please try again.";
              $('#course-settings-messages').notify(
                message, { className : 'alert' }
              );
            }
          }, 500);
        });
    },

    copyCourse : function() {
      var self = this
        , name = self.$scope.courseCopyName || "Copy of " + self.$scope.course.name;

      return self.$scope.course.copy({ name : name })
        .then(function(result) {
          if (result.success) {
            self.$window.location = result.url;
          }
          else {
            self.$scope.courseCopyName = name;
            $('#copyCourseNameDialog').foundation('reveal', 'open');
          }
        });
    },

    downloadMarkdown : function() {
      this.downloadCourse("md");
    },
    downloadHTML : function() {
      this.downloadCourse("html");
    },

    downloadCourse : function(type) {
      var path = [this.$scope.userSlug, "courses", this.$scope.courseSlug, "download.zip"].join("/")
        , url  = this.trinketConfig.getUrl(path)
        , self = this
        , blobData, zipFile;

      self.$scope.generatingDownload[type] = true;

      var getParams = {
          responseType : "arraybuffer"
        , cache        : false
        , headers      : {
            "Content-Type" : "application/zip; charset=utf-8"
          }
      };

      url += "?format=" + type;

      return this.$http.get(url, getParams)
        .then(function(result) {
          self.$scope.generatingDownload[type] = false;

          blobData = new self.Blob([result.data], { type : "application/octet-stream" });
          zipFile  = "Trinket Course-" + self.$scope.courseSlug + "-" + type + ".zip";
          self.FileSaver.saveAs(blobData, zipFile);
        });
    },

    nextMaterial : function() {
      if (this.currentSlideIndex === this.slides.length-1) return;
      this.switchingMaterial = true;
      this.viewMaterial(this.currentSlideIndex + 1);
    },

    previousMaterial :function() {
      if (this.currentSlideIndex === 0) return;
      this.switchingMaterial = true;
      this.viewMaterial(this.currentSlideIndex - 1);
    },

    compileSlides : function(materialToSelect, orSelectFirst) {
      var self          = this,
          current       = self.slides[self.currentSlideIndex],
          slides        = [],
          index         = 0,
          lessonIndex   = 0,
          indexInLesson = 0,
          newSlideIndex = orSelectFirst ? 0 : undefined;

      angular.forEach(self.$scope.course.lessons, function(lesson) {
        lesson.firstSlideIndex = index;
        indexInLesson = 0;

        angular.forEach(lesson.materials, function(material) {
          if (materialToSelect) {
            if (material.id === materialToSelect.id) {
              newSlideIndex = index;
            }
          }
          else if (current && material.id === current.id) {
            newSlideIndex = index;
          }

          material.slideIndex  = index;

          // index of lesson
          material.lessonIndex = lessonIndex;

          // index within this lesson
          material.indexInLesson = indexInLesson++;

          slides.push({
            lesson   : lesson,
            material : material
          });

          index++;
        });

        lesson.lastSlideIndex = index - 1;
        lessonIndex++;
      });

      self.slides = slides;

      if (materialToSelect || newSlideIndex !== undefined) {
        self.viewMaterial(newSlideIndex);
      }
    },

    openNewTopicDialog : function() {
      var self = this;

      $('#newTopicDialog').foundation('reveal', 'open');
      self.$rootScope.focusMe = true;
    },

    addLesson : function($event, course) {
      $event.preventDefault();

      var self = this;

      if (course.newLessonName && course.newLessonName.length) {
        return self.addItem('lessons', 'newLessonName', course)
          .then(function(lesson) {
            lesson.materials = self.Restangular.restangularizeCollection(lesson,lesson.materials,'materials');
            self.$scope.haveLessons = true;
          });
      }
    },

    openNewPageDialog : function(lesson) {
      var self = this;

      self.$scope.thisLesson = lesson;
      self.$scope.thisLesson.newItemType = 'page';

      $('#newPageDialog').foundation('reveal', 'open');
      self.$rootScope.focusMe = true;
    },

    openNewAssignmentDialog : function(lesson) {
      var self       = this
        , $modalInstance, editor, session
        , url, currentPath, newPath;

      // open assignment editor modal
      $modalInstance = self.$scope.$modal.open({
          templateUrl : "/partials/assignment_editor.html"
        , controller  : "AssignmentEditorController"
        , resolve     : {
            lesson   : function() {
              return lesson;
            },
            material : function() {
              return undefined;
            },
            trinketTypes : function() {
              return self.$scope.trinketTypes;
            }
          }
      });

      // once opened, set up ace editor for instructions
      $modalInstance.opened.then(function() {
        self.$timeout(function() {
          editor = self.$window.ace.edit('trinket-instructions-editor');

          editor.$blockScrolling = Infinity;
          editor.setTheme('ace/theme/github');

          session = editor.getSession();
          session.setMode('ace/mode/markdown');
          session.setUseWrapMode(true);
        });
      });

      $modalInstance.result.then(function(result) {
        if (result) {
          lesson.materials.push(result);
          self.switchingMaterial = true;
          self.compileSlides(result);
          lesson.newPageTitle = '';
        }

        if (editor) {
          editor.destroy();
          angular.element( document.querySelector('#trinket-instructions-editor') ).empty();
        }
      }, function() {
        if (editor) {
          editor.destroy();
          angular.element( document.querySelector('#trinket-instructions-editor') ).empty();
        }
      });
    },

    addMaterial : function($event, lesson, type) {
      $event.preventDefault();

      var self = this;

      if (lesson.newPageTitle && lesson.newPageTitle.length) {
        lesson.newItemType = 'page';
        return self.addItem('materials', 'newPageTitle', lesson)
          .then(function(material) {
            self.compileSlides();
            self.$scope.haveContent = true;
          });
      }
    },

    addItem : function(listName, itemName, scope) {
      var postData = {
        name : scope[itemName]
      };

      if (scope.newItemType) {
        postData.type = scope.newItemType;
      }

      return scope[listName]
        .post(postData)
        .then(function(result) {
          scope[itemName] = '';
          scope[listName].push(result);
          return result;
        });
    },

    editLesson : function(lesson, name) {
      return lesson.customPUT({name:name}, 'name').then(function(result) {
        _.extend(lesson, result.lesson);
        return true;
      });
    },

    editMaterial : function(material, name) {
      return material.customPUT({name:name}, 'name').then(function(result) {
        _.extend(material, result.material);
        return true;
      });
    },

    updateSlideStates : function() {
      var index = this.currentSlideIndex;

      angular.forEach(this.$scope.course.lessons, function(lesson) {
        angular.forEach(lesson.materials, function(material) {
          material.isPast    = material.slideIndex < index;
          material.isFuture  = material.slideIndex > index;
          material.isCurrent = !(material.isPast || material.isFuture);
        });
        lesson.isPast    = lesson.lastSlideIndex < index;
        lesson.isFuture  = lesson.firstSlideIndex > index;
        lesson.isCurrent = !(lesson.isPast || lesson.isFuture);
      });
    },

    viewMaterial : function(index, clickedOutline) {
      var self = this;

      if (!self.slides || !self.slides[index]) {
        self.$scope.currentMaterial = null;
        return;
      }

      self.$scope.haveContent = true;

      var elem = $(self.$window);
      var top  = Math.min(elem.scrollTop(), 45);

      var material = self.slides[index].material;
      var lesson = self.slides[index].lesson;

      function setScroll() {
        var $outlineId = $('#' + lesson.slug + '-' + material.slug),
            $outline   = $('#outline'),
            scrollTop;

        if (!self.trinketUtil.isElementVisible($outlineId, $outline)) {
          if ($outlineId.offset().top > $outline.offset().top) {
            scrollTop = $outline.scrollTop() + $outlineId.offset().top + $outlineId.height() - $outline.height();
          }
          else {
            scrollTop = $outline.scrollTop() + $outlineId.position().top - 20;
          }

          $outline.animate({
            scrollTop: scrollTop
          }, 500);
        }

        self.$timeout(function() {
          elem.scrollTop(top);
        })
      }

      var updateLocation = function() {
        if (!self.$location.path() || self.$location.path() === '/') {
          self.$location.replace();
          self.switchingMaterial = true;
        }
        if (clickedOutline) {
          self.switchingMaterial = true;
          self.$scope.editingOutline = false;
        }
        var currentPath = '/' + lesson.slug + '/' + material.slug;
        self.$scope.coursePageUrl = self.defaultCoursePageUrl + '#' + currentPath;
        self.$location.path(currentPath);
      }

      self.currentSlideIndex = index;
      self.$scope.progress = (index+1)/self.slides.length;
      self.updateSlideStates();

      var setCurrentMaterial = function() {
        self.$scope.canEditTrinketAssignment = material.trinket && material.trinket.owner;
        self.$scope.currentMaterial = material;
        self.$timeout(function() {
          MathJax.Hub.Queue(["Typeset",MathJax.Hub,"material"]);
        });
      }

      if (material.type === "assignment") {
        self.assignmentDashboard(material);
      }

      if (material.markup) {
        setCurrentMaterial();
        setScroll();
        return updateLocation();
      }
      else {
        material.get({ with : "owner" }).then(function(result) {
          if (result.content) {
            material.content = result.content;
            material.markup  = self.$sce.trustAsHtml('<div class="content">' + self.parser(result.content) + '</div>');
          }
          else {
            result.markup = '';
          }

          if (result.trinket) {
            material.trinket.owner = result.trinket.owner;
          }

          setCurrentMaterial();
          setScroll();
          return updateLocation();
        });
      }
    },

    assignmentDashboard : function(material) {
      var self = this;

      material.assignment = null;
      if (self.$scope.canViewSubmissions) {
        material.customGET("dashboard").then(function(result) {
          material.assignment = result;
        });
      }
    },

    openRemovePageDialog : function(material) {
      this.$scope.thisPage = material;
      this.$scope.pageNamesMatchForDelete = false;
      this.$scope.confirmPageName = '';

      if (material.type === "assignment") {
        this.$scope._removePageLabel = "Assignment";
      }
      else {
        this.$scope._removePageLabel = "Page";
      }

      $('#removePageDialog').foundation('reveal', 'open');
    },

    comparePageNames : function() {
      this.$scope.pageNamesMatchForDelete = this.$scope.thisPage && this.$scope.thisPage.name === this.$scope.confirmPageName;
    },

    removeMaterial : function($event, material) {
      $event.preventDefault();

      if (!this.$scope.pageNamesMatchForDelete) {
        return;
      }

      var self          = this
        , lessonIndex   = material.lessonIndex
        , indexInLesson = material.indexInLesson;

      return material.remove().then(function(result) {
        // if deleting from outline, there may be no currentMaterial
        if (self.$scope.currentMaterial && self.$scope.currentMaterial.id === material.id) {
          self.$scope.currentMaterial = null;
        }

        self.$scope.course.lessons[ lessonIndex ].materials.splice( indexInLesson, 1 );

        self.switchingMaterial = true;
        if (self.$scope.editingOutline) {
          self.compileSlides();
        }
        else {
          self.compileSlides(null, true);
        }

        self.$scope.thisPage = null;
        $('#removePageDialog').foundation('reveal', 'close');

        if (!self.slides.length) {
          self.$scope.haveContent = false;
          self.$scope.editingOutline = true;
          $(document).foundation('dropdown', 'reflow');
        }
      });
    },

    cancelPageRemove : function() {
      this.$scope.thisPage = null;
      $('#removePageDialog').foundation('reveal', 'close');
    },

    openRemoveLessonDialog : function(lesson, index) {
      this.$scope.thisLesson = lesson;
      this.$scope.thisLessonIndex = index;
      this.$scope.lessonNamesMatchForDelete = false;
      this.$scope.confirmLessonName = '';

      $('#removeLessonDialog').foundation('reveal', 'open');
    },

    compareLessonNames : function() {
      this.$scope.lessonNamesMatchForDelete = this.$scope.thisLesson && this.$scope.thisLesson.name === this.$scope.confirmLessonName;
    },

    removeLesson : function($event, lesson) {
      $event.preventDefault();

      if (!this.$scope.lessonNamesMatchForDelete || this.$scope.thisLessonIndex == null) {
        return;
      }

      var self = this;

      return lesson.remove().then(function(result) {
        self.$scope.course.lessons.splice( self.$scope.thisLessonIndex, 1 );
        if (self.$scope.editingOutline) {
          self.compileSlides();
        }
        else {
          self.compileSlides(null, true);
        }

        $('#removeLessonDialog').foundation('reveal', 'close');

        self.$scope.thisLesson = null;
        self.$scope.thisLessonIndex = null;

        if (!self.$scope.course.lessons.length) {
          self.$scope.haveLessons = false;
          self.$scope.haveContent = false;
          self.$scope.editingOutline = true;
          $(document).foundation('dropdown', 'reflow');
        }
      });
    },

    cancelLessonRemove : function() {
      this.$scope.thisLesson = null;
      this.$scope.thisLessonIndex = null;
      $('#removeLessonDialog').foundation('reveal', 'close');
    },

    compareCourseNames : function() {
      this.$scope.courseNamesMatchForDelete = this.$scope.course && this.$scope.course.name === this.$scope.confirmCourseName;
    },

    deleteCourse : function($event) {
      $event.preventDefault();

      var self = this;

      self.$scope.course.remove().then(function() {
        self.$window.location = '/home';
      }, function(response) {
        // A failed delete used to show NOTHING — the dialog just sat there and
        // the course quietly survived (issue #2's 500s).
        $('#deleteCourseDialog').foundation('reveal', 'close');
        var message = response && response.data && response.data.message;
        $('#course-notifications').notify(
          'We couldn\'t delete the course' + (message ? ': ' + message : '. Please try again.')
          , { className : 'alert' }
        );
      });
    },

    cancelCourseDelete : function() {
      this.$scope.confirmCourseName = '';
      $('#deleteCourseDialog').foundation('reveal', 'close');
    },

    archiveCourse : function() {
      var self = this;

      self.$scope.savingCourse = true;

      var archived = !!self.$scope.course.archived;
      return self.$scope.course.patch({ archived: !archived })
        .then(function(result) {
          self.$timeout(function() {
            self.$scope.savingCourse = false;
            if (result && result.course) {
              $('#archiveCourseModal').foundation('reveal', 'close');
              self.$scope.course.archived = result.course.archived;

              var message = result.course.archived ? 'archived' : 'restored';
              $('#course-notifications').notify(
                "Course was successfully " + message
                , { className : 'success' }
              );
            }
          });
        });
    },

    cancelCourseArchive : function() {
      $('#archiveCourseModal').foundation('reveal', 'close');
    },

    editContent : function(lesson, material) {
      var self       = this
        , updatePath = false
        , thisMaterial, materialPromise, $modalInstance, editor, session
        , url, currentPath, newPath;

      // lesson and material are passed in from course outline
      // otherwise editing from a page or assignment

      thisMaterial = lesson && material ? material : self.$scope.currentMaterial;

      if (thisMaterial.type === 'assignment') {
        if (!self.$scope.canManageAssignments) {
          return;
        }

        // content (instructions) hasn't been loaded yet
        if (!thisMaterial.markup) {
          materialPromise = thisMaterial.get({ with : "owner" });
        }
        else {
          materialPromise = self.$q.when();
        }

        materialPromise.then(function(result) {
          if (result && result.content) {
            thisMaterial.content = result.content;
            thisMaterial.markup  = self.$sce.trustAsHtml('<div class="content">' + self.parser(result.content) + '</div>');
          }

          // open assignment editor modal
          $modalInstance = self.$scope.$modal.open({
              templateUrl : "/partials/assignment_editor.html"
            , controller  : "AssignmentEditorController"
            , resolve     : {
                lesson   : function() {
                  return lesson;
                },
                material : function() {
                  return thisMaterial;
                },
                trinketTypes : function() {
                  return self.$scope.trinketTypes;
                }
              }
          });

          // once opened, set up ace editor for instructions
          $modalInstance.opened.then(function() {
            self.$timeout(function() {
              editor = self.$window.ace.edit('trinket-instructions-editor');

              editor.$blockScrolling = Infinity;
              editor.setTheme('ace/theme/github');

              session = editor.getSession();
              session.setMode('ace/mode/markdown');
              session.setUseWrapMode(true);

              if (thisMaterial.content) {
                session.setValue(thisMaterial.content);
              }
            });
          });

          $modalInstance.result.then(function(result) {
            if (result && result.material) {
              if (result.material.slug !== thisMaterial.slug) {
                self.$location.replace();
                currentPath = self.$location.path().split('/');
                newPath     = currentPath[1] + '/' + result.material.slug
                self.$scope.coursePageUrl = self.defaultCoursePageUrl + '#' + newPath;
                updatePath = true;
              }

              if (result.material.content !== thisMaterial.content) {
                thisMaterial.markup  = self.$sce.trustAsHtml('<div class="content">' + self.parser(result.material.content) + '</div>');
                self.$timeout(function() {
                  MathJax.Hub.Queue(["Typeset",MathJax.Hub,"material"]);
                });
              }

              _.extend(thisMaterial, result.material);
            }

            if (editor) {
              editor.destroy();
              angular.element( document.querySelector('#trinket-instructions-editor') ).empty();
            }

            if (updatePath) {
              self.$location.path(newPath);
            }
          }, function() {
            if (editor) {
              editor.destroy();
              angular.element( document.querySelector('#trinket-instructions-editor') ).empty();
            }
          });
        });
      }
      else {
        if (lesson && material) {
          url = [
            lesson.slug,
            material.slug,
            'edit'
          ].join('/');
        }
        else {
          url = [
            this.slides[this.currentSlideIndex].lesson.slug,
            this.$scope.currentMaterial.slug,
            'edit'
          ].join('/');
        }

        this.$location.path('/' + url);
      }
    },

    toggleDraft : function(item) {
      var self      = this
        , itemType  = item.route // lessons or materials
        , resultKey = {
              "lessons"   : "lesson"
            , "materials" : "material"
          }
        , message;

      item.customPUT({ isDraft : !item.isDraft }, 'draft')
        .then(function(result) {
          if (result && result[ resultKey[itemType] ]) {
            angular.extend(item, result[ resultKey[itemType] ]);

            if (itemType === "lessons") {
              message = "Topic";
            }
            else {
              message = item.type === "assignment" ? "Assignment" : "Page";
            }

            if (item.isDraft) {
              message += " marked as draft.";
            }
            else {
              // if material, check if topic is published...
              if (itemType === "materials" && self.$scope.course.lessons[ item.lessonIndex ].isDraft) {
                message += " will become visible once topic '" + self.$scope.course.lessons[ item.lessonIndex ].name + "' is published.";
              }
              else {
                message += " published.";
              }
            }

            self.notifyjs(angular.element( document.querySelector('#course-notifications') ), message, "success");
          }
        });
    },

    canAcceptDrop : function(sourceNode, destNodes, destIndex) {
      var accept = false
        , sourceType, destType;

      if (this.$scope.canUpdateContent) {
        sourceType = sourceNode.$element.attr('data-type');
        destType   = destNodes.$element.attr('data-type');
        accept     = (sourceType == destType);
      }

      return accept;
    },

    onItemDropped : function(event) {
      var sourceNode = event.source.nodeScope;
      var destNodes  = event.dest.nodesScope;
      var update     = { index : event.dest.index };
      
      if (!destNodes.isParent(sourceNode)) {
        update.parent = destNodes.$nodeScope.$modelValue.id;
      }
      else if (event.source.index === event.dest.index) {
        // did not change parent or index so we can abort
        return;
      }

      this.compileSlides();

      return sourceNode.$modelValue.customPUT(update, 'move')
        .then(function(result) {
          if (update.parent) {
            sourceNode.$modelValue.parentResource.id = update.parent;
          }
        });
    },

    editOutline : function() {
      this.$scope.editingOutline = true;
      $(document).foundation('dropdown', 'reflow');
    },

    doneOutline : function() {
      this.$scope.editingOutline = false;
      this.compileSlides(this.$scope.currentMaterial, true);
    },

    viewDashboard : function() {
      this.$location.path('/_dashboard');
    },

    viewAssignment : function(material) {
      var lesson = this.$scope.course.lessons[ material.lessonIndex ];
      this.$location.path('/_dashboard/' + lesson.slug + '/' + material.slug);
    },

    usingDates : function(material) {
      // availableOn, hideAfter, submissionsDue, submissionsCutoff
      return material && material.trinket &&
        ( (material.trinket.availableOn    && material.trinket.availableOn.enabled) ||
          (material.trinket.hideAfter      && material.trinket.hideAfter.enabled)   ||
          (material.trinket.submissionsDue && material.trinket.submissionsDue.enabled) );
    }
  });

  return angular
    .module('courseEditor')
    .controller('rootControl', ['$rootScope', '$scope', '$route', '$sce', '$timeout', '$compile', '$location', '$filter', '$window', '$modal', '$http', '$q', 'Restangular', 'FileSaver', 'Blob', 'notifyjs', 'markdownParser', 'trinketConfig', 'trinketUtil', 'trinketRoles', CourseControl]);
})(angular);
