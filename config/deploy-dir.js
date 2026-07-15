'use strict';

// Per-deploy customization folder (opt-in via TRINKET_DEPLOY).
//
// When TRINKET_DEPLOY=<name> is set, deploys/<name>/ overlays the stock app:
//   deploys/<name>/config/  yaml overlays deep-merged onto the loaded config
//                           (default.yaml, {env}.yaml, local.yaml, local-{env}.yaml,
//                           in that order — same names node-config uses, so an
//                           existing local-production.yaml moves over unchanged)
//   deploys/<name>/views/   nunjucks search path ahead of lib/views — a file
//                           here shadows the stock template of the same name
//   deploys/<name>/public/  static assets ahead of public/ — same-name shadowing
//
// deploys/ is gitignored: each folder is typically a clone of a private
// per-deploy repo (branding, overlays, custom pages) that never touches the
// public history. Without TRINKET_DEPLOY this module is a no-op and the app
// behaves exactly as stock.
//
// Implementation note: our node-config (0.4.x) predates multi-directory
// NODE_CONFIG_DIR, so we deep-merge into its mutable singleton instead. That
// means deploy yaml wins over EVERYTHING, including the NODE_CONFIG env var —
// keep host-specific values (url.hostname etc.) out of deploy config files.
// Require this before other app modules so every require('config') sees the
// merged result.

var path = require('path');
var fs   = require('fs');

var deployDir = null;
var name = process.env.TRINKET_DEPLOY;

function deepMerge(target, source) {
  Object.keys(source).forEach(function(key) {
    var s = source[key];
    var t = target[key];
    if (s && typeof s === 'object' && !Array.isArray(s) &&
        t && typeof t === 'object' && !Array.isArray(t)) {
      deepMerge(t, s);
    } else {
      target[key] = s;
    }
  });
  return target;
}

if (name) {
  if (!/^[\w-]+$/.test(name)) {
    throw new Error("TRINKET_DEPLOY '" + name + "' is not a plain folder name");
  }
  deployDir = path.resolve(__dirname, '..', 'deploys', name);
  if (!fs.existsSync(deployDir)) {
    throw new Error("TRINKET_DEPLOY '" + name + "' set but " + deployDir + " does not exist");
  }

  var configDir = path.join(deployDir, 'config');
  if (fs.existsSync(configDir)) {
    var config = require('config');
    var yaml   = require('js-yaml');
    var env    = process.env.NODE_ENV || 'development';
    ['default.yaml', env + '.yaml', 'local.yaml', 'local-' + env + '.yaml']
      .forEach(function(file) {
        var p = path.join(configDir, file);
        if (!fs.existsSync(p)) { return; }
        var doc = yaml.safeLoad(fs.readFileSync(p, 'utf8'));
        if (doc && typeof doc === 'object') {
          deepMerge(config, doc);
          // global logger does not exist yet this early in startup
          console.log('[deploy-dir] merged ' + path.join('deploys', name, 'config', file));
        }
      });
  }
}

module.exports = {
  dir : deployDir,

  // Absolute path of <sub> inside the deploy folder, or null if absent.
  sub : function(sub) {
    if (!deployDir) { return null; }
    var p = path.join(deployDir, sub);
    return fs.existsSync(p) ? p : null;
  }
};
