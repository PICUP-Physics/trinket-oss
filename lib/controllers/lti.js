// LTI 1.3 Tool endpoints. v1: launch + SSO (LTI-SPEC.md). JWKS (milestone 1) + OIDC login init
// (milestone 2); /lti/launch follows.
var crypto      = require('crypto');
var querystring = require('querystring');
var Boom        = require('@hapi/boom');
var config      = require('config');
var ltiKeys     = require('../util/ltiKeys');
var ltiState    = require('../util/ltiState');
var ltiVerify   = require('../util/ltiVerify');
var ltiNonceStore = require('../util/ltiNonceStore');
var ltiProvision  = require('../util/ltiProvision');
var ltiTarget     = require('../util/ltiTarget');
var ltiRoles      = require('../util/ltiRoles');
var ltiInstructorAuthority = require('../util/ltiInstructorAuthority');
var LtiPlatform = require('../models/ltiPlatform');

var LTI = 'https://purl.imsglobal.org/spec/lti/claim/';
var NONCE_TTL_SECONDS = 600;  // matches the 5-min state TTL with headroom

module.exports = {

  // GET /lti/jwks — the Tool's public keys, so platforms can verify trinket-signed JWTs
  // (Deep Linking / AGS later). Body must be exactly { keys: [...] }, so use reply() (raw JSON)
  // rather than request.success() (which would add a `flash` key).
  jwks: function(request, reply) {
    var jwk = ltiKeys.getPublicJwk();
    if (!jwk) {
      // Not configured yet — serve an empty (but valid) key set, uncached.
      return reply({ keys: [] }).type('application/json').header('Cache-Control', 'no-store');
    }
    return reply({ keys: [jwk] })
      .type('application/json')
      .header('Cache-Control', 'public, max-age=3600');
  },

  // GET|POST /lti/login — OIDC third-party-initiated login (LTI-SPEC §5, §7.1). The platform
  // sends iss/login_hint/target_link_uri (+ optional client_id, lti_message_hint). We look up
  // the platform, mint a nonce + a stateless signed `state`, and redirect to the platform's
  // authorization endpoint. Params may arrive via query (GET) or form body (POST).
  loginInit: function(request, reply) {
    var p = Object.assign({}, request.query, request.payload);
    var iss           = p.iss;
    var loginHint     = p.login_hint;
    var targetLinkUri = p.target_link_uri;
    var clientId      = p.client_id;        // optional; disambiguates multiple regs per issuer
    var messageHint   = p.lti_message_hint; // optional; opaque, echoed back to the platform

    if (!iss || !loginHint || !targetLinkUri) {
      return reply(Boom.badRequest('Missing required LTI login parameters (iss, login_hint, target_link_uri).'));
    }

    return LtiPlatform.findByIssuer(iss, clientId, function(err, platform) {
      if (err) return reply(Boom.badImplementation(err.message));
      if (!platform) return reply(Boom.badRequest('Unknown LTI issuer: ' + iss));

      var nonce = crypto.randomBytes(32).toString('base64url');
      var state;
      try {
        state = ltiState.sign({ nonce: nonce, iss: iss, clientId: platform.clientId, target: targetLinkUri });
      } catch (e) {
        return reply(Boom.badImplementation('LTI signing key not configured'));
      }

      var params = {
        scope         : 'openid',
        response_type : 'id_token',
        response_mode : 'form_post',
        prompt        : 'none',
        client_id     : platform.clientId,
        redirect_uri  : config.url + '/lti/launch',
        login_hint    : loginHint,
        state         : state,
        nonce         : nonce
      };
      if (messageHint) params.lti_message_hint = messageHint;

      var sep = platform.authLoginUrl.indexOf('?') >= 0 ? '&' : '?';
      return reply().redirect(platform.authLoginUrl + sep + querystring.stringify(params));
    });
  },

  // POST /lti/launch — the platform form-POSTs { state, id_token } here. Validate everything
  // (LTI-SPEC §7.2) before reading identity. v1/milestone 3 stops after validation; provisioning,
  // session, and target resolution land in later milestones.
  launch: function(request, reply) {
    var body       = request.payload || {};
    var stateToken = body.state;
    var idToken    = body.id_token;
    if (!stateToken || !idToken) {
      return reply(Boom.badRequest('Missing state or id_token.'));
    }

    // 1. state: our own signed token (CSRF + nonce binding), unstored.
    var state;
    try { state = ltiState.verify(stateToken); }
    catch (e) { return reply(Boom.badRequest('Invalid or expired state.')); }

    return LtiPlatform.findByIssuer(state.iss, state.cid, function(err, platform) {
      if (err) return reply(Boom.badImplementation(err.message));
      if (!platform) return reply(Boom.badRequest('Unknown LTI issuer: ' + state.iss));

      // 2. id_token: verify signature against the platform JWKS + iss/aud/exp (jose seam).
      ltiVerify.verifyLaunchToken(idToken, platform)
        .then(function(claims) {
          // 3. nonce binds the id_token to our login request.
          if (!claims.nonce || claims.nonce !== state.nonce) {
            throw Boom.badRequest('nonce mismatch.');
          }
          // 4. deployment must be one we registered for this platform.
          var deploymentId = claims[LTI + 'deployment_id'];
          if (!deploymentId || !platform.knowsDeployment(deploymentId)) {
            throw Boom.badRequest('Unknown deployment_id.');
          }
          // 5. message type + version.
          if (claims[LTI + 'message_type'] !== 'LtiResourceLinkRequest') {
            throw Boom.badRequest('Unsupported message_type.');
          }
          if (claims[LTI + 'version'] !== '1.3.0') {
            throw Boom.badRequest('Unsupported LTI version.');
          }
          // 6. replay protection (only now, after the token is proven valid).
          return ltiNonceStore.checkAndRecord(claims.nonce, NONCE_TTL_SECONDS).then(function(fresh) {
            if (!fresh) throw Boom.badRequest('Replayed launch (nonce already used).');

            // 7. provision the user (LTI-SPEC §8), resolve the target course, enroll with the
            // authority-intersected role, then establish the trinket session (mirroring POST
            // /api/auth/session: yar.reset + _logIn, callback not awaited, same as auth.js)
            // and land on the course.
            var email      = (claims.email || '').toLowerCase();
            var lmsTeacher = ltiRoles.isTeacherRole(claims[LTI + 'roles']);
            return ltiInstructorAuthority.resolveInstructor({ email: email, lmsTeacher: lmsTeacher })
              .catch(function () { return false; })   // fail closed
              .then(function (isInstructor) {
                var courseRole = (lmsTeacher && isInstructor) ? 'course-admin' : 'course-student';
                return ltiProvision.provisionUser(claims, platform, { isInstructor: isInstructor }).then(function (user) {
                  return ltiTarget.resolveTarget(claims, platform).then(function (target) {
                    var redirectPath = '/welcome';
                    var enrollP = Promise.resolve();
                    if (target.course) {
                      redirectPath = '/' + target.course.ownerSlug + '/courses/' + target.course.slug;
                      var isOwner = target.course.ownerSlug === user.username;
                      if (!isOwner) {
                        // addUser sets the role for a fresh member and returns { success }.
                        // For an existing member it returns { alreadyListed: true } and leaves
                        // the role unchanged, so we only call updateRole when the stored role
                        // actually differs from the computed one (avoids needless writes on
                        // every re-launch — CLAUDE.md hot-path rule).
                        enrollP = Promise.resolve(target.course.addUser(user, [courseRole]))
                          .then(function (res) {
                            if (res && res.alreadyListed) {
                              var ctxRoles = user.getByContext('course:' + target.course.id);
                              var currentRole = ctxRoles && ctxRoles.roles && ctxRoles.roles[0];
                              if (currentRole !== courseRole) {
                                return target.course.updateRole(user, courseRole);
                              }
                              return Promise.resolve();
                            }
                            // Fresh enrolment: addUser already wrote the role.
                            return Promise.resolve();
                          });
                      }
                    }
                    return enrollP.then(function () {
                      request.yar.reset();
                      request.yar._logIn(user, function () {});
                      request.yar.flash('requested', user.username);
                      return reply().redirect(redirectPath);
                    });
                  });
                });
              });
          });
        })
        .catch(function(e) {
          if (e && e.isBoom) return reply(e);
          return reply(Boom.unauthorized('Launch verification failed: ' + (e && e.message)));
        });
    });
  }

};
