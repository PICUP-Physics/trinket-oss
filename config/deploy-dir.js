'use strict';

// Per-deploy customization folder (opt-in via TRINKET_DEPLOY).
//
// When TRINKET_DEPLOY=<name> is set, deploys/<name>/ overlays the stock app:
//   deploys/<name>/config/  extra node-config directory (its local*.yaml /
//                           production*.yaml win over the repo's config/)
//   deploys/<name>/views/   nunjucks search path ahead of lib/views — a file
//                           here shadows the stock template of the same name
//   deploys/<name>/public/  static assets ahead of public/ — same-name shadowing
//
// deploys/ is gitignored: each folder is typically a clone of a private
// per-deploy repo (branding, overlays, custom pages) that never touches the
// public history. Without TRINKET_DEPLOY this module is a no-op and the app
// behaves exactly as stock.
//
// MUST be required before the first require('config') anywhere in the
// process: node-config reads NODE_CONFIG_DIR once, at first load.

var path = require('path');
var fs   = require('fs');

var deployDir = null;
var name = process.env.TRINKET_DEPLOY;

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
    var baseDir = process.env.NODE_CONFIG_DIR || path.resolve(__dirname);
    process.env.NODE_CONFIG_DIR = baseDir + path.delimiter + configDir;
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
