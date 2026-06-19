// LTI 1.3 platform registration — one record per LMS instance (each issues trinket its own
// client_id). trinket's own Tool keypair/JWKS is single and shared across all platforms; only
// the platform registration is per-instance. See LTI-SPEC.md §10.
var model = require('./model');

var schema = {
  issuer        : { type: String, required: true },  // platform `iss` (OIDC issuer)
  clientId      : { type: String, required: true },  // client_id this platform issued to trinket
  authLoginUrl  : { type: String, required: true },  // platform OIDC authorization endpoint
  authTokenUrl  : { type: String },                  // platform OAuth2 token endpoint (later: AGS)
  jwksUrl       : { type: String, required: true },  // platform public keys (verify launch JWT)
  deploymentIds : { type: [String], default: [] },   // one client_id may be deployed several times
  name          : { type: String },                  // human label (e.g. "UIndy Canvas")
  trustEmail    : { type: Boolean, default: true }    // gate email-based account linking (§8.2)
};

// Look up a registered platform by issuer (and client_id when provided). A launch identifies
// the platform by `iss`; when the client_id is also known, match both to disambiguate multiple
// registrations under one issuer.
function findByIssuer(issuer, clientId, cb) {
  if (typeof clientId === 'function') { cb = clientId; clientId = undefined; }
  var query = { issuer: issuer };
  if (clientId) query.clientId = clientId;
  return this.model.findOne(query, cb);
}

// True if this platform has registered the given deployment_id (launch validation §7.2 step 6).
function knowsDeployment(deploymentId) {
  return Array.isArray(this.deploymentIds) && this.deploymentIds.indexOf(deploymentId) >= 0;
}

var LtiPlatform = model.create('LtiPlatform', {
  schema: schema,
  classMethods: {
    findByIssuer: findByIssuer
  },
  objectMethods: {
    knowsDeployment: knowsDeployment
  },
  publicSpec: {
    id: true, issuer: true, clientId: true, name: true
  }
}).publicModel;

module.exports = LtiPlatform;
