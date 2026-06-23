// Simplified roles for open-source version
// All users get full access to all trinket types

// role : [ permissions ]

var permissions = {
    // Default role for all users - full access to all trinket types
    'user' : [
        'create-python-trinket'
      , 'create-pyodide-trinket'
      , 'create-python3-trinket'
      , 'create-blocks-trinket'
      , 'create-html-trinket'
      , 'create-glowscript-trinket'
      , 'create-glowscript-blocks-trinket'
      , 'create-music-trinket'
      , 'create-java-trinket'
      , 'create-pygame-trinket'
      , 'create-R-trinket'
      , 'create-public-course'
      , 'create-private-course'
      , 'hide-trinket-files'
      , 'enable-trinket-tests'
      , 'add-trinket-inline-comments'
      , 'course-assignments'
    ]
    // Admin role - same as user plus admin capabilities
  , 'admin' : [
        'create-python-trinket'
      , 'create-pyodide-trinket'
      , 'create-python3-trinket'
      , 'create-blocks-trinket'
      , 'create-html-trinket'
      , 'create-glowscript-trinket'
      , 'create-glowscript-blocks-trinket'
      , 'create-music-trinket'
      , 'create-java-trinket'
      , 'create-pygame-trinket'
      , 'create-R-trinket'
      , 'create-public-course'
      , 'create-private-course'
      , 'hide-trinket-files'
      , 'enable-trinket-tests'
      , 'add-trinket-inline-comments'
      , 'course-assignments'
    ]
    // Course roles
  , 'course-owner' : [
        'update-course-details'
      , 'manage-course-access'
      , 'change-course-owner'
      , 'manage-course-content'
      , 'view-course-content'
      , 'delete-course'
      , 'manage-course-assignments'
      , 'view-assignment-submissions'
      , 'send-submission-feedback'
    ]
  , 'course-collaborator' : [
        'manage-course-content'
      , 'view-course-content'
    ]
  , 'course-admin' : [
        'update-course-details'
      , 'manage-course-access'
      , 'manage-course-content'
      , 'view-course-content'
      , 'manage-course-assignments'
      , 'view-assignment-submissions'
      , 'send-submission-feedback'
    ]
  , 'course-student' : [
        'view-course-content'
    ]
  , 'course-associate' : [
        'make-course-copy'
      , 'view-course-content'
    ]
    // Folder roles
  , 'folder-owner' : [
        'add-trinket'
      , 'update-folder-details'
    ]
};

// Legacy role aliases for backwards compatibility with existing user data
permissions['trinket-code'] = permissions['user'];
permissions['trinket-connect'] = permissions['user'];
permissions['trinket-connect-trial'] = permissions['user'];
permissions['trinket-codeplus'] = permissions['user'];
permissions['trinket-teacher'] = permissions['user'];

module.exports = {
    getPermissions : function(role) {
      return Promise.resolve(permissions[role] || []);
    }
  , getLimits : function(role) {
      // No limits in open-source version
      return Promise.resolve(undefined);
    }
  , getCheck : function(permission) {
      return undefined;
    }
};
