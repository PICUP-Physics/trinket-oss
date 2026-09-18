// LTI user provisioning (LTI-SPEC §8.2). Resolve a launch to a trinket User, bypassing the
// auth.js roster-email gate (LTI is its own trusted provisioning path):
//   1. existing LtiUserIdentity(iss, sub)            -> that user
//   2. else launch email matches an account + trustEmail -> link to it
//   3. else                                          -> create a new user
// Always ensures an LtiUserIdentity(iss, sub) -> user link exists afterward.
var crypto          = require('crypto');
var User            = require('../models/user');
var LtiUserIdentity = require('../models/ltiUserIdentity');
var userUtil        = require('./user');

function findByLoginP(email) {
  return new Promise(function(resolve, reject) {
    User.findByLogin(email, function(err, doc) { return err ? reject(err) : resolve(doc); });
  });
}

// LTI email is optional but User.email is required+unique — synthesize a stable, unique
// placeholder from (iss, sub) when the launch carries none.
function placeholderEmail(iss, sub) {
  var h = crypto.createHash('sha1').update(iss + '|' + sub).digest('hex').slice(0, 16);
  return 'lti-' + h + '@lti.local';
}

function provisionUser(claims, platform, opts) {
  var isInstructor = !!(opts && opts.isInstructor);
  var iss   = claims.iss;
  var sub   = claims.sub;
  var email = (claims.email || '').toLowerCase();
  var name  = claims.name || (email ? email.split('@')[0] : ('LTI user ' + String(sub).slice(0, 8)));
  // Standard OIDC claim names. The 1.1 launch synthesizes claims in the same
  // shape from lis_person_name_given/_family, so both versions land here.
  var givenName  = String(claims.given_name  || '').trim();
  var familyName = String(claims.family_name || '').trim();

  return Promise.resolve(LtiUserIdentity.findByIssSub(iss, sub)).then(function(identity) {
    // 1. existing identity
    if (identity) {
      return Promise.resolve(User.findById(identity.userId)).then(function(existing) {
        if (existing) return { user: existing, identity: identity, created: false };
        return { user: null, identity: identity, created: false }; // stale link → recreate below
      });
    }
    return { user: null, identity: null, created: false };
  }).then(function(ctx) {
    if (ctx.user) return ctx;

    // 2. link by email (only when the platform trusts its email assertion)
    var linkP = (email && platform.trustEmail !== false) ? findByLoginP(email) : Promise.resolve(null);
    return linkP.then(function(byEmail) {
      if (byEmail) { ctx.user = byEmail; ctx.created = false; return ctx; }

      // 3. create
      var localPart = email ? email.split('@')[0] : ('lti-' + String(sub).slice(0, 8));
      var newUser = new User({
        email:         email || placeholderEmail(iss, sub),
        fullname:      name,
        givenName:     givenName  || undefined,
        familyName:    familyName || undefined,
        username:      userUtil.generate_username_with_suffix(localPart),
        approved:      true,
        isInstructor:  isInstructor,
        source:        'lti',
        verified:      true
      });
      return Promise.resolve(newUser.save()).then(function() { ctx.user = newUser; ctx.created = true; return ctx; });
    });
  }).then(function (ctx) {
    // Names change — marriage, a corrected record, a preferred name — and the
    // platform is the better authority, so refresh the parts on later launches
    // too. Only when the platform actually sent something: a launch that omits
    // them must not erase what we already knew. Best-effort, and only written
    // when it would actually differ, so a routine relaunch costs no write.
    if (ctx.user && (givenName || familyName)) {
      var changed = (givenName  && ctx.user.givenName  !== givenName)
                 || (familyName && ctx.user.familyName !== familyName);
      if (changed) {
        if (givenName)  { ctx.user.givenName  = givenName; }
        if (familyName) { ctx.user.familyName = familyName; }
        return Promise.resolve(ctx.user.save()).then(function () { return ctx; },
                                                     function () { return ctx; });
      }
    }
    return ctx;
  }).then(function (ctx) {
    // ensure the (iss, sub) -> user link exists / is current
    var linkP;
    if (!ctx.identity) {
      var rec = new LtiUserIdentity({ iss: iss, sub: sub, userId: ctx.user.id, email: email || undefined, name: name });
      linkP = Promise.resolve(rec.save());
    } else if (ctx.identity.userId !== ctx.user.id) {
      ctx.identity.userId = ctx.user.id;
      linkP = Promise.resolve(ctx.identity.save());
    } else {
      linkP = Promise.resolve();
    }
    return linkP.then(function () {
      // Newly-created user already has the correct approved/isInstructor from the constructor —
      // skip the redundant second save.
      if (ctx.created) return ctx.user;
      // For existing users, only write when something actually changed.
      var changed = (ctx.user.approved !== true) || ((!!ctx.user.isInstructor) !== isInstructor);
      if (!changed) return ctx.user;
      ctx.user.approved = true;
      ctx.user.isInstructor = isInstructor;
      return Promise.resolve(ctx.user.save()).then(function () { return ctx.user; });
    });
  });
}

module.exports = { provisionUser: provisionUser };
