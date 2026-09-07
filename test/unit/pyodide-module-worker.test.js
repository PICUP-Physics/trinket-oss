'use strict';

// Pyodide 314.x (Python 3.14) dropped CLASSIC web workers — picup #215.
//
// Isolated in a bare blob worker with none of our code loaded:
//   v0.28.1   importScripts -> OK
//   v0.29.4   importScripts -> OK
//   v314.0.0  importScripts -> NetworkError
//   v314.0.6  fetch + eval  -> "Classic web workers are not supported"
//
// A MODULE worker loading pyodide.mjs boots at 0.28.1, 0.29.4 AND 314.0.6, so
// this conversion is backward compatible and can land while still pinned at
// 0.28.1. It is a prerequisite for any Pyodide bump, not a consequence of one.
//
// Three things have to move together, and missing any one leaves a worker that
// silently never boots:
//   1. the Worker is constructed with { type: 'module' }
//   2. the worker imports pyodide.mjs via import(), not importScripts()
//   3. the context guard stops using importScripts to detect "am I a worker",
//      because a module worker does not have it
const fs   = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('the Pyodide worker is a module worker (#215)', () => {
  it('constructs the Worker with type: module', () => {
    const src = read('public/js/embed/worker-client.js');
    expect(src, 'a classic worker cannot load pyodide 314.x')
      .toMatch(/new WorkerCtor\([^)]*\{[^}]*type:\s*['"]module['"]/s);
  });

  it('loads pyodide with import(), not importScripts()', () => {
    const src = read('public/js/embed/pyodide-worker.js');
    expect(src).not.toMatch(/self\.importScripts\s*\(\s*msg\.pyodideUrl/);
    expect(src, 'a module worker imports its dependency').toMatch(/import\s*\(\s*msg\.pyodideUrl/);
  });

  it('points at pyodide.mjs, which is the module build', () => {
    const src = read('public/js/embed/pyodide.js');
    expect(src).toMatch(/pyodideUrl\s*:\s*PYODIDE_INDEX_URL\s*\+\s*['"]pyodide\.mjs['"]/);
  });

  it('does not use importScripts to detect the worker context', () => {
    // A module worker has no importScripts, so the old guard would skip the
    // whole runtime and the worker would answer nothing at all.
    const src = read('public/js/embed/pyodide-worker.js');
    expect(src).not.toMatch(/typeof\s+self\.importScripts\s*===\s*['"]function['"]/);
  });
});
