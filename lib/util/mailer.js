var nodemailer = require('nodemailer'),
    config     = require('config'),
    _          = require('underscore');

// Check if email is properly configured
function isConfigured() {
  var mailConfig = config.app.mail;
  return mailConfig && mailConfig.from && mailConfig.host;
}

// Create reusable transporter
function createTransport() {
  var mailConfig = config.app.mail;

  return nodemailer.createTransport({
    host: mailConfig.host,
    port: mailConfig.port || 587,
    secure: mailConfig.secure || false,
    auth: {
      user: mailConfig.user,
      pass: mailConfig.pass
    }
  });
}

// Collapse to a single line and cap the length, so a multi-line SMTP response
// can never split a log entry (monitoring matches one MAIL_SEND_FAILED line
// per failure). Control characters (ESC, NUL, ...) are replaced first: \s does
// not cover them, and they would otherwise reach the log verbatim.
function oneLine(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// One stable, greppable line per failed send. Deployments may alert on the
// MAIL_SEND_FAILED marker from their logs, so treat the format as a contract:
// keep the marker and the field order (type, to, code, responseCode, message)
// unchanged, and keep it to one line per failure.
//
// Total: never throws, even for an error whose toString() throws or that has no
// prototype. The line is built inside the try and written once at its end, so
// the fallback replaces the normal line and never adds a second one.
function logFailure(err, ctx) {
  var line;

  try {
    ctx = ctx || {};
    var detail = err && err.message ? err.message : err;

    line =
      'MAIL_SEND_FAILED' +
      ' type='         + (oneLine(ctx.type, 40) || 'unknown') +
      ' to='           + oneLine(ctx.to, 120) +
      ' code='         + oneLine(err && err.code, 40) +
      ' responseCode=' + oneLine(err && err.responseCode, 10) +
      ' message="'     + oneLine(detail, 300).replace(/"/g, "'") + '"';
  } catch (e) {
    line = 'MAIL_SEND_FAILED type=unknown to= code= responseCode= message="(unloggable error)"';
  }

  console.error(line);
}

module.exports = {
  isConfigured: isConfigured,

  logFailure: logFailure,

  // Fire-and-forget variant of send(): never rejects. For callers that answer
  // the user first and send afterwards, where a failed send has nobody to
  // report to. Goes through module.exports.send so tests can spy on send().
  sendSafe: async function(to, subject, options) {
    try {
      return await module.exports.send(to, subject, options);
    } catch (err) {
      logFailure(err, { to: to, type: options && options.type });
      return { failed: true, error: err };
    }
  },

  send: async function(to, subject, options) {
    if (!isConfigured()) {
      console.log('Email not configured, skipping send to:', to);
      return { skipped: true, reason: 'Email not configured' };
    }

    options = _.extend({
      from: config.app.mail.from,
      to: to,
      subject: subject
    }, options || {});

    var transport = createTransport();

    return new Promise(function(resolve, reject) {
      transport.sendMail(options, function(err, response) {
        if (err) {
          reject(err);
        } else {
          resolve(response);
        }
      });
    });
  }
};
