var config = require('config');

var VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify';

module.exports = {
  verify : function(g_recaptcha_response, cb) {
    // Skip recaptcha verification in test mode or if not configured
    if (config.isTest || !config.app.recaptcha || !config.app.recaptcha.secretkey) {
      return cb({ success : true });
    }

    var form = new URLSearchParams({
        secret   : config.app.recaptcha.secretkey
      , response : g_recaptcha_response == null ? '' : String(g_recaptcha_response)
    });

    // Any failure, including the network call itself, fails closed.
    fetch(VERIFY_URL, {
        method  : 'POST'
      , headers : { 'content-type' : 'application/x-www-form-urlencoded' }
      , body    : form.toString()
    })
    .then(function(response) {
      if (response.status === 200) return response.json();
      if (response.body) response.body.cancel().catch(function() {});
      return { status : false };
    })
    .then(function(result) {
      cb(result);
    }, function() {
      cb({ status : false });
    });
  }
};
