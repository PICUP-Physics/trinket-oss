// LTI 1.3 Tool endpoints. v1: launch + SSO (docs/lti/LTI-SPEC.md). JWKS (milestone 1) + OIDC login init
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
var ltiRegistration = require('../util/ltiRegistration');
var ltiDeepLinking  = require('../util/ltiDeepLinking');
var lti11DeepLinking = require('../util/lti11DeepLinking');
var LtiPlatform = require('../models/ltiPlatform');
var LtiConsumer = require('../models/ltiConsumer');
var lti11Verify = require('../util/lti11Verify');
var publicHostname = require('../util/publicHostname');
var LtiRegistrationToken = require('../models/ltiRegistrationToken');
var Course   = require('../models/course');
var Lesson   = require('../models/lesson');
var Material = require('../models/material');
var Trinket  = require('../models/trinket');
var ltiReview = require('../util/ltiReview');
var submissionView = require('../util/submissionView');
var ltiNotifySubmission = require('../util/ltiNotifySubmission');
var LtiOutcome = require('../models/ltiOutcome');

var LTI = 'https://purl.imsglobal.org/spec/lti/claim/';

// ---------------------------------------------------------------------------
// LTI 1.1 launch (SPIKE — see feat/lti11-launch). Legacy platforms (WileyPLUS-
// hosted Canvas, Developer-Key-gated institutional Canvas) let instructors
// self-install only 1.1 key/secret tools, so this accepts a basic-lti-launch
// on the SAME /lti/launch URL and funnels into the same provisioning,
// enrollment, and landing logic as 1.3. Deliberately NO grade passback: 1.1
// Basic Outcomes carries only a numeric score, which cannot express trinket's
// needs-grading model.
// ---------------------------------------------------------------------------
function handleLti11Launch(request, reply) {
  var body = request.payload || {};
  var key  = body.oauth_consumer_key;
  if (!key) return reply(Boom.badRequest('Missing oauth_consumer_key.'));

  return new Promise(function (resolve) {
    LtiConsumer.findByKey(key, function (err, c) { resolve(err ? null : c); });
  }).then(function (consumer) {
    if (!consumer || consumer.disabled) {
      return reply(Boom.unauthorized('Unknown consumer key.'));
    }

    // The platform signed the URL it POSTed to — the PUBLIC one. Behind a CDN
    // front door request.info.hostname is the backend's own host, so resolve
    // the browser-facing hostname the same way the template layer does.
    var launchUrl = lti11Verify.launchUrlFromRequest(request, config.app.url, publicHostname.resolve);

    // OAuth 1.0a folds query-string parameters into the signature base, and
    // lti11Verify documents that the CALLER merges them ("body + query merged by the
    // caller"). It never did — so any launch URL carrying a query string failed to
    // verify. Merge them; body wins a collision, since the POST is the message.
    var signedParams = Object.assign({}, request.query || {}, body);
    var verdict = lti11Verify.verify({
      method: 'POST', url: launchUrl, params: signedParams, secret: consumer.secret
    });
    if (!verdict.ok) {
      log.info('[lti11] launch rejected', { key: key, reason: verdict.reason, url: launchUrl });
      return reply(Boom.unauthorized('Invalid launch signature (' + verdict.reason + ').'));
    }

    // Replay protection: one nonce, once, per consumer.
    return ltiNonceStore.checkAndRecord('lti11:' + key + ':' + body.oauth_nonce, 600)
      .catch(function () { return true; })   // store trouble must not open a replay hole silently
      .then(function (fresh) {
        if (!fresh) return reply(Boom.unauthorized('Replayed launch.'));

        // Deep linking in 1.1 is the Content-Item Message. Same signed POST, different
        // message type — and the platform tells us where to POST the selection back.
        var isContentItem = body.lti_message_type === 'ContentItemSelectionRequest';
        log.info('[lti11] launch message', {
          lti_message_type: body.lti_message_type,
          content_item_return_url_present: !!body.content_item_return_url,
          launch_presentation_return_url_present: !!body.launch_presentation_return_url,
          selection_directive: body.selection_directive || null,
          accept_media_types: body.accept_media_types || null
        });
        if (body.lti_message_type !== 'basic-lti-launch-request' && !isContentItem) {
          return reply(Boom.badRequest('Unsupported lti_message_type.'));
        }
        if (isContentItem && !body.content_item_return_url) {
          return reply(Boom.badRequest('Missing content_item_return_url.'));
        }
        if (!body.user_id) return reply(Boom.badRequest('Missing user_id.'));

        // Shape the 1.1 POST into the claim structure the 1.3 tail consumes,
        // so provisioning / roles / target / enrollment are shared, not
        // reimplemented. iss is synthesized per consumer key: identities are
        // durable per (key, user_id), matching 1.1's trust model.
        var iss = 'lti11:' + key;
        var roles = String(body.roles || '').split(',').map(function (r) { return r.trim(); }).filter(Boolean);
        var custom = {};
        Object.keys(body).forEach(function (k) {
          if (k.indexOf('custom_') === 0) custom[k.slice(7)] = body[k];
        });
        // Targeting from the launch URL: ...?assignment=<materialId>. A custom field on
        // the tool config is TOOL-WIDE, so every assignment using that tool would point
        // at the same material; the launch URL is stored per placement, so it is the
        // more specific statement and wins. (Deep linking removes the need to hand-write
        // these at all, but the URL form works on any platform, today.)
        var q = request.query || {};
        ['course', 'assignment', 'topic'].forEach(function (k) {
          var val = q[k];
          if (!val) return;
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(val))) return;   // ignore junk, don't 400 a launch
          custom['trinket_' + k] = String(val);
        });
        var claims = {
          iss: iss,
          sub: String(body.user_id),
          email: body.lis_person_contact_email_primary || '',
          name: body.lis_person_name_full ||
                [body.lis_person_name_given, body.lis_person_name_family].filter(Boolean).join(' '),
        };
        claims[LTI + 'roles'] = roles;
        claims[LTI + 'custom'] = custom;
        claims[LTI + 'resource_link'] = { id: String(body.resource_link_id || '') };
        claims[LTI + 'deployment_id'] = 'lti11';
        var platformShim = { id: iss, issuer: iss, name: consumer.name || ('LTI 1.1: ' + key) };

        var email = (claims.email || '').toLowerCase();
        var lmsTeacher = ltiRoles.isTeacherRole(claims[LTI + 'roles']);
        return ltiInstructorAuthority.resolveInstructor({ email: email, lmsTeacher: lmsTeacher })
          .catch(function () { return false; })   // fail closed
          .then(function (isInstructor) {
            var courseRole = (lmsTeacher && isInstructor) ? 'course-admin' : 'course-student';
            return ltiProvision.provisionUser(claims, platformShim, { isInstructor: isInstructor }).then(function (user) {
              // Content-Item (deep linking): establish the session and hand off to the SAME
              // picker 1.3 uses. Only the entry point and the response format differ per
              // version; the instructor's choice is identical, so the UI is shared.
              if (isContentItem) {
                request.yar.reset();
                request.yar._logIn(user, function () {});
                request.yar.set('ltiDeepLink', {
                  version: '1.1',
                  // Store the KEY, not the secret — the secret is re-read from the consumer
                  // record at selection time rather than parked in a session.
                  consumerKey: key,
                  deep_link_return_url: body.content_item_return_url,
                  data: body.data,
                  acceptMultiple: String(body.accept_multiple) === 'true',
                  // 1.1 gives no reliable signal for WHICH placement launched us — Canvas's
                  // resource_selection and assignment_selection look alike on the wire — so
                  // offer both and let the instructor choose, as we do for Moodle/D2L in 1.3.
                  mode: 'both',
                  assignmentAllowed: true
                });
                return reply().redirect('/lti/deep-link');
              }
              // Basic Outcomes coordinates. This is the ONLY channel back to a 1.1
              // platform — there is no AGS here — so without these two values we can
              // never tell the LMS a submission exists. Captured on every launch
              // (platforms reissue sourcedids) and strictly best-effort: gradebook
              // bookkeeping must never fail a student's launch.
              if (body.lis_result_sourcedid && body.lis_outcome_service_url) {
                Promise.resolve(LtiOutcome.record({
                  platformId    : iss,
                  resourceLinkId: String(body.resource_link_id || ''),
                  userId        : String(user.id),
                  sourcedId     : String(body.lis_result_sourcedid),
                  serviceUrl    : String(body.lis_outcome_service_url)
                })).catch(function (e) {
                  log.error('[lti11] outcome capture failed (best-effort):', e && e.message);
                });
              }
              // Review launch: the LMS relaunched us at the URL it stored as a
              // basic_lti_launch submission, so the id rides in the request rather than a
              // claim — as ?submission= on this launch path, or in the path itself for
              // submissions Canvas stored before #14. No resource_link travels with a
              // review launch, so resolveTarget cannot help here.
              var reviewId = ltiReview.targetFromRequest(request);
              if (reviewId) {
                return Promise.resolve(Trinket.findById(reviewId)).then(function (sub) {
                  if (!sub) return reply(Boom.notFound('Submission not found.'));
                  if (!ltiReview.canReview(user, sub)) {
                    return reply(Boom.forbidden('Not authorized to review this submission.'));
                  }
                  request.yar.reset();
                  request.yar._logIn(user, function () {});
                  return reply().redirect(ltiReview.redirectPath(sub));
                });
              }
              return ltiTarget.resolveTarget(claims, platformShim).then(function (target) {
                var redirectPath = '/welcome';
                var enrollP = Promise.resolve();
                if (target.course) {
                  redirectPath = '/' + target.course.ownerSlug + '/courses/' + target.course.slug;
                  var isOwner = target.course.ownerSlug === user.username;
                  if (!isOwner) {
                    enrollP = Promise.resolve(target.course.addUser(user, [courseRole]))
                      .then(function (res) {
                        if (res && res.alreadyListed) {
                          var ctxRoles = user.getByContext('course:' + target.course.id);
                          var currentRole = ctxRoles && ctxRoles.roles && ctxRoles.roles[0];
                          if (currentRole !== courseRole) {
                            return target.course.updateRole(user, courseRole);
                          }
                        }
                        return Promise.resolve();
                      });
                  }
                  if (target.assignment && target.assignment.lessonSlug && target.assignment.materialSlug) {
                    redirectPath += '#/' + target.assignment.lessonSlug + '/' + target.assignment.materialSlug;
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
  }).catch(function (e) {
    log.error('[lti11] launch failed:', e && e.message);
    return reply(Boom.badImplementation('LTI 1.1 launch failed.'));
  });
}

var DL  = 'https://purl.imsglobal.org/spec/lti-dl/claim/';
var NONCE_TTL_SECONDS = 600;  // matches the 5-min state TTL with headroom

module.exports = {

  // GET /lti/jwks — the Tool's public keys, so platforms can verify trinket-signed JWTs
  // (Deep Linking / AGS later). Body must be exactly { keys: [...] }, so use reply() (raw JSON)
  // rather than request.success() (which would add a `flash` key).
  // GET /lti11/config.xml[?course=<id>] — Canvas "+ App → By URL" fetches this
  // cartridge and pre-fills launch URL, title, PRIVACY LEVEL, and the
  // trinket_course custom field, so an instructor pastes only three things
  // (config URL, key, secret) and cannot misconfigure the rest. Contains no
  // secrets — safe to serve unauthenticated, like jwks.
  // Dedicated 1.1 launch endpoint (see configXml11 for why it is distinct from
  // /lti/launch). Same handler; the shared /lti/launch dispatch is kept for
  // tolerance / already-installed tools.
  launch11: function(request, reply) {
    return handleLti11Launch(request, reply);
  },

  // GET /lti/review-panel/{trinketId} — the instructor's feedback UI as a page of its
  // own, so it can be rendered inside an LMS grader pane. This is where a review
  // launch lands. The directive it hosts is the same one the course dashboard uses,
  // unchanged; only the chrome differs.
  //
  // Authorization happens HERE, not in the client: reaching this page is the check.
  reviewPanel: function(request, reply) {
    return Promise.resolve(Trinket.findById(request.params.trinketId)).then(function (sub) {
      if (!sub) return reply(Boom.notFound('Submission not found.'));
      if (!ltiReview.canReview(request.user, sub)) {
        return reply(Boom.forbidden('Not authorized to review this submission.'));
      }
      // The panel needs the LESSON too: the client builds a real Restangular element
      // from course -> lesson -> material so `material.customPOST(..., 'feedback')`
      // resolves to POST /api/courses/{c}/lessons/{l}/materials/{m}/feedback. Faking
      // the parentResource chain was enough to READ submissions and not enough to
      // SEND feedback — customPOST is a Restangular method a plain object lacks.
      function lessonOwning(course, materialId) {
        var ids = ((course && course.lessons) || []).map(String);
        var mid = String(materialId);
        function step(i) {
          if (i >= ids.length) { return Promise.resolve(null); }
          return Promise.resolve(Lesson.findById(ids[i])).then(function (lesson) {
            var has = lesson && (lesson.materials || []).map(String).indexOf(mid) >= 0;
            return has ? lesson : step(i + 1);
          }, function () { return step(i + 1); });
        }
        return step(0);
      }

      return Promise.all([
        Promise.resolve(Material.findById(sub.materialId)),
        Promise.resolve(Course.findById(sub.courseId)).then(function (course) {
          return lessonOwning(course, sub.materialId);
        }, function () { return null; })
      ]).then(function (found) {
        var material = found[0], lesson = found[1];
        var view = submissionView.toSubmissionView(sub);
        // trinketSubmissions.getUserSubmissionsForMaterial(user, material) reads
        // user.userId and material.parentResource.parentResource.id — shape the
        // course dashboard gets free from Restangular. Send the ids so the panel
        // can supply the same thing without pulling in the whole course app.
        view.userId = ltiNotifySubmission.creatorId(sub._creator);
        return request.success({
          courseId  : String(sub.courseId || ''),
          lessonId  : lesson ? String(lesson.id) : '',
          material  : material && material.toJSON ? material.toJSON() : (material || null),
          submission: view
        });
      });
    });
  },

  configXml11: function(request, reply) {
    var course = (request.query && request.query.course) || '';
    // Title/description are operator-supplied and land inside XML elements, so they
    // are ESCAPED rather than pattern-restricted — a deploy name may legitimately
    // contain punctuation. Naming matters because Canvas lists tools by title, and a
    // deploy carrying both a 1.3 and a 1.1 tool otherwise shows two indistinguishable
    // "Trinket" entries in the picker dialog. Manual-entry installs can be named but
    // get NO placements (Canvas reads placements only from this XML), so the title has
    // to be settable here or operators must choose between a name and a picker.
    function xmlEscape(v) {
      return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    }
    var q0 = request.query || {};
    var title = xmlEscape(String(q0.title || 'Trinket').slice(0, 80));
    var description = xmlEscape(String(q0.description ||
      'Write and run Python and Web VPython in the browser.').slice(0, 300));
    if (course && !/^[A-Za-z0-9_-]{1,64}$/.test(course)) {
      return reply(Boom.badRequest('Invalid course id.'));
    }
    // A DEDICATED /lti11/launch URL — distinct from the 1.3 /lti/launch — so a
    // Canvas that has BOTH a trinket 1.3 tool and a 1.1 tool matches a
    // module-item launch to the right one by URL (they collided on a shared
    // URL otherwise, binding the item to the 1.3 tool). See launch11.
    var launchUrl = lti11Verify.launchUrlFromRequest(request, config.app.url, publicHostname.resolve)
      .replace(/\/lti11\/config\.xml$/, '/lti11/launch');
    var custom = course
      ? '  <blti:custom>\n    <lticm:property name="trinket_course">' + course + '</lticm:property>\n  </blti:custom>\n'
      : '';
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<cartridge_basiclti_link xmlns="http://www.imsglobal.org/xsd/imslticc_v1p0"\n' +
      '    xmlns:blti="http://www.imsglobal.org/xsd/imsbasiclti_v1p0"\n' +
      '    xmlns:lticm="http://www.imsglobal.org/xsd/imslticm_v1p0"\n' +
      '    xmlns:lticp="http://www.imsglobal.org/xsd/imslticp_v1p0">\n' +
      '  <blti:title>' + title + '</blti:title>\n' +
      '  <blti:description>' + description + '</blti:description>\n' +
      '  <blti:launch_url>' + launchUrl + '</blti:launch_url>\n' +
      custom +
      '  <blti:extensions platform="canvas.instructure.com">\n' +
      '    <lticm:property name="privacy_level">public</lticm:property>\n' +
      // Deep-linking placements. Both point at the launch URL: the Content-Item
      // message is dispatched by lti_message_type, not by a separate endpoint.
      '    <lticm:options name="resource_selection">\n' +
      '      <lticm:property name="url">' + launchUrl + '</lticm:property>\n' +
      '      <lticm:property name="message_type">ContentItemSelectionRequest</lticm:property>\n' +
      '      <lticm:property name="text">' + title + '</lticm:property>\n' +
      '      <lticm:property name="enabled">true</lticm:property>\n' +
      '      <lticm:property name="selection_width">900</lticm:property>\n' +
      '      <lticm:property name="selection_height">600</lticm:property>\n' +
      '    </lticm:options>\n' +
      '    <lticm:options name="assignment_selection">\n' +
      '      <lticm:property name="url">' + launchUrl + '</lticm:property>\n' +
      '      <lticm:property name="message_type">ContentItemSelectionRequest</lticm:property>\n' +
      '      <lticm:property name="text">' + title + '</lticm:property>\n' +
      '      <lticm:property name="enabled">true</lticm:property>\n' +
      '      <lticm:property name="selection_width">900</lticm:property>\n' +
      '      <lticm:property name="selection_height">600</lticm:property>\n' +
      '    </lticm:options>\n' +
      '  </blti:extensions>\n' +
      '</cartridge_basiclti_link>\n';
    return reply(xml).type('application/xml').header('Cache-Control', 'no-store');
  },

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

  // GET /lti/register — the LMS opens this with ?reg_token (trinket's gate) plus the IMS params
  // ?openid_configuration (the platform's config URL) and ?registration_token (the platform's bearer).
  // Validate reg_token, fetch the platform config, render a confirm page. No record is created here.
  registerInit: function(request, reply) {
    var q = request.query || {};
    var rawToken      = q.reg_token;
    var openidCfgUrl  = q.openid_configuration;
    var platformToken = q.registration_token || '';
    if (!rawToken || !openidCfgUrl) {
      return request.fail({ message: 'Missing registration parameters.' });
    }
    // Do NOT `return` this Mongoose query — it also takes a callback, and the
    // hapi-20 handler shim .then()s a returned thenable, double-executing it
    // ("Query was already executed") on the Mongo backend (Firestore tolerates it).
    // The callback drives request.success/fail and the shim captures that. See the
    // trinketByOwnerAndSlug comment in lib/util/helpers.js for the same pattern.
    LtiRegistrationToken.findByHash(LtiRegistrationToken.hashToken(rawToken), function(err, token) {
      if (err) return request.fail({ message: 'Registration lookup failed.' });
      if (!token || !token.isValid()) {
        return request.fail({ message: 'This registration link is invalid, expired, or already used.' });
      }
      return ltiRegistration.fetchPlatformConfig(openidCfgUrl).then(function(openidConfig) {
        return request.success({
          regToken:             rawToken,
          openidConfiguration:  openidCfgUrl,
          registrationToken:    platformToken,
          issuer:               openidConfig.issuer,
          label:                token.label || openidConfig.issuer
        });
      }).catch(function(e) {
        return request.fail({ message: 'Could not read the LMS configuration: ' + e.message });
      });
    });
  },

  // POST /lti/register — the LMS-admin confirm form. Re-validate reg_token, POST the tool-config to
  // the platform, persist a PENDING platform, consume the token, return the IMS close page.
  registerComplete: function(request, reply) {
    var b = request.payload || {};
    var rawToken      = b.reg_token;
    var openidCfgUrl  = b.openid_configuration;
    var platformToken = b.registration_token || '';
    if (!rawToken || !openidCfgUrl) {
      return request.fail({ message: 'Missing registration parameters.' });
    }
    // Do NOT `return` this Mongoose query — it also takes a callback, and the
    // hapi-20 handler shim .then()s a returned thenable, double-executing it
    // ("Query was already executed") on the Mongo backend (Firestore tolerates it).
    // The callback drives request.success/fail and the shim captures that. See the
    // trinketByOwnerAndSlug comment in lib/util/helpers.js for the same pattern.
    LtiRegistrationToken.findByHash(LtiRegistrationToken.hashToken(rawToken), function(err, token) {
      if (err) return request.fail({ message: 'Registration lookup failed.' });
      if (!token || !token.isValid()) {
        return request.fail({ message: 'This registration link is invalid, expired, or already used.' });
      }
      return ltiRegistration.fetchPlatformConfig(openidCfgUrl)
        .then(function(openidConfig) {
          return ltiRegistration.register(openidConfig, platformToken).then(function(registrationResponse) {
            var fields   = ltiRegistration.toPlatformFields(openidConfig, registrationResponse);
            var platform = new LtiPlatform({
              issuer:            fields.issuer,
              clientId:          fields.clientId,
              authLoginUrl:      fields.authLoginUrl,
              authTokenUrl:      fields.authTokenUrl,
              jwksUrl:           fields.jwksUrl,
              deploymentIds:     fields.deploymentIds,
              name:              fields.name,
              productFamily:     fields.productFamily,
              status:            'pending',
              registeredVia:     'dynamic',
              initiatedByEmail:  token.initiatedByEmail
            });
            return new Promise(function(resolve, reject) {
              platform.save(function(saveErr, savedPlatform) {
                if (saveErr) return reject(saveErr);
                // Consume the token only AFTER a successful save — so the admin can retry on error.
                token.usedAt    = new Date();
                token.platformId = savedPlatform.id;
                Promise.resolve(token.save()).then(function() { resolve(); }, reject);
              });
            });
          });
        })
        .then(function() {
          return request.success({});
        })
        .catch(function(e) {
          // token NOT consumed — admin can retry with the same link
          return request.fail({ message: 'Registration failed: ' + e.message });
        });
    });
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

    // Do NOT `return` this Mongoose query — callback + returned thenable double-
    // executes via the hapi-20 shim ("Query was already executed") on Mongo. Same
    // fix as registerInit/Complete above; the callback drives reply.
    LtiPlatform.findByIssuer(iss, clientId, function(err, platform) {
      if (err) return reply(Boom.badImplementation(err.message));
      if (!platform) return reply(Boom.badRequest('Unknown LTI issuer: ' + iss));
      if (platform.status && platform.status !== 'active') {
        return reply(Boom.badRequest('This LMS registration is pending Trinket admin approval.'));
      }

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

    // LTI 1.1 launches arrive on this same URL as an OAuth1-signed form POST —
    // no OIDC, no id_token. Dispatch on payload shape (see handleLti11Launch).
    if (body.lti_message_type === 'basic-lti-launch-request' && !body.id_token) {
      return handleLti11Launch(request, reply);
    }

    var stateToken = body.state;
    var idToken    = body.id_token;
    if (!stateToken || !idToken) {
      return reply(Boom.badRequest('Missing state or id_token.'));
    }

    // 1. state: our own signed token (CSRF + nonce binding), unstored.
    var state;
    try { state = ltiState.verify(stateToken); }
    catch (e) { return reply(Boom.badRequest('Invalid or expired state.')); }

    // Do NOT `return` this Mongoose query (see loginInit above — double-executes
    // on Mongo via the hapi-20 shim). The callback drives reply.
    LtiPlatform.findByIssuer(state.iss, state.cid, function(err, platform) {
      if (err) return reply(Boom.badImplementation(err.message));
      if (!platform) return reply(Boom.badRequest('Unknown LTI issuer: ' + state.iss));
      if (platform.status && platform.status !== 'active') {
        return reply(Boom.badRequest('This LMS registration is pending Trinket admin approval.'));
      }

      // 2. id_token: verify signature against the platform JWKS + iss/aud/exp (jose seam).
      ltiVerify.verifyLaunchToken(idToken, platform)
        .then(function(claims) {
          // 3. nonce binds the id_token to our login request.
          if (!claims.nonce || claims.nonce !== state.nonce) {
            throw Boom.badRequest('nonce mismatch.');
          }
          // 4. deployment: must be present; auto-record an unknown one (Dynamic Registration often
          //    omits deployment_id until the admin deploys). Safe — the id_token is already verified
          //    against this platform's JWKS, and the platform is admin-activated (status gate above).
          var deploymentId = claims[LTI + 'deployment_id'];
          if (!deploymentId) {
            throw Boom.badRequest('Missing deployment_id.');
          }
          var ensureDeployment = platform.knowsDeployment(deploymentId)
            ? Promise.resolve()
            : new Promise(function (res, rej) { platform.addDeployment(deploymentId, function (e) { return e ? rej(e) : res(); }); });
          return ensureDeployment.then(function () {
          // 5. message type + version.
          var messageType = claims[LTI + 'message_type'];
          if (messageType !== 'LtiResourceLinkRequest' && messageType !== 'LtiDeepLinkingRequest') {
            throw Boom.badRequest('Unsupported message_type.');
          }
          if (claims[LTI + 'version'] !== '1.3.0') {
            throw Boom.badRequest('Unsupported LTI version.');
          }
          // 6. replay protection (only now, after the token is proven valid).
          return ltiNonceStore.checkAndRecord(claims.nonce, NONCE_TTL_SECONDS).then(function(fresh) {
            if (!fresh) throw Boom.badRequest('Replayed launch (nonce already used).');

            if (messageType === 'LtiDeepLinkingRequest') {
              var dlSettings = claims[DL + 'deep_linking_settings'] || {};
              // Picker mode detection by LMS product family (tool_platform claim). Both Canvas AND
              // Moodle omit accept_lineitem, so that flag can't tell them apart — use the family:
              //  - Canvas exposes TWO deep-linking placements that signal intent via accept_multiple
              //    (assignment_selection:false -> assignment; link_selection:true -> content). Lock to
              //    it so a Canvas user can't pick the wrong mode.
              //  - Moodle / D2L (and any other single-entry LMS) offer ONE generic "Select content"
              //    entry, so the request can't distinguish assignment vs content -> offer BOTH as tabs.
              var productFamily = ((claims[LTI + 'tool_platform'] || {}).product_family_code || '').toLowerCase();
              var dlMode, assignmentAllowed;
              if (productFamily === 'canvas') {
                dlMode = (dlSettings.accept_multiple === false) ? 'assignment' : 'content';
                assignmentAllowed = (dlMode === 'assignment');
              } else {
                dlMode = 'both';
                assignmentAllowed = true;  // LMS honors the returned lineItem if it supports AGS (normal case)
              }
              // TEMP diagnostic (KEEP until verified on a live Moodle/D2L launch): the platform's
              // product family + deep_linking_settings + our computed mode.
              log.info('[deep-link] settings', {
                product_family_code: (claims[LTI + 'tool_platform'] || {}).product_family_code,
                accept_types: dlSettings.accept_types,
                accept_multiple: dlSettings.accept_multiple,
                accept_lineitem: dlSettings.accept_lineitem,
                deep_link_return_url_present: !!dlSettings.deep_link_return_url,
                mode: dlMode,
                assignmentAllowed: assignmentAllowed
              });
              var email0 = (claims.email || '').toLowerCase();
              var lmsTeacher0 = ltiRoles.isTeacherRole(claims[LTI + 'roles']);
              return ltiInstructorAuthority.resolveInstructor({ email: email0, lmsTeacher: lmsTeacher0 })
                .catch(function () { return false; })
                .then(function (isInstructor0) {
                  return ltiProvision.provisionUser(claims, platform, { isInstructor: isInstructor0 }).then(function (user) {
                    request.yar.reset();
                    request.yar._logIn(user, function () {});
                    request.yar.set('ltiDeepLink', {
                      deep_link_return_url: dlSettings.deep_link_return_url,
                      data: dlSettings.data,
                      // accept_multiple distinguishes Canvas's placements: assignment_selection sends
                      // false (one gradeable item) → show assignments; link_selection sends true →
                      // show whole course + topics. (Canvas omits accept_lineitem, so we can't use it.)
                      acceptMultiple: !!dlSettings.accept_multiple,
                      // mode: 'assignment' | 'content' (Canvas, locked) or 'both' (Moodle/D2L, tabs).
                      // assignmentAllowed gates whether the graded-assignment option is offered.
                      mode: dlMode,
                      assignmentAllowed: assignmentAllowed,
                      deploymentId: deploymentId,
                      platformIss: platform.issuer,
                      platformCid: platform.clientId
                    });
                    return reply().redirect('/lti/deep-link');
                  });
                });
            }

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
                    // Assignment-precision landing: drop the user on the authored assignment PAGE
                    // (instructions + embedded trinket) rather than the bare course, so students see
                    // exactly which assignment to do. The page's embed is the submit surface, and
                    // submission -> AGS is keyed off course+material (not the launch session), so
                    // landing here loses nothing for grading. Enrollment above still uses
                    // target.course; falls back to the course path if the slugs didn't resolve.
                    if (target.assignment && target.assignment.lessonSlug && target.assignment.materialSlug) {
                      redirectPath = '/' + target.course.ownerSlug + '/courses/' + target.course.slug +
                        '#/' + target.assignment.lessonSlug + '/' + target.assignment.materialSlug;
                    } else if (target.topic && target.topic.lessonSlug) {
                      // Topic landing: the topic's first material page. The bare lesson fragment
                      // (#/{lessonSlug}) isn't routable by the course SPA (all its param routes are
                      // two-segment), so it would bounce to the course root — hence we land on the
                      // first material (#/{lessonSlug}/{materialSlug}), the same routable shape as an
                      // assignment. Only an empty topic (no materials) falls back to the bare lesson.
                      redirectPath = '/' + target.course.ownerSlug + '/courses/' + target.course.slug +
                        '#/' + target.topic.lessonSlug +
                        (target.topic.materialSlug ? '/' + target.topic.materialSlug : '');
                    }
                    var submissionId = ltiReview.parseTarget(claims[LTI + 'target_link_uri']);
                    if (submissionId) {
                      // SpeedGrader's review launch does NOT carry the assignment's resource_link /
                      // trinket_course custom params, so resolveTarget yields target.course=null.
                      // Authorize against the SUBMISSION's own course instead (the grader holds
                      // send-submission-feedback there).
                      return enrollP.then(function () {
                        return Promise.resolve(Trinket.findById(submissionId)).then(function (sub) {
                          if (!sub) return reply(Boom.notFound('Submission not found.'));
                          if (!ltiReview.canReview(user, sub)) {
                            return reply(Boom.forbidden('Not authorized to review this submission.'));
                          }
                          request.yar.reset();
                          request.yar._logIn(user, function () {});
                          return reply().redirect(ltiReview.redirectPath(sub));
                        });
                      });
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
          }); // end ensureDeployment.then
        })
        .catch(function(e) {
          if (e && e.isBoom) return reply(e);
          return reply(Boom.unauthorized('Launch verification failed: ' + (e && e.message)));
        });
    });
  },

  // POST /lti/deep-link/select — build the content item the instructor chose and return the signed
  // Deep Linking Response for auto-POST back to the platform's deep_link_return_url.
  deepLinkSelect: function(request, reply) {
    var dl = request.yar.get('ltiDeepLink');
    if (!dl || !dl.deep_link_return_url) {
      return request.fail({ message: 'Deep linking session expired — relaunch from your LMS.' });
    }
    var b = request.payload || {};

    // LTI 1.1 returns a JSON-LD content-item graph in an OAuth-signed form POST,
    // where 1.3 returns a single signed JWT. Same selection either way.
    if (dl.version === '1.1') {
      var item11 = (b.targetType === 'assignment')
        ? lti11DeepLinking.assignmentContentItem({ courseId: b.courseId, materialId: b.targetId, title: b.title, scoreMaximum: 100 })
        : lti11DeepLinking.linkContentItem({ courseId: b.courseId, lessonId: (b.targetType === 'topic' ? b.targetId : null), title: b.title });
      return new Promise(function (resolve) {
        LtiConsumer.findByKey(dl.consumerKey, function (err, c) { resolve(err ? null : c); });
      }).then(function (consumer) {
        if (!consumer || consumer.disabled) {
          return request.fail({ message: 'Unknown consumer for this deep-linking session.' });
        }
        return request.success({
          returnUrl: dl.deep_link_return_url,
          fields: lti11DeepLinking.buildReturnForm({
            returnUrl   : dl.deep_link_return_url,
            consumerKey : consumer.key,
            secret      : consumer.secret,
            contentItems: [item11],
            data        : dl.data
          })
        });
      });
    }

    var item = (b.targetType === 'assignment')
      ? ltiDeepLinking.assignmentContentItem({ courseId: b.courseId, materialId: b.targetId, title: b.title, scoreMaximum: 1 })
      : ltiDeepLinking.linkContentItem({ courseId: b.courseId, lessonId: (b.targetType === 'topic' ? b.targetId : null), title: b.title });
    return new Promise(function(resolve) {
      LtiPlatform.findByIssuer(dl.platformIss, dl.platformCid, function(err, platform) {
        resolve(platform);
      });
    }).then(function(platform) {
      if (!platform) return request.fail({ message: 'Unknown platform for this deep-linking session.' });
      var token = ltiDeepLinking.buildDeepLinkingResponse({
        platform: platform, deploymentId: dl.deploymentId,
        settings: { deep_link_return_url: dl.deep_link_return_url, data: dl.data },
        contentItems: [item]
      });
      return request.success({ returnUrl: dl.deep_link_return_url, jwt: token });
    });
  },

  // GET /lti/deep-link — the instructor picks content to return to the LMS. Session + the
  // deep_linking_settings were established by the deep-linking launch (Task 3, in request.yar).
  // Not a hot path (an instructor sets up an assignment occasionally), so the per-course
  // Course->Lesson->Material traversal is acceptable; resolve in parallel.
  deepLinkPicker: function(request, reply) {
    // A deep-linking launch establishes the session and stashes ltiDeepLink. Arriving
    // here WITHOUT either usually means the browser refused the cookie the launch set:
    // the LMS iframe is a third-party context, and Chrome (in its phase-out cohort, or
    // with the setting on, or in Incognito), Safari by default, and Firefox in strict
    // mode all block cookies there. Confirmed live: an instructor's framed requests
    // arrived with NO cookies at all while his top-level requests in the same browser
    // were authenticated. See #217.
    //
    // Redirecting to /login is useless in that case — signing in sets a cookie the
    // browser will refuse the same way, so it loops. Explain instead.
    var framed = (request.headers['sec-fetch-dest'] === 'iframe'
               || request.headers['sec-fetch-dest'] === 'frame');
    if (!request.user && framed) {
      return reply().view('lti/deep-link-cookies.html', {
        siteName : (config.app && config.app.siteName) || 'Trinket',
        siteHost : (request.info && request.info.hostname) || ''
      });
    }

    var dl = request.yar.get('ltiDeepLink');
    if (!dl || !dl.deep_link_return_url) {
      return request.fail({ message: 'Deep linking session expired — relaunch from your LMS.' });
    }
    // Context-aware picker. mode is set by the deep-linking launch:
    //  - 'assignment' (Canvas assignment_selection): offer assignments only.
    //  - 'content'    (Canvas link_selection): offer the whole course + its topics (lessons).
    //  - 'both'       (Moodle/D2L single entry): offer BOTH (course + topics AND assignments) as
    //                 tabs in the template; assignmentAllowed gates the assignment tab.
    // (Older sessions predate `mode`; fall back to the previous acceptMultiple behavior.)
    var mode = dl.mode || (dl.acceptMultiple ? 'content' : 'assignment');
    var bothMode = (mode === 'both');
    var contentMode = (mode === 'content');
    return new Promise(function(resolve, reject) {
      Course.findForUser(request.user.id, function(err, courses) {
        return err ? reject(err) : resolve(courses || []);
      });
    }).then(function(courses) {
      // Exclude archived/deleted courses (and therefore their topics/assignments) from the picker.
      courses = (courses || []).filter(function(c) { return c && !c.archived && !c.deleted; });
      return Promise.all(courses.map(function(course) {
        if (bothMode) {
          // Single-entry LMS: build BOTH datasets per course. Resolve each lesson once, then
          // derive topics (the lesson itself) and assignments (its assignment materials).
          return Promise.all((course.lessons || []).map(function(lessonId) {
            return Promise.resolve(Lesson.findById(lessonId)).then(function(lesson) {
              return lesson || null;
            }, function() { return null; });
          })).then(function(lessons) {
            lessons = lessons.filter(Boolean);
            var topics = lessons
              .filter(function(lesson) { return lesson && lesson.slug; })
              .map(function(lesson) { return { lessonId: lesson.id, title: lesson.name, slug: lesson.slug }; });
            return Promise.all(lessons.map(function(lesson) {
              return Promise.all((lesson.materials || []).map(function(materialId) {
                return Promise.resolve(Material.findById(materialId)).then(function(m) {
                  return (m && m.type === 'assignment') ? { materialId: m.id, title: m.name } : null;
                });
              }));
            })).then(function(perLesson) {
              var assignments = [].concat.apply([], perLesson).filter(Boolean);
              return { id: course.id, name: course.name, slug: course.slug, topics: topics, assignments: assignments };
            });
          });
        }
        if (contentMode) {
          // topics = the course's lessons (id/title/slug); slug is required to land on the topic.
          return Promise.all((course.lessons || []).map(function(lessonId) {
            return Promise.resolve(Lesson.findById(lessonId)).then(function(lesson) {
              return (lesson && lesson.slug) ? { lessonId: lesson.id, title: lesson.name, slug: lesson.slug } : null;
            }, function() { return null; });
          })).then(function(topics) {
            return { id: course.id, name: course.name, slug: course.slug, topics: topics.filter(Boolean) };
          });
        }
        return Promise.all((course.lessons || []).map(function(lessonId) {
          return Promise.resolve(Lesson.findById(lessonId)).then(function(lesson) {
            if (!lesson) return [];
            return Promise.all((lesson.materials || []).map(function(materialId) {
              return Promise.resolve(Material.findById(materialId)).then(function(m) {
                return (m && m.type === 'assignment') ? { materialId: m.id, title: m.name } : null;
              });
            }));
          });
        })).then(function(perLesson) {
          var assignments = [].concat.apply([], perLesson).filter(Boolean);
          return { id: course.id, name: course.name, slug: course.slug, assignments: assignments };
        });
      }));
    }).then(function(view) {
      var anyAssignments = view.some(function (c) { return c.assignments && c.assignments.length > 0; });
      var anyTopics = view.some(function (c) { return c.topics && c.topics.length > 0; });
      return request.success({
        courses: view,
        mode: mode,
        contentMode: contentMode,
        bothMode: bothMode,
        assignmentAllowed: (dl.assignmentAllowed !== false),
        anyAssignments: anyAssignments,
        anyTopics: anyTopics,
        returnConfigured: true
      });
    }).catch(function (e) {
      return request.fail({ message: 'Could not load your courses. Please try again.' });
    });
  },

  // GET /lti/_preview-picker — DEV-ONLY preview of the deep-link picker with mock data, so the
  // picker UI can be iterated locally without an LMS deep-linking launch. 404s outside development.
  // Query: ?mode=both|content|assignment (default both).
  deepLinkPreview: function (request, reply) {
    if (process.env.NODE_ENV !== 'development') { return reply(Boom.notFound()); }
    var mode = (request.query && request.query.mode) || 'both';
    var courses = [{
      id: 'c1', name: 'CSCI-155 Example', slug: 'csci-155',
      topics: [{ lessonId: 'l1', title: 'Intro', slug: 'intro' }, { lessonId: 'l2', title: 'Loops', slug: 'loops' }],
      assignments: [{ materialId: 'm1', title: 'Lab 1: Hello World' }, { materialId: 'm2', title: 'Lab 2: Turtle Graphics' }]
    }];
    return request.success({
      courses: courses, mode: mode,
      contentMode: (mode === 'content'), bothMode: (mode === 'both'),
      assignmentAllowed: true, anyAssignments: true, anyTopics: true, returnConfigured: true
    });
  }

};
