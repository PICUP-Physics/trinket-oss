(function(angular, module) {

function FolderService(Restangular) {
  this.getList = function(options) {
    return Restangular.all('folders').getList(options);
  }

  // Create a folder; resolves to the API response ({ success, folder }).
  this.create = function(name) {
    return Restangular.all('folders').post({ name: name });
  }

  this.updateName = function(id, data) {
    return Restangular.all('folders').one(id).customPUT(data, 'name');
  }
}

module.service('foldersApi', ['Restangular', FolderService]);

})(window.angular, window.angular.module('trinket.components.folders'));
