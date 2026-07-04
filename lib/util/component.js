module.exports = function(name, path) {
  var config = require('config')
    , host   = config.aws.buckets.vendorassets.host
    , hasCloudConfig = host && host.startsWith('https://') && !host.includes('example.com')
    , src;

  if (/^http/.test(config.app.components[name])) {
    src = [config.app.components[name], path].join('/');
  }
  else if (hasCloudConfig) {
    src = [host, name, config.app.components[name], path].join('/');
  }
  else {
    // Fall back to local components directory
    src = '/components/' + path;
  }

  if (/\.js$/.test(src)) {
    return "<script src='" + src + "' charset='utf-8'></script>";
  }
  else if (/\.css$/.test(src)) {
    return "<link rel='stylesheet' type='text/css' href='" + src + "' crossorigin='anonymous'>";
  }
}
