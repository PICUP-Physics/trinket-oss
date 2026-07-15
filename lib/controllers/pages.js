var mailer     = require('../util/mailer'),
    errors     = require('@hapi/boom'),
    Joi        = require('joi'),
    config     = require('config'),
    nunjucks   = require('nunjucks'),
    _          = require('underscore'),
    helpers    = require('../util/helpers'),
    recaptcha  = require('../util/recaptcha');

module.exports = {
  index: function(request, reply) {
    request.success({
      footer : true
    });
  },
  login: function(request, reply) {
  	if (request.auth.isAuthenticated) {
      return reply.redirect('/home');
    } else {
      if (request.query.next) {
        request.yar.set('next', request.query.next);
      }
      request.success();
    }
  },
  signup: function(request, reply) {
    if (request.auth.isAuthenticated) {
      return reply.redirect('/welcome');
    }
    else {
      if (request.query.next) {
        request.yar.set('next', request.query.next);
      }
      request.success({
        next : request.query.next || ""
      });
    }
  },
  welcome: function(request, reply) {
    request.yar.flash('siteMessage', 'Welcome! Your account has been created.', true);
    return reply().redirect('/home');
  },
  home: function(request, reply) {
    // Redirect to login if not authenticated
    if (!request.user) {
      return reply().redirect('/login');
    }

    return Trinket.findRecentByOwner(request.user._id)
      .then(function(trinkets) {
        return request.success({
          trinkets        : trinkets,
          canCreateCourse : helpers.userCanCreateCourse(request.user)
        });
      })
      .catch(request.fail);
  },
  features : function(request, reply) {
    var data = {
        footer  : true
      , feature : request.params.feature
    };

    if (request.pre.namedTrinketList.length) {
      _.extendOwn(data, {
        examples : request.pre.namedTrinketList
      });
    }

    return request.success(data);
  },
  forgotPasswordForm: function(request, reply) {
  	request.success();
  }
};
