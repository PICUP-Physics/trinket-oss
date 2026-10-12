// The message Add Students shows once a roster has been submitted.
//
// Rows for existing accounts are enrolled at once. The rest become pending
// invitations, and what happens to those depends on the deploy: with a mailer
// configured each one is emailed a join link; without one nobody is contacted
// and the student joins the first time they sign in with that address. The
// message has to say which, or an instructor on a no-mail deploy waits for
// emails that are never sent (MIAuthors #12). `opts.inviteEmail` comes from
// the server's own mailer.isConfigured(), the same check that gates the send;
// when it is missing, assume no email rather than promise one.
//
// UMD-lite: window global for the Angular app, module.exports for the tests.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else { root.trinketRosterMessage = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function report(totals, opts) {
    var inviteEmail = !!(opts && opts.inviteEmail);
    var parts = [];
    if (totals.enrolled) { parts.push(totals.enrolled + " enrolled"); }
    if (totals.invited)  { parts.push(totals.invited + (inviteEmail ? " invited" : " added")); }

    var message, className;
    if (parts.length) {
      message   = parts.join(", ") + ".";
      className = 'success';
      if (totals.invited) {
        message += inviteEmail
          ? " Each invited student has been emailed a link to join; they can also join by signing in with that email address."
          : " Trinket doesn't email students: give them this site's address. They join the course the first time they sign in with that email address.";
      }
    }
    else {
      message   = "No new students added.";
      className = 'warning';
    }
    if (totals.invalid) { message += " " + totals.invalid + " invalid email(s) skipped."; }
    if (totals.held) {
      message += " " + totals.held + " line(s) had no email address and were left in the box.";
      if (className === 'success') { className = 'warning'; }
    }
    if (totals.duplicates) { message += " " + totals.duplicates + " duplicate line(s) ignored."; }
    if (totals.failed)  { message += " " + totals.failed + " batch(es) failed — their lines were left in the box; please retry."; className = 'alert'; }

    return { message : message, className : className };
  }

  return { report : report };
}));
