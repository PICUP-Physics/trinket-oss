(function(angular, module) {

function TrinketService(Restangular) {
  var _all = Restangular.all('trinkets');

  var augmentTrinket = function augmentTrinket(trinket) {
    if (trinket.metrics) {
      trinket.metrics.social =
          (trinket.metrics.emailShares || 0)
        + (trinket.metrics.linkShares  || 0)
        + (trinket.metrics.embedShares || 0);

      trinket.metrics.views =
          (trinket.metrics.embedViews || 0)
        + (trinket.metrics.linkViews  || 0)
        + (trinket.metrics.emailViews || 0);
    }

    return trinket;
  }

  this.augmentTrinket = augmentTrinket;

  // get a list of trinkets
  this.getList = function getTrinketList(options) {
    return _all.getList(options)
      .then(function(trinkets) {
        angular.forEach(trinkets, augmentTrinket);
        return trinkets;
      });
  }

  this.getOne = function getTrinketById(id) {
    return _all.one(id).get()
      .then(function(trinket) {
        // we may have retrieved the element by shortCode
        // in which case we need to re-restangularize
        // so that id is used for subsequent methods
        var plain = Restangular.stripRestangular(trinket);
            restangularized = Restangular.restangularizeElement(null, plain, 'trinkets');
        return augmentTrinket(restangularized);
      });
  }

  this.updateName = function(id, data) {
    return _all.one(id).customPUT(data, 'name');
  }

  this.takeSnapshot = function(id) {
    return _all.one(id).takeSnapshot();
  }

  this.search = function(q) {
    return _all.customGETLIST("search", { q : q });
  }

  this.updateSlug = function(id, slug) {
    return _all.one(id).customPUT({ slug : slug.trim() }, 'slug')
      .then(function(data) {
        return {
            available : true
          , slug      : slug
        };
      }, function(res) {
        return {
            available : false
          , status    : res.status
        };
      });
  }

  // Batch delete/move. Sends explicit ids (the set the user saw & confirmed);
  // the server re-authorizes each id and returns { ok, failed }.
  this.bulk = function(action, ids, folderId) {
    return _all.customPOST({ action: action, ids: ids, folderId: folderId === undefined ? null : folderId }, 'bulk')
      .then(function(res) {
        var data = Restangular.stripRestangular(res);
        return (data && data.data) ? data.data : data;   // { ok, failed }
      });
  }

  this.publish = function(id) {
    return _all.one(id).customPUT({ published : true }, 'published');
  }
  this.unpublish = function(id) {
    return _all.one(id).customPUT({ published : false }, 'published');
  }
}

module.service('trinketsApi', ['Restangular', TrinketService]);

})(window.angular, window.angular.module('trinket.components.trinkets'));
