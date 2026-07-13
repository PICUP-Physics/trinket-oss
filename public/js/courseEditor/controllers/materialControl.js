(function(angular) {
  'use strict';

  if (!angular) {
    throw new Error('angular required for CourseEditor.materialControl');
  }

  function MaterialControl($scope, $q, $route, $routeParams, $sce, $compile, Upload, $window, $location, $timeout, $interval, $filter, markdownParser, Restangular, trinketConfig) {
    this.$scope             = $scope;
    this.$q                 = $q;
    this.$route             = $route;
    this.$routeParams       = $routeParams;
    this.$sce               = $sce;
    this.$compile           = $compile;
    this.Upload             = Upload;
    this.$window            = $window;
    this.$location          = $location;
    this.$timeout           = $timeout;
    this.$interval          = $interval;
    this.$filter            = $filter;
    this.savedMarkdown      = '';
    this.renderDelay        = 0;
    this.renderTimeout      = null;
    this.lastSavedInterval  = null;
    this.stopRenderAndSave  = false;
    this.materialSlugChange = false;
    this.Restangular        = Restangular;
    this.parser             = markdownParser({$scope:$scope, preview:true});
    this.beforeWindowUnload = angular.bind(this, this.beforeWindowUnload);
    this.sizeToWindow       = angular.bind(this, this.sizeToWindow);
    this.trinketConfig      = trinketConfig;

    this.defineListeners();
    this.defineScope();

    var lastRoute = $route.current;
    var self = this;
    $scope.$on('$locationChangeSuccess', function(event) {
      if (self.materialSlugChange) {
        $route.current = lastRoute;
        self.materialSlugChange = false;
      }
    });
  }

  MaterialControl.prototype.defineListeners = function() {
    var self = this;

    self.$scope.$on('$destroy', angular.bind(self, self.destroy));
    self.$scope.$on('$locationChangeStart', angular.bind(self, self.onLocationChange));

    angular.element(self.$window).bind('beforeunload', self.beforeWindowUnload);
    angular.element(self.$window).bind('resize', self.sizeToWindow);

    self.lastSavedInterval = self.$interval(function() {
      if (self.$scope.material && self.$scope.material.lastUpdated) {
        angular.element( document.querySelector('#material-last-saved') ).text( self.$filter('formatDate')(self.$scope.material.lastUpdated) );
      }
    }, 30000);
  }

  MaterialControl.prototype.defineScope = function() {
    var self   = this,
        editor  = self.$window.ace.edit('markdown'),
        session = editor.getSession();

    editor.$blockScrolling = Infinity;
    editor.setTheme('ace/theme/github');
    session.setMode('ace/mode/markdown');
    session.setUseWrapMode(true);
    if (!self.$scope.canEdit) {
      editor.setReadOnly(true);
    }

    self.editor  = editor;
    self.session = session;

    self.$scope.markdown         = '';
    self.$scope.markup           = '';
    self.$scope.uploadProgress   = 0;
    self.$scope.assetsEnabled    = self.trinketConfig.get('assetsEnabled');
    self.$scope.classPageUrl     = self.trinketConfig.getClassUrl(self.$scope.userSlug, self.$scope.courseSlug);
    self.$scope.preview          = angular.bind(self, self.getPreview);
    self.$scope.updateMaterial   = angular.bind(self, self.updateMaterial);
    self.$scope.onFileSelect     = angular.bind(self, self.onFileSelect);
    self.$scope.openUploadDialog = angular.bind(self, self.openUploadDialog);
    self.$scope.backToCourse     = angular.bind(self, self.backToCourse);
    self.$scope.toggleDraft      = angular.bind(self, self.toggleDraft);

    self.Restangular
        .one('courses', self.$scope.courseId)
        .get({outline:true,withDraft:true,with:['_owner']})
        .then(function(course) {
          self.$scope.course = course;
          angular.forEach(course.lessons, function(lesson) {
            if (lesson.slug === self.$routeParams.lessonSlug) {
              self.$scope.lesson = lesson;
              angular.forEach(lesson.materials, function(material) {
                if (material.slug === self.$routeParams.materialSlug) {
                  self.Restangular.all('courses/'+course.id+'/lessons/'+lesson.id).one('materials', material.id)
                    .get()
                    .then(function(material) {
                      self.$scope.material = material;
                      self.$scope.markdown = self.savedMarkdown = material.content || '';
                      session.setValue(self.savedMarkdown);
                      self.renderPreview();
                      session.on('change', function() {
                        self.$scope.markdown = session.getValue();
                        self.markDirty();
                      });
                    })
                    .then(function() {
                      self.$timeout(self.sizeToWindow, self.renderDelay);
                    });
                }
              });
            }
          });
        });

    // reset scroll to top of page
    self.$window.scrollTo(0, 0);
    editor.focus();
  }

  MaterialControl.prototype.destroy = function() {
    angular.element(this.$window).unbind('beforeunload', this.beforeWindowUnload);
    angular.element(this.$window).unbind('resize', this.sizeToWindow);
    //remove all listeners, all timeouts and intervals
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
    }
    if (this.lastSavedInterval) {
      this.$interval.cancel(this.lastSavedInterval);
    }
  }

  MaterialControl.prototype.backToCourse = function() {
    var path = this.$location.path();
    var newPath = path.substring(0, path.lastIndexOf('/edit'));
    this.$location.path(newPath);
  }

  MaterialControl.prototype.onLocationChange = function(event, newUrl, oldUrl) {
    var self = this;
    // trigger a final save before we leave this page
    if (self.savedMarkdown !== self.$scope.markdown) {
      self.autoSave();
    }
  }

  // Open the upload dialog programmatically. The trigger used Foundation's
  // data-reveal-id auto-wiring, which only binds at page bootstrap; this Angular
  // partial is injected after bootstrap, so on a hard-refresh / deep-link the
  // trigger was never wired and clicking did nothing. Opening the reveal here
  // (mirroring the existing 'close' call) works regardless of load path (#24).
  MaterialControl.prototype.openUploadDialog = function(ev) {
    if (ev && ev.preventDefault) { ev.preventDefault(); }
    $('#fileUploadModal').foundation('reveal', 'open');
  };

  MaterialControl.prototype.onFileSelect = function(files, fromModal) {
    var self = this;
    self.$scope.uploadStarted = true;
    self.$scope.uploadProgress = 0;
    self.$scope.uploadError = null;
    for (var i = 0; i < files.length; i++) {
      self.Upload.upload({
        url:    '/file',
        method: 'POST',
        // ng-file-upload 12.x: name the multipart field via the data key. The
        // old `file:` + `fileFormDataName:` shorthand is ignored in v12 and the
        // field defaults to "file", which the server (expects "upload") rejects.
        data:   { upload: files[i] }
      }).then(function(response) {
        var data = response.data;
        self.$scope.uploadStarted = false;
        if (fromModal) {
          $('#fileUploadModal').foundation('reveal', 'close');
        }
        self.$timeout(function(){
          var url   = '';
          var embed = data.type === 'embed' ? '!' : '';

          // use viewerjs for certain file extensions
          if (/\.(pdf|odp|odt|ods|fodt)$/.test(data.path)) {
            embed = '!';
            url   = '/components/viewerjs/index.html#../..';
          }

          // ensure that a preceding slash is present in the file path
          if (!data.path.match(/^\//)) {
            url += '/';
          }

          url += data.path;

          self.editor.insert(embed + '[' + data.name + '](' + url + ' "' + data.name + '")');
          self.editor.focus();
        });
      }, function(response) {
        // A rejected upload used to show NOTHING (the error callback was null)
        // — the file just silently never appeared (issue #4's 415s).
        self.$scope.uploadStarted = false;
        self.$scope.uploadProgress = 0;
        var message = response && response.data && response.data.message;
        if (!message && response && response.status === 413) {
          message = 'That file is too large — the maximum size is 10MB.';
        }
        self.$scope.uploadError = 'Upload failed: ' + (message || 'please try again.');
      }, function(evt) {
        var progress = parseInt(100.0 * evt.loaded / evt.total);
        self.$scope.uploadProgress = progress;
      });
    }
  }

  MaterialControl.prototype.sizeToWindow = function() {
    var self          = this,
        subnavHeight  = $('.material-subnav').outerHeight(),
        toolbarHeight = $('.toolbar').outerHeight(),
        headerHeight  = $('.nav-wrapper').outerHeight(),
        height        = self.$window.innerHeight - subnavHeight - toolbarHeight - headerHeight - 1;

    $('#markdown').height(height + 'px');
    $('#preview').height(height + 'px');
    self.editor.resize();
  }

  MaterialControl.prototype.beforeWindowUnload = function() {
    var self = this;

    return self.savedMarkdown !== self.$scope.markdown
      ? 'Your work has not finished saving.'
      : undefined;
  }

  MaterialControl.prototype.toggleDraft = function() {
    var self = this;

    self.$scope.material.customPUT({isDraft:!self.$scope.material.isDraft}, 'draft')
      .then(function(result) {
        if (result && result.material) {
          angular.extend(self.$scope.material, result.material);
        }
      });
  }

  MaterialControl.prototype.updateMaterial = function(name) {
    var self     = this,
        name     = name.trim(),
        deferred = self.$q.defer();

    self.$scope.material.customPUT({name:name}, 'name')
      .then(function(result) {
        if (result && result.material) {
          angular.extend(self.$scope.material, result.material);

          // update URL path
          var currentPath = self.$location.path().split('/');
          if (currentPath[2] !== result.material.slug) {
            self.materialSlugChange = true;
            var newPath = currentPath[1] + '/' + result.material.slug + '/' + currentPath[3];
            self.$location.replace();
            self.$location.path(newPath);
          }

          return deferred.resolve(true);
        }

        if (result && result.flash && result.flash.validation) {
          return deferred.reject(result.flash.validation.name);
        }

        return deferred.reject('An unknown error occured');
      });

    return deferred.promise;
  }

  MaterialControl.prototype.getPreview = function() {
    return this.$scope.markup.length
      ? this.$sce.trustAsHtml(this.$scope.markup)
      : this.$sce.trustAsHtml('<div class="material-preview">A preview of your page will appear here.</div>');
  }

  MaterialControl.prototype.markDirty = function() {
    var self = this;

    self.$scope.dirty = true;

    // reset the auto-save timeout
    if (self.autoSaveTimeout) {
      self.$timeout.cancel(self.autoSaveTimeout);
    }
    self.autoSaveTimeout = self.$timeout(function() {
      self.autoSave();
    }, 1000);

    // resave the preview render timeout
    if (self.renderTimeout) {
      self.$timeout.cancel(self.renderTimeout);
    }

    self.renderTimeout = self.$timeout(function() {
      self.renderPreview();
    }, self.renderDelay);
  }

  MaterialControl.prototype.renderPreview = function() {
    var self = this;

    if (self.$scope.stopRenderAndSave) return;

    self.renderTimeout = false;
    var start = new Date();
    self.$scope.markup = self.parser(self.$scope.markdown);
    if(!self.$scope.$$phase) {
      self.$scope.$apply();
    }
    self.$timeout(function() {
      MathJax.Hub.Queue(["Typeset",MathJax.Hub,"preview"]);
    });
    self.renderDelay = Math.min((new Date()) - start, 5000);
  }

  MaterialControl.prototype.autoSave = function() {
    var self = this;

    if (self.$scope.stopRenderAndSave) return;
    if (self.$scope.saving) return;

    var oldContent = self.savedMarkdown;
    var newContent = self.$scope.markdown;

    if (oldContent === newContent) {
      self.$scope.dirty = false;
      return;
    }

    self.$scope.saving = true;
    self.$scope.saved  = self.$scope.saveError = false;
    self.$scope.customError = '';

    var patch = JsDiff.createPatch(self.$scope.material.id, oldContent, newContent);
    // remove the header
    patch = patch.substr(patch.indexOf('@'));

    self.$scope.material.customPUT({patch:patch}, 'patchContent')
      .then(function(result) {
        var resultError = false;

        if (result && result.material) {
          self.savedMarkdown = newContent;
          angular.extend(self.$scope.material, result.material);

          self.$timeout(function() {
            self.$scope.saving = false;
            self.$scope.saved  = true;
          }, 250);
        }
        else if (result && result.status === 'error') {
          self.$timeout(function() {
            self.$scope.saving      = false;
            self.$scope.saveError   = true;
            self.$scope.customError = result.message;
          }, 250);

          resultError = true;
        }
        else {
          // just in case...
          self.$timeout(function() {
            self.$scope.saving = false;
          }, 250);
        }

        if (resultError) {
          // stop rendering and autosave attempts...
          self.$scope.stopRenderAndSave = true;
        }
        else {
          // check if the save brought the content up to date
          if (!result || !result.material || self.$scope.markdown !== newContent) {
            // not up to date so if an autosave is not yet scheduled go ahead and resave
            !self.autoSaveTimeout && self.autoSave();
          }
          else {
            // we are up to date!
            self.$scope.dirty = false;
          }
        }
      }, function() {
        // ensure autosaving can start back up again...
        self.$timeout(function() {
          self.$scope.saving      = false;
          self.$scope.saveError   = true;
          self.$scope.customError = "Check your network connection.";
        }, 250);

        // try to save again every 5 seconds...
        if (self.autoSaveTimeout) {
          self.$timeout.cancel(self.autoSaveTimeout);
        }
        self.autoSaveTimeout = self.$timeout(function() {
          self.autoSave();
        }, 5000);
      });
  }

  return angular
    .module('courseEditor')
    .controller('materialControl', ['$scope', '$q', '$route', '$routeParams', '$sce', '$compile', 'Upload', '$window', '$location', '$timeout', '$interval', '$filter', 'markdownParser', 'Restangular', 'trinketConfig', MaterialControl]);
})(window.angular);
