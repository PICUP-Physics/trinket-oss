// Instructor-authority seam selector. Like backend-factory / ltiNonceStore, the deployment picks
// the impl by config. gcr deployments set config.lti.instructorAuthority = 'instructormi'; oss
// (and the default) get the trust-the-platform impl. Role/authz logic depends only on this module.
'use strict';
var config = require('config');
var which  = (config.lti && config.lti.instructorAuthority) || 'default';
module.exports = (which === 'instructormi')
  ? require('./ltiInstructorAuthority-instructormi')
  : require('./ltiInstructorAuthority-default');
