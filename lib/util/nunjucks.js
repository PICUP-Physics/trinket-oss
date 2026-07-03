var config      = require('config'),
    path        = require('path'),
    _           = require('underscore'),
    lodash      = require('lodash'),
    moment      = require('moment'),
    numeral     = require('numeral'),
    nunjucks    = require('nunjucks'),
    env         = nunjucks.configure(config.app.templates, {watch:config.isDev || config.isTest ? true : false, autoescape: true}),
    StringUtils = require('./stringUtils'),
    cachify     = require('./cachify'),
    translate   = require('./translate'),
    roles       = require('./roles'),
    component   = require('./component'),
    constants   = require('../../config/constants');

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

// "New Trinket" menu items, in display order. Single source of truth so the nav
// dropdown and the single-type shortcut button (base.html) can't drift. Note
// python3 shares the python icon. Intentionally distinct from the client-side
// trinketTypes array in base.html (which also carries pyodide as its own entry).
var NEW_TRINKET_MENU = [
  { lang: 'python',     label: 'Python',      icon: 'lang-sprite-python' },
  { lang: 'python3',    label: 'Python3',     icon: 'lang-sprite-python' },
  { lang: 'pygame',     label: 'Pygame',      icon: 'lang-sprite-pygame' },
  { lang: 'R',          label: 'R',           icon: 'lang-sprite-R' },
  { lang: 'blocks',     label: 'Blocks',      icon: 'lang-sprite-blocks' },
  { lang: 'html',       label: 'HTML',        icon: 'lang-sprite-html' },
  { lang: 'glowscript', label: 'Web VPython', icon: 'lang-sprite-glowscript' },
  { lang: 'java',       label: 'Java',        icon: 'lang-sprite-java' },
  { lang: 'music',      label: 'Music',       icon: 'lang-sprite-music' }
];
// A type shows unless features.trinkets explicitly disables it (matches the old
// inline template conditionals). Pass config.features from the template.
env.addGlobal('enabledNewTrinketTypes', function(features) {
  return NEW_TRINKET_MENU.filter(function(t) {
    return !features || !features.trinkets || features.trinkets[t.lang];
  });
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

    return function(context) {
      // kill the nunjucks cache when in dev mode
      if (config.isDev || config.isTest) {
        env.cache = {};
      }

      // Use the request hostname (_hostname injected by onPreResponse) so that
      // templates work correctly regardless of which domain served the request
      // (custom domain, tagged candidate URL, localhost, etc.).
      var hostname = context._hostname || config.app.url.hostname;
      var renderConfig = config;
      if (hostname !== config.app.url.hostname) {
        var urlOverride = Object.create(config.app.url);
        urlOverride.hostname = hostname;
        var appOverride = Object.create(config.app);
        appOverride.url = urlOverride;
        renderConfig = Object.create(config);
        renderConfig.app = appOverride;
      }

      var host = function(instructor) {
        var url = renderConfig.app.url.protocol + '://';
        if (renderConfig.app.usersubdomains && instructor) {
          url += instructor.slug + '.';
        }
        url += hostname;
        return url;
      };

      _.extend(context, {
        config     : renderConfig,
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
