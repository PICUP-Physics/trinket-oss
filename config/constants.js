var config = require('config');

var constants = {
  trinketLangs : [
      'python'
    , 'pyodide'
    , 'python3'
    , 'console'
    , 'music'
    , 'html'
    , 'blocks'
    , 'glowscript'
    , 'java'
    , 'glowscript-blocks'
    , 'R'
    , 'pygame'
  ]
};

module.exports = config.constants = constants;
