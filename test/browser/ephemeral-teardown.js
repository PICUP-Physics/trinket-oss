// Destroy whatever globalSetup minted. Best-effort by contract: a killed run
// never reaches this, so scripts/smoke-cleanup.js remains the backstop and
// nothing may assume teardown ran.
const { request } = require('@playwright/test');
const fs = require('fs');
const ephemeral = require('./ephemeral-identity');
const { RECORD } = require('./ephemeral-setup');

module.exports = async () => {
  if (!fs.existsSync(RECORD)) return;
  const { baseURL, identities } = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
  const ctx = await request.newContext({ baseURL });
  for (const id of identities) {
    const problems = await ephemeral.destroy(ctx, baseURL, id);
    console.log(problems.length
      ? '  ephemeral identity ' + id.email + ' NOT fully removed: ' + problems.join('; ')
      : '  ephemeral identity removed: ' + id.email);
  }
  await ctx.dispose();
  fs.unlinkSync(RECORD);
};
