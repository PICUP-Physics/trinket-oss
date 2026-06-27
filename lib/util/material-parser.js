var config = require('config'),
    _ = require('underscore');

var trinket_hosts = [config.app.url.hostname].concat(
  (config.app.url.knownHosts || []).filter(function(h) { return h !== config.app.url.hostname; })
);

var trinket_types = [
  'python',
  'pyodide',
  'html',
  'music',
  'glowscript',
  'blocks',
  'python3',
  'java',
  'glowscript-blocks',
  'R',
  'pygame'
];

var trinketRegex = new RegExp(
    '(?:https?\\:)?\\/\\/(?:www\\.)?'
  + '(?:' + trinket_hosts.join('|') + ')'
  + '(?:\\/embed)?\\/(?:' + trinket_types.join('|') + ')\\/(\\w+)', 'ig'
);

// Rewrites absolute embed src URLs from any known host to relative paths so
// stored content works regardless of which hostname serves the page.
var _hostPattern = trinket_hosts.map(function(h) {
  return h.replace(/\./g, '\\.').replace(/\-/g, '\\-');
}).join('|');
var _embedSrcRegex = new RegExp(
  '(src=[\'"])(?:https?:)?//(?:www\\.)?(?:' + _hostPattern + ')(/embed/[^\'"]*)',
  'gi'
);

function normalizeEmbedUrls(html, hostname) {
  if (!html) { return html; }
  var prefix = hostname ? '//' + hostname : '';
  return html.replace(_embedSrcRegex, '$1' + prefix + '$2');
}


function MaterialParser(a) {
  this.trinketMatches = {};
}

MaterialParser.prototype.findAndCopy = function findAndCopy(shortCode, user) {
  var that = this;
  if (that.trinketMatches[shortCode]) {
    return Promise.resolve(that.trinketMatches[shortCode]);
  } else {
    return Trinket.findById(shortCode)
      .then(function(trinket) {
        if (that.trinketMatches[shortCode]) {
          return { shortCode: that.trinketMatches[shortCode] };
        } else {
          var trinketCopy = trinket.copy(user);
          return trinketCopy.save();
        }
      })
      .then(function(trinketCopy) {
        that.trinketMatches[shortCode] = trinketCopy.shortCode;
        return trinketCopy.shortCode;
      });
  }
}

MaterialParser.prototype.parse = function parse(src, user) {
  var that = this;

  if (src === undefined || !src.length) {
    return Promise.resolve(src);
  }

  src.replace(trinketRegex, function(match, shortCode) {
    !(shortCode in that.trinketMatches) && (that.trinketMatches[shortCode] = null);
  });

  var shortCodes = Object.keys(that.trinketMatches).filter(function(shortCode) {
    return that.trinketMatches[shortCode] == null;
  });

  return shortCodes.reduce(function(p, shortCode) {
    return p.then(function() {
      return that.findAndCopy(shortCode, user);
    });
  }, Promise.resolve())
    .then(function() {
      var srcCopy = src.replace(trinketRegex, function(match, shortCode) {
        return match.replace(shortCode, that.trinketMatches[shortCode]);
      });
      return srcCopy;
    });
}

module.exports = MaterialParser;
module.exports.MaterialParser = MaterialParser;
module.exports.normalizeEmbedUrls = normalizeEmbedUrls;
