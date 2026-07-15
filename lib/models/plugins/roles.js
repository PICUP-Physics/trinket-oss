var _        = require('underscore')
  , moment   = require('moment')
  , settings = ['thru', 'limits']
  , Roles    = require('../roles');

module.exports = function(schema) {

  // if thru is set for a role,
  // it will also be set for each permission in that role

  schema.add({
    roles : [ {
      _id         : false,
      context     : { type : String },
      roles       : [ { type : String } ],
      permissions : [ { type : String } ],
      thru        : { type : Object },
      limits      : { type : Object }
    }]
  });

  schema.methods.grant = function(role, context, options) {
    var self          = this
      , updateOptions = { new : true }
      , index, roleExtension, newRole, update;

    options = _.extend(options || {});

    if (options.id) {
      context = context + ':' + options.id;
    }

    // e.g. grant trinket-connect, plus trinket-connect-organization
    if (options.extension) {
      roleExtension = role + '-' + options.extension;
      if (options.extId) {
        roleExtension = roleExtension + ':' + options.extId;
      }
    }

    index = _.findIndex(this.roles, function(role) {
      return role.context === context;
    });

    if (index >= 0) {
      if (this.roles[index].roles.indexOf(role) < 0) {
        this.roles[index].roles.push(role);
      }

      if (roleExtension && this.roles[index].roles.indexOf(roleExtension) < 0) {
        this.roles[index].roles.push(roleExtension);
      }

      settings.forEach(function(setting) {
        if (typeof self.roles[index][setting] === 'undefined') {
          self.roles[index][setting] = {};
        }
      });

      if (options.thru) {
        this.roles[index].thru[role] = options.thru;
        if (roleExtension) {
          this.roles[index].thru[roleExtension] = options.thru;
        }
      }
    }
    else {
      newRole = {
          context : context
        , roles   : [role]
        , thru    : {}
        , limits  : {}
      };

      if (roleExtension) {
        newRole.roles.push(roleExtension);
      }

      if (options.thru) {
        newRole.thru[role] = options.thru;
        if (roleExtension) {
          newRole.thru[roleExtension] = options.thru;
        }
      }

      this.roles.push(newRole);

      index = this.roles.length - 1;
    }

    return Promise.all([
        Roles.getPermissions(role)
      , Roles.getLimits(role)
      ])
      .then(function(results) {
        var permissions = results[0];
        var limits = results[1];

        if (self.roles[index].permissions && self.roles[index].permissions.length) {
          self.roles[index].permissions = _.union(self.roles[index].permissions, permissions);
        }
        else {
          self.roles[index].permissions = permissions;
        }

        if (self.roles[index].thru[role]) {
          // set thru for each permission
          permissions.forEach(function(permission) {
            self.roles[index].thru[permission] = addThru(roleExtension || role, self.roles[index].thru[permission], self.roles[index].thru[role]);
          });
        }

        if (limits) {
          permissions.forEach(function(permission) {
            if (limits[permission]) {
              self.roles[index].limits[permission] = limits[permission];
            }
          });
        }

        if (options._skipUpdate) {
          return Promise.resolve();
        }
        else {
          update = {
            "$set" : {
              roles : self.roles
            }
          };

          return User.findByIdAndUpdate(self.id, update, updateOptions);
        }
      });
  }

  // sets roles on user object without saving
  // used when creating a new user
  schema.methods.setRoles = function(role, context, options) {
    options = _.extend(options || {});

    options._skipUpdate = true;

    return this.grant(role, context, options);
  }

  schema.methods.revoke = function(role, context, options) {
    var self               = this
      , originalRole       = role
      , updateOptions      = { new : true }
      , update, index, roleIndex, roleThru, i;

    options = _.extend(options || {});

    if (options.id) {
      context = context + ':' + options.id;
    }

    // e.g. grant trinket-connect, plus trinket-connect-organization
    if (options.extension) {
      role = role + '-' + options.extension;
      if (options.extId) {
        role = role + ':' + options.extId;
      }
    }

    index = _.findIndex(this.roles, function(role) {
      return role.context === context;
    });

    if (index >= 0) {
      roleIndex = this.roles[index].roles.indexOf(role);

      if (roleIndex >= 0) {
        this.roles[index].roles.splice(roleIndex, 1);

        if (this.roles[index].thru && this.roles[index].thru[role]) {
          roleThru = this.roles[index].thru[role];
          delete this.roles[index].thru[role];
        }

        if (options.extension && this.roles[index].thru[originalRole]) {
          // check if original role should be removed too
          // the only way to guess if they're related is if the thru date matches...
          roleThru = new Date(roleThru);
          var originalThru = new Date(this.roles[index].thru[originalRole]);

          if (roleThru && roleThru.getTime() === originalThru.getTime()) {
            this.roles[index].roles.splice(this.roles[index].roles.indexOf(originalRole), 1);
            delete this.roles[index].thru[originalRole];
          }
        }

        if (this.roles[index].roles.length) {
          return Roles.getPermissions(originalRole)
            .then(function(permissions) {
              // remove all permissions and thru's
              permissions.forEach(function(permission) {
                self.roles[index].permissions.splice(self.roles[index].permissions.indexOf(permission), 1);
                delete self.roles[index].thru[permission];
              });

              // ensure remaining roles permissions and thru are reset

              // holds minimum roles plus any options
              var flatRoles = {};

              for (i = 0; i < self.roles[index].roles.length; i++) {
                if (self.roles[index].roles[i].indexOf(':') >= 0) { // role has extension
                  var _fullrole  = self.roles[index].roles[i].substring(0, self.roles[index].roles[i].indexOf(':'));
                  var _role      = _fullrole.substring(0, _fullrole.lastIndexOf('-'));
                  var _extension = _fullrole.substring(_fullrole.lastIndexOf('-') + 1);
                  var _id        = self.roles[index].roles[i].substring(self.roles[index].roles[i].indexOf(':') + 1);

                  flatRoles[_role] = {
                      extension : _extension
                    , extId     : _id
                  };

                  if (roleThru) {
                    flatRoles[_role].thru = roleThru;
                  }
                }
                else if (typeof flatRoles[self.roles[index].roles[i]] === 'undefined') {
                  flatRoles[self.roles[index].roles[i]] = {};
                }
              }

              var promises  = [];
              var flatRolesKeys = Object.keys(flatRoles);

              for (i = 0; i < flatRolesKeys.length; i++) {
                promises.push(
                  self.setRoles( flatRolesKeys[i], context, flatRoles[ flatRolesKeys[i] ] )
                );
              }

              return Promise.all(promises);
            })
            .then(function(results) {
              update = {
                "$set" : {
                  roles : self.roles
                }
              };

              return User.findByIdAndUpdate(self.id, update, updateOptions);
            });
        }
        else {
          self.roles.splice(index, 1);
          return self.save();
        }
      }
    }

    return Promise.resolve();
  }

  schema.methods.revokeAll = function(context, options) {
    var index;

    options = _.extend(options || {});

    if (options.id) {
      context = context + ':' + options.id;
    }

    index = _.findIndex(this.roles, function(role) {
      return role.context === context;
    });

    if (index >= 0) {
      this.roles.splice(index, 1);
      return this.save();
    }

    return Promise.resolve();
  }

  schema.methods.hasRole = function() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('roles');
    return has.apply(this, args);
  }

  /**
   * initially intended for checking if a user has some role in a course
   */
  schema.methods.hasAnyRole = function(context, options) {
    options = _.extend(options || {});

    if (!context) {
      context = 'site';
    }
    if (options.id) {
      context = context + ':' + options.id;
    }

    var roles = _.find(this.roles, function(role) {
      return role.context === context;
    });

    return roles && roles.roles.length;
  }

  schema.methods.loggedInAs = function() {
    return this._realUserId || false;
  }

  schema.methods.getRole = function(role, context, options) {
    options = _.extend(options || {});

    if (!context) {
      context = 'site';
    }
    if (options.id) {
      context = context + ':' + options.id;
    }

    if (options.extension) {
      role = role + '-' + options.extension;
      if (options.extId) {
        role = role + ':' + options.extId;
      }
    }

    var roles = _.find(this.roles, function(role) {
      return role.context === context;
    });

    if (roles && roles.roles.indexOf(role) >= 0) {
      return roles;
    }

    return undefined;
  }

  schema.methods.getByContext = function(context) {
    var roles = _.find(this.roles, function(role) {
      return role.context === context;
    });

    return roles;
  }

  schema.methods.hasPermission = function() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('permissions');
    return has.apply(this, args);
  }

  schema.methods.mergeRoles = function(roles) {
    var merged     = []
      , keyIndices = {}
      , index, key;

    roles.forEach(function(roleObj) {
      if (typeof keyIndices[ roleObj.context ] === 'undefined') {
        merged.push(roleObj);
        keyIndices[ roleObj.context ] = merged.length - 1;
      }
      else {
        index = keyIndices[ roleObj.context ];
        for (key in roleObj) {
          if (Array.isArray(merged[index][key])) {
            merged[index][key] = _.union(merged[index][key], roleObj[key]);
          }
          else {
            merged[index][key] = roleObj[key];
          }
        }
      }
    });

    this.roles = merged;
  },

  schema.methods.limitReached = function(role) {
    // assumed to be a site-wide permission for now
    var context = 'site'
      , index;

    index = _.findIndex(this.roles, function(role) {
      return role.context === context;
    });

    if (index >= 0 && this.roles[index].limits && this.roles[index].limits[role]) {
      if (limitReached(this.roles, role, this.roles[index].limits[role])) {
        return true;
      }
    }

    return false;
  }

}

// name is the actual role or permission
// from is 'roles' or 'permissions'
function has(from, name, context, options) {
  options = _.extend(options || {});

  if (!context) {
    context = 'site';
  }
  if (options.id) {
    context = context + ':' + options.id;
  }

  if (options.extension) {
    name = name + '-' + options.extension;
    if (options.extId) {
      name = name + ':' + options.extId;
    }
  }

  var roles = _.find(this.roles, function(role) {
    return role.context === context;
  });

  if (roles && roles[from].indexOf(name) >= 0) {
    if (roles.limits && roles.limits[name] && limitReached(this.roles, name, roles.limits[name])) {
      if (roles.thru && roles.thru["unlimited-" + name]) {
        return moment().isBefore(roles.thru["unlimited-" + name]);
      }

      return false;
    }
    else {
      if (roles.thru && roles.thru[name]) {
        if (Array.isArray(roles.thru[name])) {
          return _.some(roles.thru[name], function(thru) {
            // if thru is an object, test values
            if (thru instanceof Object) {
              return _.some(_.values(thru), function(date) {
                return moment().isBefore(date);
              });
            }
            else {
              // assumed to be a date
              return moment().isBefore(thru);
            }
          });
        }
        else {
          return moment().isBefore(roles.thru[name]);
        }
      }
      else {
        return true;
      }
    }
  }

  return false;
}

function limitReached(roles, permission, limit) {
  // get role we're looking for to count
  var checkRole = Roles.getCheck(permission)
    , used      = 0;

  roles.forEach(function(role) {
    if (role.roles.indexOf(checkRole) >= 0) {
      used++;
    }
  });

  return used >= limit;
}

function addThru(role, thruObj, thru) {
  var addedThru = {}
    , i;

  addedThru[role] = thru;

  if (thruObj) {
    if (Array.isArray(thruObj)) {
      for (i = 0; i < thruObj.length; i++) {
        if (thruObj[i] instanceof Object) {
          thruObj[i][role] = thru;
          delete addedThru[role];
        }
      }

      if (!_.isEmpty(addedThru)) {
        thruObj.push(addedThru);
      }
    }
    else {
      thruObj = [thruObj, addedThru];
    }
  }
  else {
    thruObj = [addedThru];
  }

  return thruObj;
}
