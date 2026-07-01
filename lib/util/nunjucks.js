var config      = require('config'),
    path        = require('path'),
    _           = require('underscore'),
    lodash      = require('lodash'),
    moment      = require('moment'),
    numeral     = require('numeral'),
    nunjucks    = require('nunjucks'),
    _loader     = new nunjucks.FileSystemLoader(config.app.templates, {watch: config.isDev || config.isTest}),
    env         = new nunjucks.Environment(_loader, {autoescape: true}),
    StringUtils = require('./stringUtils'),
    cachify     = require('./cachify'),
    translate   = require('./translate'),
    roles       = require('./roles'),
    component   = require('./component'),
    constants   = require('../../config/constants');

// Lock loaders against external replacement — something in the startup
// sequence reassigns env.loaders directly, wiping the FileSystemLoader.
var _loaders = env.loaders.slice();
Object.defineProperty(env, 'loaders', {
  get: function() { return _loaders; },
  set: function() {},   // silently ignore replacements
  configurable: true
});

env.addFilter('cachePrefix', function(src, key) {
  return StringUtils.addPrefix(src, config.app.prefixes, key);
});
env.addFilter('json', function(str, opt) {
  if (opt === 'pretty') {
    return JSON.stringify(str, null, 2);
  } else {
    return JSON.stringify(str);
  }
});
env.addFilter('translate', function(str, locale) {
  return translate(str, locale);
});
env.addFilter('userAvatar', function(str) {
  if (!str) {
    return '/img/avatar-default.svg';
  }
  // Already a full URL
  if (/^http/.test(str)) {
    return str;
  }
  // Already a local path
  if (/^\//.test(str)) {
    return str;
  }
  // Relative path - prepend cloud host if configured
  var cloudHost = config.aws.buckets.useravatars.host || '';
  if (cloudHost.length > 0 && !cloudHost.includes('example.com')) {
    return cloudHost + '/' + str;
  }
  // Default to local img path
  return '/img/' + str;
});
env.addFilter('encrypt', function(obj) {
  return roles.encrypt(obj);
});
function escapeJSON(data) {
  if (typeof data === 'undefined' || data === null) {
    return null;
  }

  if (data instanceof Array) {
    for (var i = 0; i < data.length; i++) {
      data[i] = escapeJSON(data[i]);
    }
  }
  else if (typeof data === 'object') {
    for (var i in data) {
      if (data.hasOwnProperty(i)) {
        data[i] = escapeJSON(data[i]);
      }
    }
  }
  else if (typeof data === 'string') {
    // lodash and underscore can produce different results
    // lodash is used on the client-side so we'll use it here too
    data = lodash.escape(data);
  }

  return data;
}
env.addFilter('escapeJSON', function(obj) {
  var e = escapeJSON(obj);
  return e;
});

module.exports = {
  render: function(template, context) {
    if (config.isDev || config.isTest) {
      env.cache = {};
    }
    return new Promise(function(resolve, reject) {
      nunjucks.render(template, context, function(err, result) {
        if (err) return reject(err);
        resolve(result);
      });
    });
  },
  compile: function(src, info) {
    // Vision passes src (template source string) and info.filename (absolute path)
    // Extract template name relative to templates directory for nunjucks.render()
    // We need to convert absolute path to relative path from templates directory
    var templatesDir = path.resolve(config.app.templates);
    var templateName = info.filename.replace(templatesDir, '');
    // Remove leading slash if present
    if (templateName.charAt(0) === '/' || templateName.charAt(0) === '\\') {
      templateName = templateName.substring(1);
    }

    var subdomain = function(instructor, course) {
      if (config.app.usersubdomains) {
        return '/' + course.slug;
      }
      else {
        return ['', 'u', instructor.slug, 'classes', course.slug].join('/');
      }
    };
    var host = function(instructor) {
      var url = config.app.url.protocol + '://';
      if (config.app.usersubdomains && instructor) {
        url += instructor.slug + '.'
      }
      url += config.app.url.hostname;
      return url;
    };

    return function(context) {
      // kill the nunjucks cache when in dev mode
      if (config.isDev || config.isTest) {
        env.cache = {};
      }

      _.extend(context, {
        config     : config,
        moment     : moment,
        numeral    : numeral,
        subdomain  : subdomain,
        host       : host,
        cachify_js : cachify.js,
        translate  : translate,
        component  : component,
        constants  : constants
      });

      return env.render(templateName, context);
    };
  },
  env : env
}
