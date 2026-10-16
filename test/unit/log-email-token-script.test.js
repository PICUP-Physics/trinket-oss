'use strict';
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const crypto        = require('crypto');
const { spawnSync } = require('child_process');

const ROOT   = path.join(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/log-email-token.js');
const KEY    = 'k'.repeat(40);

const RUNTIME_JSON = path.join(os.tmpdir(), 'log-email-token-runtime-' + process.pid + '.json');

// The child runs as an operator's shell would: without vitest's node-config
// guards, a developer's deploy overlay or NODE_CONFIG. NODE_CONFIG_RUNTIME_JSON
// points node-config's persistence file at a temp path, never into the repo.
function run(args, extraEnv) {
  const env = Object.assign({}, process.env);
  delete env.NODE_CONFIG_PERSIST_ON_CHANGE;
  delete env.NODE_CONFIG_DISABLE_FILE_WATCH;
  delete env.TRINKET_DEPLOY;
  delete env.NODE_CONFIG;
  Object.assign(env, { NODE_ENV: 'test', FERPA_LOG_TOKEN_SECRET: KEY, NODE_CONFIG_RUNTIME_JSON: RUNTIME_JSON }, extraEnv || {});
  return spawnSync(process.execPath, [SCRIPT].concat(args), { cwd: ROOT, encoding: 'utf8', env: env });
}

// The documented algorithm, computed independently of the script.
function expectedToken(address, key) {
  const normalized = address.trim().toLowerCase();
  const hex = crypto.createHmac('sha256', key)
    .update('trinket-log-email-v1:' + normalized).digest('hex').slice(0, 8);
  return 'u-' + hex + '@' + normalized.slice(normalized.lastIndexOf('@') + 1);
}

describe('scripts/log-email-token.js', () => {
  it('prints the token the logs use, one line per address', () => {
    const result = run(['Student@CNU.edu', 'other@x.org']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'Student@CNU.edu -> ' + expectedToken('Student@CNU.edu', KEY),
      'other@x.org -> ' + expectedToken('other@x.org', KEY),
    ]);
  });

  it('exits with status 2 and a usage line when given no addresses', () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: node scripts/log-email-token.js');
  });

  it('does not write a node-config runtime.json (same guards as app.js)', () => {
    fs.rmSync(RUNTIME_JSON, { force: true });
    const result = run(['a@b.edu']);
    expect(result.status).toBe(0);
    expect(fs.existsSync(RUNTIME_JSON)).toBe(false);
  });

  it('refuses, with status 1 and nothing on stdout, when no key is configured', () => {
    const result = run(['a@b.edu'], {
      FERPA_LOG_TOKEN_SECRET : '',
      SESSION_PASSWORD       : '',
      // A developer's config/local.yaml may set a session password; make the "no key" case real.
      NODE_CONFIG            : JSON.stringify({ app: { plugins: { session: { cookieOptions: { password: '' } } } }, ferpa: { logTokenSecret: '' } }),
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('could never match the logs');
  });
});
