// globalSetup for the deploy suite: when no standing credentials are supplied,
// mint a per-run instructor and student, hand them to the specs through the same
// SMOKE_* variables they already read, and record them for teardown.
//
// Opt-out by design — setting SMOKE_EMAIL/SMOKE_PASSWORD keeps the standing-account
// path, which is what CI needs until it has a way to get a gcloud token
// (workload identity federation). Nothing here changes how a spec signs in.
const { request } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');
const ephemeral = require('./ephemeral-identity');

const RECORD = path.join(__dirname, '.auth', 'ephemeral-run.json');

module.exports = async () => {
  const baseURL = process.env.TRINKET_BASE_URL;
  if (process.env.SMOKE_EMAIL || !baseURL) return;      // standing accounts, or nothing to do

  const ctx = await request.newContext({ baseURL });

  // Form-auth deploys (a password field on /login) have no Firebase to mint
  // against — minting there throws, and a throw in globalSetup kills the WHOLE
  // run, anonymous specs included. Detect and bow out instead: the journeys
  // will skip for want of SMOKE_EMAIL, exactly as before this file existed.
  //
  // This MUST come before assertMintable. A form-auth deploy cannot mint no
  // matter which host it is on, so the allowlist is gating a path that can
  // never be taken — and asserting first turns "skip the journeys" into "abort
  // the whole run" for every form-auth deploy not on the list. Andrew's
  // trinket-staging.drewsday.com is exactly that shape, and the guard test
  // below uses it as its example of a refused host.
  const login = await (await ctx.get(new URL('/login', baseURL).toString())).text();
  if (/type="password"/.test(login)) {
    console.log('  ephemeral identities: form-auth deploy, nothing to mint (set SMOKE_EMAIL to run journeys here)');
    await ctx.dispose();
    return;
  }

  // Refuse before creating anything, not after. Nothing has been created above:
  // the probe is a single unauthenticated GET of the login page.
  try {
    ephemeral.assertMintable(baseURL);
  } catch (e) {
    await ctx.dispose();
    throw e;
  }

  const instructor = await ephemeral.mint(ctx, baseURL, 'teacher');
  const student    = await ephemeral.mint(ctx, baseURL, 'learner');
  await ctx.dispose();

  process.env.SMOKE_EMAIL            = instructor.email;
  process.env.SMOKE_PASSWORD         = instructor.password;
  process.env.SMOKE_STUDENT_EMAIL    = student.email;
  process.env.SMOKE_STUDENT_PASSWORD = student.password;

  // Teardown runs in its own process, so the run is recorded on disk rather than
  // in memory. .auth/ is gitignored; the file is deleted by the teardown.
  fs.mkdirSync(path.dirname(RECORD), { recursive: true });
  fs.writeFileSync(RECORD, JSON.stringify({ baseURL, identities: [instructor, student] }), { mode: 0o600 });
  console.log('  ephemeral identities minted: ' + instructor.email + ', ' + student.email);
};

module.exports.RECORD = RECORD;
