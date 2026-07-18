TrinketIO.export('library.trinkets.list.folderController', [
'$scope', '$document', '$location', '$state', '$stateParams', '$window', '$timeout', '$filter', '$q', 'trinketConfig', 'trinketUtil', 'trinketsApi', 'libraryState', 'foldersApi',
function($scope, $document, $location, $state, $stateParams, $window, $timeout, $filter, $q, trinketConfig, trinketUtil, trinketsApi, libraryState, foldersApi) {
  var allLoaded = false,
      loading   = false,
      cache     = TrinketIO.import('utils.cache'),
      gotInitialItems = false,
      originalTitle = $document[0].title,
      last, lastCount;

  $scope.viewType   = cache.get('library-view-type') || 'large';
  $scope.folders    = libraryState.folders;
  $scope.items      = null;
  $scope.listParams = libraryState.defaultFolderListParams;
  $scope.sortBy     = cache.get("library-sort-by") || $scope.listParams.sort;

  last      = $scope.listParams.from;
  lastCount = $scope.listParams.offset;

  $scope.notConfirmed = true;
  $scope.confirmFolderName = "";

  $scope.gotoTrinket = function(shortCode) {
    $state.go('detail', { shortCode : shortCode });
  }

  // ---- Bulk selection (scope is fixed to this folder) ---------------------
  var selectionModel = TrinketIO.import('library.selection');
  $scope.selection = selectionModel.create();

  $scope.toggleSelect   = function(id) { selectionModel.toggle($scope.selection, id); };
  $scope.isSelected     = function(id) { return selectionModel.has($scope.selection, id); };
  $scope.selectionCount = function() { return selectionModel.count($scope.selection); };
  $scope.clearSelection = function() { selectionModel.clear($scope.selection); };

  $scope.moreTrinkets = function() {
    var self = this,
        trinketParams = {
          limit : 20
        };

    if (allLoaded || loading) {
      return;
    }

    if ($scope.folder) {
      if (gotInitialItems) {
        gotInitialItems = false;
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

      var prop = ($scope.sortBy.charAt(0) === '-') ? $scope.sortBy.substr(1) : $scope.sortBy;
      var propMap = {
        totalViews : 'metrics.views'
      };
      if (propMap[prop]) {
        prop = propMap[prop];
      }

      $scope.folder.customGETLIST('trinkets', trinketParams)
        .then(function(trinkets) {
          if (!$scope.items) {
            $scope.items = [];
          }

          angular.forEach(trinkets, function(trinket) {
            var value;

            trinketsApi.augmentTrinket(trinket);

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
        });
    }
  }

  // if no folders stored in libraryState
  if (!$scope.folders) {
    foldersApi.getList()
      .then(function(folders) {
        $scope.folders = [];
        angular.forEach(folders, function(folder) {
          $scope.folders.push(folder);
        });
        setFolder();
        $scope.moreTrinkets();
      });
  }
  else {
    setFolder();

    // try to get items (trinkets) from libraryState
    if (libraryState.trinketsByFolder && libraryState.trinketsByFolder[$scope.folder.id]) {
      $scope.items = libraryState.trinketsByFolder[$scope.folder.id];
    }

    if (libraryState.folderListParams && libraryState.folderListParams[$scope.folder.id]) {
      $scope.listParams = libraryState.folderListParams[$scope.folder.id];

      last      = $scope.listParams.from;
      lastCount = $scope.listParams.offset;
    }

    // get items (trinkets) from server
    if (!$scope.items) {
      $scope.moreTrinkets();
    }
    else {
      gotInitialItems = true;
    }
  }

  $scope.$on("$destroy", function() {
    libraryState.folders = $scope.folders;
    libraryState.lastTrinket = undefined;

    // Only save folder state if folder was set
    if ($scope.folder) {
      if (!libraryState.trinketsByFolder) {
        libraryState.trinketsByFolder = {};
      }
      libraryState.trinketsByFolder[ $scope.folder.id ] = $scope.items;

      if (!libraryState.folderListParams) {
        libraryState.folderListParams = {};
      }

      libraryState.folderListParams[ $scope.folder.id ] = {
        sort      : $scope.sortBy,
        from      : last,
        offset    : lastCount,
        scrollPos : $($window).scrollTop()
      };
    }

    $document[0].title = originalTitle;
  });

  function setFolder() {
    var found  = $filter('filter')($scope.folders, { slug : $stateParams.slug }, true)
      , userId = $('#userdata').data('user-id')
      , folderOwner;

    if (found[0]) {
      $scope.folder  = found[0];
      folderOwner    = $scope.folder._owner || $scope.folder._owner.id;
      $scope.isOwner = folderOwner === userId;

      $document[0].title = $scope.folder.name;
    }
    else {
      $state.go('list');
    }
  }

  $scope.updateName = function(value) {
    var deferred = $q.defer();

    if (value !== $scope.folder.name) {
      foldersApi.updateName($scope.folder.id, {name:value})
        .then(function(result) {
          if (result.success) {
            var newValue = result.folder.slug;
            $filter('filter')($scope.folders, { slug : $stateParams.slug })[0].slug = newValue;

            libraryState.resetList();
            $state.go('folderList', { slug : newValue }, { location : 'replace' });

            return deferred.resolve();
          }
          else if (result.message) {
            $('#folder-list-messages').notify(
              result.message
              , { className : 'alert' }
            );

            return deferred.reject();
          }
        }, function(err) {
          return deferred.reject();
        }); 

      return deferred.promise;
    }

    return deferred.resolve();
  }

  $scope.compareNamesForDelete = function(inputName) {
    if (inputName === $scope.folder.name) {
      $scope.notConfirmed = false;
    }
    else {
      $scope.notConfirmed = true;
    }
  }

  $scope.remove = function() {
    if (!$scope.notConfirmed) {
      $scope.folder.remove().then(function() {
        $scope.closeDeleteModal();
        libraryState.resetList();
        $state.go('list');
      });
    }
  }

  $scope.addSelectedTrinket = function(trinket) {
    var inFolder = $filter('filter')($scope.items || [], { id : trinket.id });

    // don't add trinket if it's already in this folder
    if (!inFolder.length) {
      trinket.addToFolder({ folderId : $scope.folder.id })
        .then(function() {
          $scope.items.push(trinket);
          $scope.folder.trinketCount++;
          libraryState.resetList();
        });
    }
  }
}
]);
