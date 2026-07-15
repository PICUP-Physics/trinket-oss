(function(config) {
  window.trinketConfig = {
    get : function(key) {
      return config[key];
    },
    planName : function(plan) {
      var plans = this.get('plans');
      return _.find(plans, plan)[plan];
    },
    logo : function() {
      // Resolve the embed "Powered by" badge from config.app.logo (exposed via
      // embed/base.html), falling back to the bundled asset so the badge still
      // renders on any instance that leaves logo unset.
      var logo = this.get('logo') || '/img/trinket-logo.png';
      // Absolute and protocol-relative URLs pass through untouched —
      // prefix() would mangle them into a local path.
      if (/^(https?:)?\/\//.test(logo)) {
        return logo;
      }
      return this.prefix(logo);
    },
    prefix : function(path, type) {
      if (path.charAt(0) !== '/') {
        path = '/' + path;
      }

      if (config.testing) {
        return path;
      }

      if (typeof type === 'undefined') {
        var pathType = path.match(/\/(\w+)\//);
        if (pathType) {
          type = pathType[1];
        }
      }

      return (type && config.prefixes[type])
        ? '/' + config.prefixes[type] + path
        // use current date if no prefix config can be found
        : '/' + config.cachePrefix + Date.now() + path;
    },
    component : function(name, path) {
      return [config.vendorHost, name, config.components[name], path].join('/');
    },
    getUrl : function(path) {
      if (path.charAt(0) !== '/') {
        path = '/' + path;
      }
      return config.protocol + '://' + config.apphostname + path;
    },
    getClassUrl : function(userSlug, courseSlug) {
      return '/u/' + userSlug + '/classes/' + courseSlug;
    },
    getPublishedTrinketUrl : function(userSlug, trinketSlug) {
      // Derive the host from the page the user is actually on (like embed share
      // URLs via qualifyUrl) rather than config.apphostname, so a misconfigured
      // app.url.hostname can't point the published link off this instance (#2).
      var origin = (typeof window !== 'undefined' && window.location && window.location.host)
        ? window.location.protocol + '//' + window.location.host
        : config.protocol + '://' + config.apphostname;
      return origin + '/u/' + userSlug + '/sites/' + trinketSlug;
    }
  };
})(window.trinket.config);
