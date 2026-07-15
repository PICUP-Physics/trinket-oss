TrinketIO.export('library.trinkets.detail.controller', [
  '$scope', '$document', '$state', '$stateParams', 'trinketConfig', 'trinketsApi', 'libraryState', '$timeout',
  '$interval', '$filter', '$window', '$q', 'trinketRoles', 'foldersApi','trinketShare',
  function($scope, $document, $state, $stateParams, config, trinketsApi, libraryState, $timeout, $interval,
           $filter, $window, $q, roles, foldersApi, trinketShare) {
  if (!$stateParams.shortCode) {
    $state.go('list');
  }

  var timers = {}, lastSavedInterval, originalTitle = $document[0].title;

  $($window).scrollTop(0);

  $scope.isSaving   = false;
  $scope.isModified = false;
  $scope.canSave    = false;
  $scope.canCopy    = false;
  $scope.apiReady   = false;
  $scope.saveError  = false;

  $scope.isAdmin    = $scope.role === 'admin' ? true : false;
  $scope.isSnapping = false;
  $scope.emailEnabled = config.get('emailEnabled');

  $scope.trinketApi  = null;
  $scope.embedWidth  = 100;
  $scope.embedHeight = 600;
  $scope.embedHeightClass = 'large';
  $scope.embedCode   = '';
  $scope.embedUrl    = '';
  $scope.externalInit = false;

  $scope.extraOptions     = false;
  $scope.autorunOption    = false;
  $scope.outputOnlyOption = false;
  $scope.toggleCodeOption = false;
  $scope.runOption        = "";
  $scope.runMode          = "";
  $scope.trinketInFolder  = false;
  $scope.downloadable     = false;

  $scope.blocksOrCode = 'code';

  $scope.folders = libraryState.folders;

  $scope.$on("$destroy", function() {
    $document[0].title = originalTitle;
    if (lastSavedInterval) {
      $interval.cancel(lastSavedInterval);
    }
    for(var key in timers) {
      $timeout.cancel(timers[key]);
    }
    libraryState.folders = $scope.folders;

    $('#publish-slug').off('input', updateSlugOnChange);
    $('#publishTrinket').off('click', publishTrinket);
    $('#unpublishTrinket').off('click', unpublishTrinket);
  });

  lastSavedInterval = $interval(function() {
    if ($scope.trinket) {
      $scope.timeSinceSave = moment($scope.trinket.lastUpdated).fromNow();
    }
  }, 30000);

  $scope.embedSizes = [
    { name: 'small (150 pixels)',  height: 150, class: 'small'  },
    { name: 'medium (400 pixels)', height: 400, class: 'medium' },
    { name: 'large (600 pixels)',  height: 600, class: 'large'  }
  ];

  $scope.info = {
    embedSize          : $scope.embedSizes[2],
    embedStart         : '',
    embedOutputOnly    : '',
    shareOutputOnly    : '',
    embedToggleCode    : '',
    shareToggleCode    : '',
    embedRunOption     : '',
    shareRunOption     : '',
    embedConsoleOption : '',
    shareConsoleOption : '',

    embedRunMenu       : '',
    embedDisplayMenu   : '',
    shareRunMenu       : '',
    shareDisplayMenu   : ''
  };

  if (libraryState.lastTrinket) {
    $scope.externalInit = true;
  }

  $scope.updateName = function(value) {
    return trinketsApi.updateName($scope.trinket.id, {name:value})
      .then(function(result) {
        if (result.flash && result.flash.validation && result.flash.validation.name) {
          return result.flash.validation.name;
        };
        $document[0].title = $scope.trinket.name = value;
        libraryState.resetList();
        return;
      });
  }

  $scope.copy = function() {
    libraryState.lastTrinket      = $scope.trinket;
    libraryState.lastTrinket.code = $scope.trinketApi.serialize().code;
    $scope.trinketApi.destroy();
    $state.go('copy', { shortCode : $scope.trinket.shortCode });
  }

  $scope.addToLibrary = function(trinket) {
    if ($scope.addingToLibrary) return;
    $scope.addingToLibrary = true;
    $scope.trinketApi.addToLibrary(function(trinket) {
      $scope.addingToLibrary = false;
      return $state.go('detail', {shortCode : trinket.shortCode});
    });
  }

  $scope.remove = function() {
    var trinketId = $scope.trinket.id;
    $scope.trinket.remove().then(function() {
      $scope.closeDeleteModal();
      // Remove from cached list so it doesn't show after navigation
      if (libraryState.trinkets) {
        libraryState.trinkets = libraryState.trinkets.filter(function(t) {
          return t.id !== trinketId;
        });
      }
      $scope.trinketApi.destroy();
      $state.go('list');
    });
  }

  $scope.save = function() {
    $scope.saveError = false;

    if ($scope.trinketApi) {
      var startTime;
      if ($scope.isSaving) {
        return;
      }

      $scope.isSaving = true;
      startTime = (new Date()).getTime();

      $scope.trinketApi.save($scope.trinketApi.serialize(), function(error) {
        if (error) {
          $scope.isSaving  = false;
          $scope.saveError = true;
          $scope.$apply();
          $('#trinketSaveErrorModal').foundation('reveal', 'open');
        }
        else {
          var elapsed = (new Date()).getTime() - startTime;
          var saveComplete = function() {
            $scope.isSaving   = false;
            $scope.isModified = false;
            $scope.trinket.lastUpdated = Date.now();
            delete(timers.save);
          }

          // ensure that the 'saving' state persists for at least 0.5 seconds
          timers.save = $timeout(saveComplete, Math.max(500 - elapsed, 0));
          $scope.timeSinceSave = moment(Date.now()).fromNow();
        }
      });

      libraryState.resetList();
    }
    else {
      // consider opening a modal or showing some other message?
      // in case trinketApi is never ready?
    }
  }

  $scope.messageUs = function() {
    // TODO: Intercom removed - link to support/contact page or remove from template
  }

  $scope.smile = function() {
    var startTime;
    $scope.isSnapping = true;
    startTime = (new Date()).getTime();
    $scope.trinket.takeSnapshot().then(function(result) {
      var elapsed = (new Date()).getTime() - startTime;
      var snapshotTaken = function() {
        $scope.isSnapping = false;
        delete(timers.snapshot);
      }

      timers.snapshot = $timeout(snapshotTaken, Math.max(500 - elapsed, 0));
    });

    libraryState.resetList();
  }

  $scope.addToFolder = function(folder) {
    // Optimistic update - change UI immediately
    $scope.trinket.folder = {
      folderId   : folder.id,
      name       : folder.name,
      folderSlug : folder.slug
    };
    $scope.trinketInFolder = true;

    $scope.trinket.addToFolder({ folderId : folder.id })
      .then(function() {
        libraryState.resetList();
      });
  }

  $scope.removeFromFolder = function(folder) {
    // Optimistic update - change UI immediately
    var previousFolder = $scope.trinket.folder;
    $scope.trinketInFolder = false;
    delete $scope.trinket.folder;

    $scope.trinket.removeFromFolder({ folderId : folder.id })
      .then(function() {
        libraryState.resetList();
      });
  }

  $scope.folderMessage = function(message, type) {
    $('#add-to-folder-messages').notify(
      message, { className : type }
    );
  }

  $scope.emailModal = function() {
    $('#emailModalForm').data('trinket-id', $scope.trinket.id);
    var tokenEl = $('#emailToken');
    if (tokenEl.length && !tokenEl.val() && $scope.trinket.shortCode) {
      try {
        var stored = localStorage.getItem('emailToken:' + $scope.trinket.shortCode);
        if (stored) tokenEl.val(stored);
      } catch (e) {}
    }
    $('#emailModal').foundation('reveal', 'open');
  }
  $scope.linkModal = function() {
    trinketShare.resetParams();

    if (trinketConfig.get('outputOnly').indexOf($scope.trinket.lang) >= 0
    ||  trinketConfig.get('toggleCode').indexOf($scope.trinket.lang) >= 0) {
      $('#shareDisplayOptions').show();
    } else {
      $('#shareDisplayOptions').hide();
    }

    if (trinketConfig.get('runOption')[$scope.trinket.lang]) {
      $('#shareRunOption').show();
    } else {
      $('#shareRunOption').hide();
    }

    $('#showInstructionsShareToggle').attr('checked', false);
    if ($scope.trinket.lang === 'music') {
      $('#showInstructionsShareToggle').hide();
      $('label[for=showInstructionsShareToggle]').hide();
    } else {
      $('#showInstructionsShareToggle').show();
      $('label[for=showInstructionsShareToggle]').show();
    }

    $('#runOptionLink').data('trinket-shortCode', $scope.trinket.shortCode);
    $('#runOptionLink').data('trinket-runMode',   $scope.runMode);
    $('#runOptionLink').val('');

    $('#displayOptionLink').data('trinket-shortCode', $scope.trinket.shortCode);
    $('#displayOptionLink').data('trinket-runMode',   $scope.runMode);
    $('#displayOptionLink').val('');

    $('#shareUrl').text($scope.shareTrinketUrl);

    // need to change display options dropdown text if blocks
    if (/blocks/.test($scope.trinket.lang)) {
      $scope.blocksOrCode = 'blocks';
    }

    // update options
    $('ul#displayOptionTextList li').each(function() {
      $(this).find('span.blocksOrCode').text($scope.blocksOrCode);
      $('#displayOptionLink option[value="' + $(this).data('value') + '"]').text( $(this).text() );
    });

    $('#shareModal').foundation('reveal', 'open');
  }
  $scope.embedModal = function() {
    trinketShare.resetParams();

    if (trinketConfig.get('outputOnly').indexOf($scope.trinket.lang) >= 0
    ||  trinketConfig.get('toggleCode').indexOf($scope.trinket.lang) >= 0) {
      $('#embedDisplayOptions').show();
    } else {
      $('#embedDisplayOptions').hide();
    }

    if (trinketConfig.get('runOption')[$scope.trinket.lang]) {
      $scope.runOption = config.get('runOption')[trinket.lang];
      $('#embedRunOption').show();
    } else {
      $('#embedRunOption').hide();
    }

    $('#autorunEmbedToggle').attr('checked', false);
    if (trinketConfig.get('autorun').indexOf($scope.trinket.lang) >= 0) {
      $('#autorunEmbedToggle').show();
      $('label[for=autorunEmbedToggle]').show();
    } else {
      $('#autorunEmbedToggle').hide();
      $('label[for=autorunEmbedToggle]').hide();
    }

    $('#hideGeneratedCodeEmbedToggle').attr('checked', false);
    if (trinketConfig.get('hideGeneratedCode').indexOf($scope.trinket.lang) >= 0) {
      $('#hideGeneratedCodeEmbedToggle').show();
      $('label[for=hideGeneratedCodeEmbedToggle]').show();
    } else {
      $('#hideGeneratedCodeEmbedToggle').hide();
      $('label[for=hideGeneratedCodeEmbedToggle]').hide();
    }

    $('#showInstructionsEmbedToggle').attr('checked', false);
    if ($scope.trinket.lang === 'music') {
      $('#showInstructionsEmbedToggle').hide();
      $('label[for=showInstructionsEmbedToggle]').hide();
    } else {
      $('#showInstructionsEmbedToggle').show();
      $('label[for=showInstructionsEmbedToggle]').show();
    }

    $('#runOptionEmbed').data('trinket-shortCode', $scope.trinket.shortCode);
    $('#runOptionEmbed').data('trinket-runMode',   $scope.runMode);
    $('#runOptionEmbed').val('');

    $('#displayOptionEmbed').data('trinket-shortCode', $scope.trinket.shortCode);
    $('#displayOptionEmbed').data('trinket-runMode',   $scope.runMode);
    $('#displayOptionEmbed').val('');

    $('#embedCode').text($scope.shareEmbedCode);

    // need to change display options dropdown text if blocks
    if (/blocks/.test($scope.trinket.lang)) {
      $scope.blocksOrCode = 'blocks';
    }

    // update options
    $('ul#displayOptionTextList li').each(function() {
      $(this).find('span.blocksOrCode').text($scope.blocksOrCode);
      $('#displayOptionEmbed option[value="' + $(this).data('value') + '"]').text( $(this).text() );
    });

    $('#embedModal').foundation('reveal', 'open');
  }

  $scope.publishModal = function() {
    var slug;

    $('#slug-status').addClass('hide');
    $('#slug-status-text').empty();

    if (!$scope.trinket.slug || !$scope.trinket.slug.length) {
      slug = $scope.trinket.name.length
        ? getSlug($scope.trinket.name) // from speakingurl
        : $scope.trinket.lang + '-' + $scope.trinket.shortCode;

      $('#published-url').empty();

      updateSlug(slug);
    }
    else {
      slug = $scope.trinket.slug;
      $('#slug-icon-status').removeClass().addClass('fa fa-check-circle fa-lg success');
      updateSlugUrl();
    }

    $('#publish-slug').val(slug);

    if ($scope.trinket.published) {
      $('#publishTrinket').prop('disabled', true);
      $('#publishTrinket').addClass('disabled');
      $('#publishTrinket').html('<i class="fa fa-check"></i> Published');

      $('#unpublishTrinket').prop('disabled', false);
      $('#unpublishTrinket').removeClass('disabled');
    }
    else {
      $('#unpublishTrinket').prop('disabled', true);
      $('#unpublishTrinket').addClass('disabled');

      $('#publishTrinket').prop('disabled', false);
      $('#publishTrinket').removeClass('disabled');
      $('#publishTrinket').html('<i class="fa fa-book"></i> Publish');
    }

    $('#publishModal').foundation('reveal', 'open');
  }

  var updateSlug = function(slug) {
    var resultClasses;
    $('#slug-icon-status').removeClass().addClass('fa fa-circle-o-notch fa-spin');

    slug = slug && slug.length ? slug : $('#publish-slug').val();

    trinketsApi.updateSlug($scope.trinket.id, slug)
      .then(function(result) {
        var updateUrl;

        if (result.available) {
          resultClasses = 'fa fa-check-circle fa-lg success';
          $scope.trinket.slug = result.slug;

          if ($scope.trinket.username) {
            updateUrl = updateSlugUrl;
          }

          $('#slug-status').addClass('hide');
          $('#slug-status-text').empty();

          if (!$scope.trinket.published && $('#publishTrinket').hasClass('disabled')) {
            $('#publishTrinket').prop('disabled', false);
            $('#publishTrinket').removeClass('disabled');
          }

          libraryState.resetList();
        }
        else {
          resultClasses = 'fa fa-times-circle fa-lg alert';

          var statusText;
          if (result.status === 400) {
            statusText = 'Names can only include lowercase letters, numbers, and hyphens.';
          }
          else if (result.status === 409) {
            statusText = 'You have another trinket using this name.';
          }
          else {
            statusText = 'This name could not be used.';
          }

          $('#slug-status').removeClass('hide');
          $('#slug-status-text').text(statusText);

          if (!$scope.trinket.slug) {
            $('#publishTrinket').prop('disabled', true);
            $('#publishTrinket').addClass('disabled');
          }
        }

        setTimeout(function() {
          $('#slug-icon-status').removeClass().addClass(resultClasses);

          // if updateUrl defined
          if (typeof this === 'function') {
            this();
          }
        }.bind(updateUrl), 250);
      }, function(err) {
        console.log('here?', err);
      });
  }

  function updateSlugUrl() {
    var publishedUrl = trinketConfig.getPublishedTrinketUrl($scope.trinket.username, $scope.trinket.slug);
    $('#published-url').attr('href', publishedUrl);
    $('#published-url').text(publishedUrl);
  }

  function publishTrinket(event) {
    if (!$(this).hasClass('disabled')) {
      // if valid slug...
      trinketsApi.publish($scope.trinket.id)
        .then(function() {
          $('#publishTrinket').prop('disabled', true);
          $('#publishTrinket').addClass('disabled');
          $('#publishTrinket').html('<i class="fa fa-check"></i> Published');

          $('#unpublishTrinket').prop('disabled', false);
          $('#unpublishTrinket').removeClass('disabled');

          $scope.trinket.published = true;
          libraryState.resetList();
        });
    }
  }

  function unpublishTrinket(event) {
    if (!$(this).hasClass('disabled')) {
      trinketsApi.unpublish($scope.trinket.id)
        .then(function() {
          $('#unpublishTrinket').prop('disabled', true);
          $('#unpublishTrinket').addClass('disabled');

          $('#publishTrinket').prop('disabled', false);
          $('#publishTrinket').removeClass('disabled');
          $('#publishTrinket').html('<i class="fa fa-book"></i> Publish');

          $scope.trinket.published = false;
          libraryState.resetList();
        });
    }
  }

  var updateSlugOnChange = _.debounce(updateSlug, 500);

  $('#publish-slug').on('input', updateSlugOnChange);
  $('#publishTrinket').on('click', publishTrinket);
  $('#unpublishTrinket').on('click', unpublishTrinket);

  $scope.downloadTrinket = function() {
    $scope.trinketApi.onDownloadClick();
  }

  $scope.$watch('info.embedSize', function(newValue, oldValue) {
    if (newValue.height !== $scope.embedHeight) {
      $('#embed-code').removeClass($scope.embedHeightClass).addClass(newValue.class);
    }
    $scope.embedHeight = newValue.height;
    $scope.embedHeightClass = newValue.class;
    generateEmbedCode();
  });

  $scope.$watch('info.embedDisplayMenu', function(newValue, oldValue) {
    generateEmbedCode('displayOption');
  });
  $scope.$watch('info.embedRunMenu', function(newValue, oldValue) {
    generateEmbedCode('runOption');
  });

  $scope.$watch('info.embedStart', function(newValue, oldValue) {
    generateEmbedCode();
  });

  $scope.$watch('info.shareDisplayMenu', function(newValue, oldValue) {
    generateShareUrl('displayOption');
  });
  $scope.$watch('info.shareRunMenu', function(newValue, oldValue) {
    generateShareUrl('runOption');
  });

  function generateEmbedCode(calledFor) {
    var src         = $scope.embedUrl,
        params      = [],
        queryString = "";

    if ($scope.info.embedStart) {
      params.push('start=result');
    }

    if (calledFor === 'displayOption') {
      $scope.info.embedToggleCode = '';
      $scope.info.embedOutputOnly = '';

      if ($scope.info.embedDisplayMenu) {
        $scope.info[$scope.info.embedDisplayMenu] = true;
      }
    }

    if (calledFor === 'runOption') {
      $scope.info.embedRunOption = '';
      $scope.info.embedConsoleOption = '';

      if ($scope.info.embedRunMenu) {
        $scope.info[$scope.info.embedRunMenu] = true;
      }
    }

    if ($scope.info.embedOutputOnly) {
      params.push('outputOnly=true');
    }
    else if ($scope.info.embedToggleCode) {
      params.push('toggleCode=true');
    }

    if ($scope.info.embedRunOption) {
      params.push('runOption=run');
    }
    else if ($scope.info.embedConsoleOption) {
      params.push('runOption=console');
    }

    if ($scope.runMode) {
      params.push('runMode=' + $scope.runMode);
    }

    queryString = params.join('&');

    if (queryString.length) {
      src += '?' + queryString;
    }

    $scope.embedCode = '<iframe src="' + src + '" width="' + $scope.embedWidth + '%" height="' + $scope.embedHeight + '" frameborder="0" marginwidth="0" marginheight="0" allowfullscreen></iframe>';
    $scope.shareEmbedCode = $scope.embedCode;

    return $scope.embedCode;
  }

  function generateShareUrl(calledFor) {
    var params      = [],
        queryString = "";

    if ($scope.trinketUrl) {
      if (calledFor === 'displayOption') {
        $scope.info.shareToggleCode = '';
        $scope.info.shareOutputOnly = '';

        if ($scope.info.shareDisplayMenu) {
          $scope.info[$scope.info.shareDisplayMenu] = true;
        }
      }

      if (calledFor === 'runOption') {
        $scope.info.shareRunOption = '';
        $scope.info.shareConsoleOption = '';

        if ($scope.info.shareRunMenu) {
          $scope.info[$scope.info.shareRunMenu] = true;
        }
      }

      if ($scope.info.shareOutputOnly) {
        params.push('outputOnly=true');
      }
      else if ($scope.info.shareToggleCode) {
        params.push('toggleCode=true');
      }

      if ($scope.info.shareRunOption) {
        params.push('runOption=run');
      }
      else if ($scope.info.shareConsoleOption) {
        params.push('runOption=console');
      }

      if ($scope.runMode) {
        params.push('runMode=' + $scope.runMode);
      }

      queryString = params.join('&');

      if ($scope.trinketUrl.indexOf('?') > 0) {
        $scope.trinketUrl = $scope.trinketUrl.substring(0, $scope.trinketUrl.indexOf('?'));
      }

      if (queryString.length) {
        $scope.trinketUrl += '?' + queryString;
      }

      $scope.shareTrinketUrl = $scope.trinketUrl;
    }
  }

  $scope.copyToClipboard = function(code) {
    $('#copiedMessage').trigger('mouseenter.fndtn.tooltip');

    timers.copy = $timeout(function() {
      $('#copiedMessage').trigger('mouseleave.fndtn.tooltip');
      delete(timers.copy);
    }, 3000, false);

    return code;
  }

  function setTrinket(trinket) {
    $state.go('detail.embed');

    $document[0].title = trinket.name || ("Untitled " + trinket.lang + " trinket");
    $scope.canSave    = true;
    $scope.isOwner    = trinket._owner === $('#userdata').data('user-id');
    $scope.trinket    = trinket;
    $scope.trinketUrl = $scope.shareTrinketUrl = config.getUrl(trinket.lang + '/' + $stateParams.shortCode);
    $scope.embedUrl   = config.getUrl('embed/' + trinket.lang + '/' + $stateParams.shortCode);

    $scope.iframeUrl  = $scope.embedUrl + '?noSharing=true&noStorage=true&inLibrary=true'
                      + ($stateParams.go  ? '&start=result' : '')
                      + ($stateParams._3d ? '&_3d=true'     : '');

    $scope.timeSinceSave = moment(trinket.lastUpdated).fromNow();

    var permission = ['create', $scope.trinket.lang, 'trinket'].join('-');
    if (roles.hasPermission(permission)) {
      $scope.canCopy = true;
    }

    if (config.get('autorun').indexOf(trinket.lang) >= 0) {
      $scope.autorunOption = true;
    }
    if (config.get('outputOnly').indexOf(trinket.lang) >= 0) {
      $scope.outputOnlyOption = true;
    }
    if (config.get('toggleCode').indexOf(trinket.lang) >= 0) {
      $scope.toggleCodeOption = true;
    }
    if (config.get('runOption')[trinket.lang]) {
      $scope.runOption = config.get('runOption')[trinket.lang];
    }
    $scope.extraOptions = $scope.autorunOption || $scope.outputOnlyOption || $scope.toggleCodeOption;

    if (config.get('downloadable').indexOf(trinket.lang) >= 0) {
      $scope.downloadable = true;
    }

    if ($scope.externalInit) {
      $scope.iframeUrl += '&externalInit=true';
    }

    if (trinket.lang === 'music') {
      $scope.info.embedSize = $scope.embedSizes[1];
    }

    $('#runOptionLink').val('');
    $('#runOptionEmbed').val('');

    $('#displayOptionLink').val('');
    $('#displayOptionEmbed').val('');

    generateEmbedCode();

    if ($scope.trinket.folder && $scope.trinket.folder.folderId) {
      $scope.trinketInFolder = true;
    }
  }

  $scope.$watch('trinketApi', function(newValue, oldValue) {
    if (newValue) {
      if ($scope.externalInit) {
        newValue.initialize(libraryState.lastTrinket);
      }
      $scope.isModified = newValue.isDirty() || newValue.viewingDraft();
      $scope.apiReady   = true;
      $scope.saveError  = false;
    }
  });

  $scope.$watch('runMode', function(newValue, oldValue) {
    generateShareUrl();
    generateEmbedCode();
  });

  var matchingTrinkets = $filter('filter')(libraryState.trinkets || [], {shortCode: $stateParams.shortCode}, true);
  if (matchingTrinkets.length) {
    setTrinket(matchingTrinkets[0]);
  }
  else {
    trinketsApi.getOne($stateParams.shortCode)
      .then(setTrinket)
      .catch(function(err) {
        // Trinket not found or deleted - redirect to list
        $state.go('list');
      });
  }

  if (!$scope.folders) {
    foldersApi.getList()
      .then(function(folders) {
        $scope.folders = folders;
      });
  }
}]

);
