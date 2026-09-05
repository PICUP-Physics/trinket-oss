(function(angular) {
  'use strict';

  var Range = ace.require('ace/range').Range;

  function ToolbarControl($scope, $window, $http, trinketConfig) {
    this.$scope  = $scope;
    this.$window = $window;
    this.$http   = $http;
    this.trinketConfig = trinketConfig;

    this.defineListeners();
    this.defineScope();
  }

  ToolbarControl.prototype.defineListeners = function() {
    var self = this;

    self.$scope.$on('$destroy',function(){self.destroy();});
  }

  ToolbarControl.prototype.defineScope = function() {
    var self = this;

    self.$scope.inline = self.inline.bind(self);
    self.$scope.block  = self.block.bind(self);

    self.editor  = self.$window.ace.edit('markdown'),
    self.session = self.editor.getSession();

    self.$scope.searchTrinkets = function(val) {
      self.$scope.loadingTrinkets = true;
      self.$scope.searchInputActive = true;
      return self.$http.get('/api/trinkets/search', {
        params : {
          q : val
        }
      }).then(function(results) {
        self.$scope.loadingTrinkets = false;
        var trinkets = [];
        angular.forEach(results.data.results, function(trinket) {
          trinkets.push({
              id        : trinket.id
            , name      : trinket.name || 'Untitled'
            , lang      : trinket.lang
            , shortCode : trinket.shortCode
          });
        });
        return trinkets;
      });
    }

    self.$scope.toggleSearchInput = function() {
      self.$scope.searchInputOpen = self.$scope.searchInputOpen === true ? false : true;
      if (self.$scope.searchInputOpen) {
        $('#trinket-search').focus();
      }
      else {
        self.$scope.searchInputActive = false;
      }
    }

    self.$scope.insertSelectedTrinket = function(item) {
      self.$scope.trinketSearchValue = "";
      // Root-relative ON PURPOSE. This string is STORED in the material, and
      // getUrl() would stamp in the authoring deploy's hostname — pinning the
      // page to whichever deploy it was written on. Two trials sharing a
      // Firestore made that visible: a course authored on one rendered on the
      // other with every embed still pointing back. The renderers are already
      // host-agnostic, and it cannot be corrected on serve (see M&I #7 and
      // test/lib/api/editor-embed-conflict.test.js), so it has to be right here.
      var src = "/embed/" + item.lang + "/" + item.shortCode;
      self.editor.insert("\n<iframe src='" + src + "?start=result' width='100%' height='400' frameborder='0' marginwidth='0' marginheight='0' allowfullscreen></iframe>\n");
      self.$scope.searchInputOpen   = false;
      self.$scope.searchInputActive = false;
    }

    // close search box if a click is outside
    $(document).on('click', function(event) {
      var targetId = event.target.id || $(event.target).parent().attr('id');

      if (targetId !== "search-label" && targetId !== "trinket-search") {
        self.$scope.searchInputOpen   = false;
        self.$scope.searchInputActive = false;
        self.$scope.$apply();
      }
    });
  }

  ToolbarControl.prototype.getRange = function(selection, startPosition, length) {
    selection.moveCursorToPosition(startPosition);
    for(var i = 0; i < Math.abs(length); i++) {
      selection['moveCursor' + (length < 0 ? 'Left' : 'Right')]();
    }

    var cursor = selection.getCursor();
    var start  = (length < 0) ? cursor : startPosition;
    var end    = (length < 0) ? startPosition : cursor;

    return new Range(start.row, start.column, end.row, end.column);
  }

  ToolbarControl.prototype.inline = function(left, right, defaultText) {
    var range      = this.editor.getSelectionRange(),
        selection  = this.editor.getSelection(),
        text       = this.editor.getCopyText() || defaultText || '',
        session    = this.editor.getSession(),
        leftRange  = this.getRange(selection, range.start, -left.length),
        rightRange = this.getRange(selection, range.end, right.length);

    if (session.getTextRange(leftRange) === left && session.getTextRange(rightRange) === right) {
      // unwrap the already present formatting
      range.setStart(leftRange.start);
      range.setEnd(rightRange.end);

      if (text === defaultText) {
        text = '';
      }

      selection.setSelectionRange(range);
      this.editor.insert(text);
      selection.moveCursorToPosition(range.start);
    }
    else {
      selection.setSelectionRange(range);
      this.editor.insert(left + text + right);
      selection.moveCursorToPosition(range.start);
      for(var i = 0; i < left.length; i++) {
        selection.moveCursorRight();
      }
    }

    for(var i = 0; i < text.length; i++) {
      selection.selectRight();
    }

    this.editor.focus();
  }

  ToolbarControl.prototype.block = function(left, right, defaultText) {
    this.inline(left + '\n', '\n' + right, defaultText);
  }

  ToolbarControl.prototype.destroy = function() {

  }

  return angular
    .module('courseEditor')
    .controller('toolbarControl', ['$scope', '$window', '$http', 'trinketConfig', ToolbarControl]);
})(window.angular);
