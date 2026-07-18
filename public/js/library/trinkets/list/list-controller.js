TrinketIO.export('library.trinkets.list.controller', [
'$scope', '$state', '$stateParams', '$window', '$timeout', '$filter', '$http', 'trinketConfig', 'trinketUtil', 'trinketsApi', 'libraryState', 'foldersApi',
function($scope, $state, $stateParams, $window, $timeout, $filter, $http, trinketConfig, trinketUtil, trinketsApi, libraryState, foldersApi) {
  var allLoaded = false,
      loading   = false,
      cache     = TrinketIO.import('utils.cache'),
      last, lastCount;

  if (libraryState.userParam && !$stateParams.user) {
    libraryState.resetList();
  }

  $scope.viewType = cache.get('library-view-type') || 'large';
  $scope.items    = libraryState.trinkets;
  $scope.folders  = libraryState.folders;
  $scope.sortBy   = cache.get("library-sort-by") || libraryState.listParams.sort;
  last            = libraryState.listParams.from;
  lastCount       = libraryState.listParams.offset;

  $scope.userParam = $stateParams.user || '';

  // shared between this controller and trinket.search directive
  $scope.searchInputOpen = false;

  // ---- Bulk selection + filters -------------------------------------------
  var selectionModel = TrinketIO.import('library.selection');
  $scope.selection = selectionModel.create();
  $scope.filters   = { name : '', updatedWithin : 'all', scope : 'root' };

  $scope.toggleSelect    = function(id) { selectionModel.toggle($scope.selection, id); };
  $scope.isSelected      = function(id) { return selectionModel.has($scope.selection, id); };
  $scope.selectionCount  = function() { return selectionModel.count($scope.selection); };
  $scope.clearSelection  = function() { selectionModel.clear($scope.selection); };

  // Re-fetch the list from scratch with the current filter/scope params.
  $scope.reloadWithFilters = function() {
    libraryState.resetList();
    $scope.items = undefined;
    allLoaded    = false;
    last         = undefined;
    lastCount    = 0;
    $scope.clearSelection();
    $scope.moreTrinkets();
  };

  $scope.initSort = function(sortBy) {
    libraryState.resetList();

    $scope.sortBy = sortBy;
    $scope.items  = undefined;
    allLoaded     = false;
    last          = undefined;
    lastCount     = 0;

    $scope.moreTrinkets();
  }
  $scope.changeView = function(viewType) {
    $scope.viewType = viewType;
  }

  $scope.gotoFolder = function(slug) {
    $state.go('folderList', { slug : slug });
  }
  $scope.gotoTrinket = function(shortCode) {
    $state.go('detail', { shortCode : shortCode });
  }
  $scope.gotoSelectedTrinket = function(item) {
    $state.go('detail', { shortCode : item.shortCode });
  }

  $scope.sortOptions = {
      '-lastUpdated' : {
          label : 'Last Updated'
        , class : 'fa fa-floppy-o fa-fw'
      }
    , '-lastView.viewedOn' : {
          label : 'Last Viewed'
        , class : 'fa fa-eye fa-fw'
      }
    , '-totalViews' : {
          label : 'Most Viewed'
        , class : 'fa fa-sort-numeric-desc fa-fw'
      }
    , 'name' : {
          label : 'Name'
        , class : 'fa fa-sort-alpha-asc fa-fw'
      }
  };
  $scope.viewOptions = {
      'large' : {
          label : 'Grid'
        , class : 'fa fa-th-large fa-fw'
      }
    , 'list' : {
          label : 'List'
        , class : 'fa fa-th-list fa-fw'
      }
  };

  $scope.dragging   = null;
  $scope.overFolder = false;

  Sortable.create($('#trinkets-list').get(0), {
      sort   : false
    , filter : '.a-folder'
    , disabled: 'ontouchstart' in window
    , scroll : true
    , dragoverBubble : true // undocumented option to let drag events bubble up
    , chosenClass : 'dragging-trinket'
    , onStart : function(evt) {
        $scope.dragging = $(evt.item).data('id');
        $scope.overFolder = false;
      }
    , onEnd : function(evt) {
        if ($scope.overFolder && $scope.dragging) {
          var moveTrinket = $filter('filter')($scope.items || [], { id : $scope.dragging });
          var toFolder    = $filter('filter')($scope.folders, { id : $scope.overFolder })[0];
          if (moveTrinket.length) {
            moveTrinket[0].addToFolder({ folderId : $scope.overFolder })
              .then(function() {
                // remove trinket from items
                var moveIndex = $scope.items.indexOf(moveTrinket[0]);
                $scope.items.splice(moveIndex, 1);

                // update folder.trinketCount
                toFolder.trinketCount++;

                libraryState.resetList();
              });
          }
        }

        if ($scope.overFolder) {
          $('[data-id="' + $scope.overFolder + '"]').removeClass('folder-dropzone');
        }

        $scope.dragging   = null;
        $scope.overFolder = false;
      }
  });

  $(document).on('dragover', function(event) {
    event.stopPropagation();

    var currentFolder = $scope.overFolder;

    if ($(event.target).is('li.a-folder')) {
      $scope.overFolder = $(event.target).data('id');
    }
    else if ($(event.target).parents('li.a-folder').length) {
      $scope.overFolder = $(event.target).parents('li.a-folder').data('id');
    }

    if ($scope.overFolder) {
      if (currentFolder) {
        $('[data-id="' + currentFolder + '"]').removeClass('folder-dropzone');
      }
      $('[data-id="' + $scope.overFolder + '"]').addClass('folder-dropzone');
    }
  });

  $(document).on('dragleave', function(event) {
    event.stopPropagation();

    if ($scope.overFolder && $(event.target).is('li.a-folder') && !$(event.target).parents('li.a-folder').length) {
      $('[data-id="' + $scope.overFolder + '"]').removeClass('folder-dropzone');
      $scope.overFolder = false;
    }
  });

  $('#library-sort-options').on('opened.fndtn.dropdown', function() {
    var h = $('#listview-options').outerHeight();
    $(this).css('top', h + 'px');
  });

  $('#library-view-options').on('opened.fndtn.dropdown', function() {
    var h = $('#listview-options').outerHeight();
    $(this).css('top', h + 'px');
  });

  $scope.$on("$destroy", function() {
    libraryState.listParams = {
      sort   : $scope.sortBy,
      from   : last,
      offset : lastCount
    }
    libraryState.scrollPos   = $($window).scrollTop();
    libraryState.trinkets    = $scope.items;
    libraryState.folders     = $scope.folders;
    libraryState.lastTrinket = undefined;

    if ($stateParams.user) {
      libraryState.userParam = $stateParams.user;
    }
  });

  $scope.folderMessage = function(message, type) {
    if (type === "success") {
      $('#new-folder-modal').foundation('reveal', 'close');
    }
    else {
      $('#new-folder-messages').notify(
        message, { className : type }
      );
    }
  }

  $scope.$watch('viewType', function(newValue, oldValue) {
    cache.set("library-view-type", newValue);
  });

  $scope.$watch('sortBy', function(newValue, oldValue) {
    cache.set("library-sort-by", newValue);
  });

  $scope.moreTrinkets = function() {
    var self = this,
        trinketParams = {
          limit: 20
        };

    if (allLoaded || loading) {
      return;
    }

    loading = true;

    if (last != null && last != undefined) {
      trinketParams.from = last.toString().length ? last : '~~~';
    }

    if (lastCount) {
      trinketParams.offset = lastCount;
    }

    if ($scope.sortBy) {
      trinketParams.sort = $scope.sortBy;
    }

    if ($stateParams.user) {
      trinketParams.user = $stateParams.user;
    }

    // Bulk filters/scope (server applies them in its in-JS filter pass).
    if ($scope.filters) {
      if ($scope.filters.scope && $scope.filters.scope !== 'root') {
        trinketParams.scope = $scope.filters.scope;
      }
      if ($scope.filters.name) {
        trinketParams.name = $scope.filters.name;
      }
      if ($scope.filters.updatedWithin && $scope.filters.updatedWithin !== 'all') {
        trinketParams.updatedWithin = $scope.filters.updatedWithin;
      }
    }

    var prop = ($scope.sortBy.charAt(0) === '-') ? $scope.sortBy.substr(1) : $scope.sortBy;
    var propMap = {
      totalViews : 'metrics.views'
    };
    if (propMap[prop]) {
      prop = propMap[prop];
    }
    // to retrieve metrics
    trinketsApi.getList(trinketParams)
      .then(function(trinkets) {
        if (!$scope.items) {
          $scope.items = [];
        }

        angular.forEach(trinkets, function(trinket) {
          var value;
          
          $scope.items.push(trinket);

          value = trinketUtil.getProperty(trinket, prop);

          if (value != null && last !== value) {
            last = value;
            lastCount = 0;
          }

          lastCount++;
        });

        loading = false;
        if (trinkets.length < trinketParams.limit) {
          allLoaded = true;
        }

        $timeout(function() {
          $(document).foundation();
        }, 0, false);
      })
      .catch(function() {
        loading = false;
      });
  };

  if (!$scope.items) {
    var folderParams = {};
    if ($stateParams.user) {
      folderParams.user = $stateParams.user;
    }

    foldersApi.getList(folderParams)
      .then(function(folders) {
        $scope.folders = folders;
        $scope.moreTrinkets();
      });
  }

  if (libraryState.scrollPos) {
    $timeout(function() {
      $($window).scrollTop(libraryState.scrollPos);
    });
  }
}
]);
