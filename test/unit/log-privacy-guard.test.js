'use strict';
const fs   = require('fs');
const path = require('path');

// Every console.* call in lib/ that logs an email address must go through
// lib/util/logPrivacy (ferpa.logEmails). A single-line heuristic: it flags a
// console call whose line mentions `.email` without `logPrivacy.`.
const LIB = path.join(__dirname, '../../lib');

function isOffending(line) {
  return /console\.(log|info|warn|error)\(/.test(line) && /\.email\b/.test(line) && !/logPrivacy\./.test(line);
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('log privacy guard', () => {
  it('finds no console.* call in lib/ that logs .email without logPrivacy', () => {
    const offenders = [];
    for (const file of jsFiles(LIB)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (isOffending(line)) offenders.push(path.relative(LIB, file) + ':' + (i + 1) + ': ' + line.trim());
      });
    }
    expect(offenders).toEqual([]);
  });

  it('recognises a raw email log line (self-test of the heuristic)', () => {
    expect(isOffending("console.log('LOGIN: Starting login for', request.payload.email);")).toBe(true);
    expect(isOffending("console.log('LOGIN: Starting login for', logPrivacy.email(request.payload.email));")).toBe(false);
  });
});
