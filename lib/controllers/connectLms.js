// "Connect your LMS" — an approved instructor mints a Dynamic Registration link to hand to their
// LMS admin. Thin wrapper over ltiRegistration.mintRegistrationToken (the DRY anchor).
'use strict';
var Boom = require('@hapi/boom');
var ltiRegistration = require('../util/ltiRegistration');

module.exports = {
  page: function(request, reply) {
    return request.success({});
  },
  createToken: function(request, reply) {
    var label = (request.payload && request.payload.label) || '';
    return ltiRegistration.mintRegistrationToken({ label: label, initiatedByEmail: request.user.email })
      .then(function(out) { return request.success({ url: out.url }); })
      .catch(function(e) { return reply(Boom.badImplementation('Could not create a registration link: ' + e.message)); });
  }
};
