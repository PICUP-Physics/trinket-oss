// Per-run deploy-test identities: minted at the start of a run, destroyed at the
// end, never stored anywhere.
//
// The standing-account model (docs/DEPLOY-TESTING.md) needs a password that
// lives somewhere and can be found again months later. In practice it could
// not be: the captured sessions expired after a week and the passwords were
// lost, which cost an afternoon and a credential reset. An identity that exists
// only for the length of a run has no home to lose — nothing at rest, nothing
// to expire, and a leak is worth minutes rather than months.
//
// The policy said per-run identities were impractical because trials run
// `requireApprovedAccount: true`. They do not — it is false on every trial and
// in config/default.yaml. That premise is stale.
//
// ONE privileged call is unavoidable. lib/controllers/auth.js refuses to resolve
// an account for an unverified email (GHSA-w66h-rw9x-7h24: an unverified address
// could otherwise link onto someone else's account), and Firebase issues
// email/password tokens with email_verified:false on signup. So the account must
// be admin-marked verified, via a SHORT-LIVED gcloud token — never a
// service-account key. The gate itself is not touched; we work with it.
// Everything else is self-service: the account deletes its own app-side User
// (DELETE /api/users only permits deleting yourself) and its own Firebase
// account (accounts:delete with its own idToken).
const { execFileSync } = require('child_process');
const fixtures = require('./fixtures');

// FAIL-CLOSED HOST ALLOWLIST.
//
// This module CREATES accounts. Read-only sign-in could rely on the operator
// passing the right --base-url; a mint path must not, because the failure mode
// is test identities in a real user base — the one thing DEPLOY-TESTING.md
// forbids outright ("mandi/production keep the no-test-identities rule
// regardless"). An unknown host is refused rather than trusted.
//
// Adding a host here should be a deliberate edit with a reason, not a reflex.
const TRIAL_HOSTS = new Set([
  'rba-merge-trial.spvi.net',          // trial-gcr
  'trial-merge.spvi.net',              // compose/Mongo trial
  'trinket-merge-test.web.app',        // cdn-test, via Firebase Hosting
  'trinket-merge-test.firebaseapp.com',
  'localhost',
  '127.0.0.1',
]);

// Other people run their own trials — Andrew's staging server, a self-hoster's
// scratch box — and they should not have to edit this file (or fork it) to use
// the harness. TRIAL_HOSTS_EXTRA opts additional hosts in, comma-separated:
//
//   TRIAL_HOSTS_EXTRA=trinket-staging.example.com npx playwright test -c ...
//
// This keeps the fail-closed property: a host nobody has named is still
// refused. It only removes the need for a code change to name one.
function extraHosts() {
  return (process.env.TRIAL_HOSTS_EXTRA || '')
    .split(',')
    .map(function(h) { return h.trim().toLowerCase(); })
    .filter(Boolean);
}

// Hosts that can NEVER be minted on, whatever the environment says. An env var
// is easy to set by accident — in a shell profile, a CI variable, a copied
// command — and the cost of getting it wrong here is test accounts in a real
// student body. These are the deploys real people use, so they are refused
// even when explicitly named.
const NEVER_MINTABLE = new Set([
  'rba-uindy.spvi.net',                 // UIndy production
  'trinket.matterandinteractions.org',  // M&I production
  'trinket.gopicup.org',                // PICUP production (VPS)
]);

function assertMintable(baseURL) {
  const host = new URL(baseURL).hostname.toLowerCase();

  if (NEVER_MINTABLE.has(host)) {
    throw new Error(
      'REFUSING to create a test identity on "' + host + '": this is a PRODUCTION deploy.\n' +
      'This refusal cannot be overridden by TRIAL_HOSTS_EXTRA. If you genuinely need\n' +
      'to test there, use the anonymous specs, which create nothing.'
    );
  }

  const allowed = new Set([...TRIAL_HOSTS, ...extraHosts()]);
  if (!allowed.has(host)) {
    throw new Error(
      'REFUSING to create a test identity on "' + host + '": not a known trial host.\n' +
      'Creating accounts on a production deploy is forbidden (docs/DEPLOY-TESTING.md).\n' +
      'If this really is a trial, either add it to TRIAL_HOSTS in\n' +
      'test/browser/ephemeral-identity.js, or set TRIAL_HOSTS_EXTRA=' + host + '\n' +
      'for this run. Known trials: ' + [...allowed].join(', ')
    );
  }
  return host;
}

// The apiKey is public by design (it ships in the login page); projectId comes
// from the same blob and is needed for the admin endpoint's URL.
async function firebaseConfig(request, baseURL) {
  const text = await (await request.get(new URL('/login', baseURL).toString())).text();
  const key  = /"apiKey"\s*:\s*"([^"]+)"/.exec(text);
  const proj = /"projectId"\s*:\s*"([^"]+)"/.exec(text);
  if (!key)  throw new Error('no Firebase apiKey on /login — is this a Firebase deploy?');
  if (!proj) throw new Error('no Firebase projectId on /login');
  return { apiKey: key[1], projectId: proj[1] };
}

function gcloudToken() {
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  } catch (e) {
    throw new Error(
      'need a gcloud access token to mark the test identity verified, and `gcloud auth ' +
      'print-access-token` failed. Run `gcloud auth login` (or set SMOKE_EMAIL/SMOKE_PASSWORD ' +
      'to use a standing account instead). Underlying: ' + String(e.message).slice(0, 200)
    );
  }
}

// A password nobody needs to know: it exists for the length of the run and is
// never written down. 24 bytes of crypto randomness, not a memorable string.
function throwawayPassword() {
  return require('crypto').randomBytes(24).toString('base64url') + 'aA1!';
}

async function mint(request, baseURL, role) {
  assertMintable(baseURL);
  const { apiKey, projectId } = await firebaseConfig(request, baseURL);
  const email    = fixtures.PREFIX + role + '-' + require('crypto').randomBytes(4).toString('hex') + '@example.com';
  const password = throwawayPassword();
  const acct     = 'https://identitytoolkit.googleapis.com/v1/accounts:';

  const up = await (await request.post(acct + 'signUp?key=' + apiKey,
    { data: { email, password, returnSecureToken: true } })).json();
  if (!up.idToken) {
    throw new Error('signUp failed for ' + email + ': ' + JSON.stringify(up.error || up).slice(0, 200));
  }

  // The one privileged call. Short-lived token, admin endpoint, nothing stored.
  const verify = await request.post(
    'https://identitytoolkit.googleapis.com/v1/projects/' + projectId + '/accounts:update',
    { headers: { Authorization: 'Bearer ' + gcloudToken(), 'x-goog-user-project': projectId },
      data: { localId: up.localId, emailVerified: true } });
  if (verify.status() !== 200) {
    throw new Error('could not mark ' + email + ' verified (' + verify.status() + '): '
      + (await verify.text()).slice(0, 200));
  }

  return { email, password, localId: up.localId };
}

// Best-effort, and deliberately so: a run that crashes never reaches teardown,
// so nothing may depend on this having happened. It reports what it could not
// remove rather than throwing, because failing the RUN over failed cleanup would
// turn a tidy-up problem into a red suite.
async function destroy(request, baseURL, identity) {
  const problems = [];
  try {
    const { apiKey } = await firebaseConfig(request, baseURL);
    const acct = 'https://identitytoolkit.googleapis.com/v1/accounts:';
    const signIn = await (await request.post(acct + 'signInWithPassword?key=' + apiKey,
      { data: { email: identity.email, password: identity.password, returnSecureToken: true } })).json();

    if (signIn.idToken) {
      // App-side User first: it needs the session, which needs the account.
      const sess = await request.post(new URL('/api/auth/session', baseURL).toString(),
        { data: { idToken: signIn.idToken } });
      if (sess.status() === 200) {
        // There is no GET /api/user route on this app — base.html renders the
        // signed-in username into a hidden #whoami input, which is the stable
        // hook. (course-journey.spec.js calls /api/user and guards on a falsy
        // result, so its slug-redirect assertion has been quietly skipping.)
        const home = await (await request.get(new URL('/home', baseURL).toString())).text();
        const m = /id="whoami"[^>]*value="([^"]*)"/.exec(home);
        const username = m && m[1];
        if (username) {
          const del = await request.fetch(
            new URL('/api/users?username=' + encodeURIComponent(username), baseURL).toString(),
            { method: 'DELETE' });
          if (del.status() !== 200) problems.push('app user ' + username + ' → HTTP ' + del.status());
        } else {
          problems.push('could not read username from /api/user');
        }
      } else {
        problems.push('session exchange → HTTP ' + sess.status());
      }

      // Then the Firebase account, using its own token — no admin needed.
      const gone = await request.post(acct + 'delete?key=' + apiKey, { data: { idToken: signIn.idToken } });
      if (gone.status() !== 200) problems.push('firebase account → HTTP ' + gone.status());
    } else {
      problems.push('could not sign in to clean up: ' + JSON.stringify(signIn.error || {}).slice(0, 120));
    }
  } catch (e) {
    problems.push(String(e.message).slice(0, 200));
  }
  return problems;
}

module.exports = { mint, destroy, assertMintable, TRIAL_HOSTS, NEVER_MINTABLE };
