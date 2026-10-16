var crypto = require('crypto'),
    config = require('config');

// Formats personal data for server logs according to the `ferpa` config section.
// By default (ferpa.logEmails: token) an email address becomes a stable pseudonym
// that keeps the domain: student@cnu.edu -> u-3f9a2c1d@cnu.edu. The same address
// always gives the same token, so one student's log lines can be found
// (scripts/log-email-token.js prints the token) without the address itself being
// logged. ferpa.logEmails: full logs addresses as written.
//
// Nothing here may throw: logging must never break a request.

// EMAIL_RE: an email-shaped run. The local part starts with a letter or digit (so a surrounding quote is not swallowed) and allows letters, combining marks, digits and . _ % + ' - ; it deliberately excludes the rare RFC 5322 characters (! # $ & * / = ? ^ ` { | } ~) because they collide with key=value, URL and query text. Every quantifier is bounded (local part 64, labels 63), so scanning long text stays linear.
var TOKEN_PREFIX = 'trinket-log-email-v1:',
    MIN_SECRET   = 32,
    EMAIL_RE     = /[\p{L}\p{N}][\p{L}\p{M}\p{N}._%+'-]{0,63}@[\p{L}\p{M}\p{N}-]{1,63}(?:\.[\p{L}\p{M}\p{N}-]{1,63}){0,8}\.\p{L}{2,63}/gu;

var randomKey = null,
    warned    = {};

function ferpaConfig() {
  return (config && config.ferpa) || {};
}

function logsFullEmails() {
  var mode = ferpaConfig().logEmails;
  return typeof mode === 'string' && mode.trim().toLowerCase() === 'full';
}

function usable(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET;
}

function warnOnce(kind, message) {
  if (warned[kind]) return;
  warned[kind] = true;
  console.warn(message);
}

// The HMAC key: the dedicated FERPA secret if one is usable, else the session
// cookie password (resolved the way app.js resolves it), else a random key that
// only lives as long as this process.
function tokenKey() {
  var dedicated = [process.env.FERPA_LOG_TOKEN_SECRET, ferpaConfig().logTokenSecret].filter(usable)[0];
  if (dedicated) return dedicated;

  var cookieOptions = config.app && config.app.plugins && config.app.plugins.session &&
                      config.app.plugins.session.cookieOptions;
  var session = [process.env.SESSION_PASSWORD, cookieOptions && cookieOptions.password].filter(usable)[0];
  if (session) {
    warnOnce('session', 'logPrivacy: ferpa.logTokenSecret is not set (or is shorter than 32 characters); ' +
      'email tokens in logs are derived from the session cookie password and will change if it is rotated. ' +
      'Set ferpa.logTokenSecret.');
    return session;
  }

  if (!randomKey) randomKey = crypto.randomBytes(32).toString('hex');
  warnOnce('random', 'logPrivacy: no ferpa.logTokenSecret or session cookie password is available; ' +
    'email tokens in logs are random for this process and cannot be looked up.');
  return randomKey;
}

function domainOf(address) {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

// u-xxxxxxxx@domain for an address, whatever ferpa.logEmails says.
function token(address) {
  var normalized = String(address).trim().toLowerCase();
  var hex = crypto.createHmac('sha256', tokenKey())
    .update(TOKEN_PREFIX + normalized).digest('hex').slice(0, 8);
  return 'u-' + hex + '@' + domainOf(normalized);
}

// Last resort when tokenizing failed: hide every local part, keep the domains.
function masked(value) {
  try {
    if (typeof value !== 'string') return value;
    var hidden = value.replace(EMAIL_RE, function(match) { return 'u-????????@' + domainOf(match); });
    return hidden === value && value.indexOf('@') !== -1 ? 'u-????????@' + domainOf(value.trim()) : hidden;
  } catch (e) {
    return value;
  }
}

function email(value) {
  try {
    if (typeof value !== 'string' || value.indexOf('@') === -1 || logsFullEmails()) return value;
    return token(value);
  } catch (e) {
    return masked(value);
  }
}

function text(value) {
  try {
    if (typeof value !== 'string' || logsFullEmails()) return value;
    return value.replace(EMAIL_RE, function(match) { return token(match); });
  } catch (e) {
    return masked(value);
  }
}

module.exports = {
  email : email,
  text  : text,
  token : token,

  // Tests only: let the once-per-process warnings fire again.
  _resetWarningsForTests : function() { warned = {}; }
};
