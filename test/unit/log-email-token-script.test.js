'use strict';
const path          = require('path');
const crypto        = require('crypto');
const { spawnSync } = require('child_process');

const ROOT   = path.join(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/log-email-token.js');
const KEY    = 'k'.repeat(40);

function run(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), {
    cwd      : ROOT,
    encoding : 'utf8',
    env      : Object.assign({}, process.env, { NODE_ENV: 'test', FERPA_LOG_TOKEN_SECRET: KEY }),
  });
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
});
