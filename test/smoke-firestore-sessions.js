#!/usr/bin/env node
// Smoke test for catbox-firestore and firestore-client (slug store).
// Run with Firestore emulator active:
//   FIRESTORE_EMULATOR_HOST=localhost:8080 GOOGLE_CLOUD_PROJECT=demo-trinket \
//   NODE_ENV=development node test/smoke-firestore-sessions.js

'use strict';

process.env.NODE_ENV = process.env.NODE_ENV || 'development';

var assert = require('assert').strict;

var passed = 0;
var failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log('  ✓', label);
    passed++;
  } catch (err) {
    console.error('  ✗', label);
    console.error('   ', err.message);
    failed++;
  }
}

(async function main() {

  // ── catbox-firestore ────────────────────────────────────────────────────────

  console.log('\ncatbox-firestore');

  var CatboxFirestore = require('../lib/util/catbox-firestore');
  var engine = new CatboxFirestore.Engine({});
  await engine.start();

  var key = { segment: 'sessions', id: 'test-session-' + Date.now() };

  await test('isReady() returns true after start()', async function() {
    assert.equal(engine.isReady(), true);
  });

  await test('validateSegmentName returns null for valid name', function() {
    assert.equal(engine.validateSegmentName('sessions'), null);
  });

  await test('validateSegmentName returns Error for empty name', function() {
    assert.ok(engine.validateSegmentName('') instanceof Error);
  });

  await test('get() returns null for missing key', async function() {
    var result = await engine.get(key);
    assert.equal(result, null);
  });

  await test('set() then get() round-trip', async function() {
    var value = { userId: 'user123', role: 'admin', nested: { count: 42 } };
    var ttl   = 60 * 60 * 1000;
    await engine.set(key, value, ttl);
    var result = await engine.get(key);
    assert.ok(result !== null);
    assert.deepEqual(result.item, value);
    assert.ok(typeof result.stored === 'number');
    assert.equal(result.ttl, ttl);
  });

  await test('get() returns null for expired entry', async function() {
    var expiredKey = { segment: 'sessions', id: 'expired-' + Date.now() };
    await engine.set(expiredKey, { x: 1 }, 1); // 1ms TTL
    await new Promise(function(r) { setTimeout(r, 10); });
    var result = await engine.get(expiredKey);
    assert.equal(result, null);
  });

  await test('drop() removes entry', async function() {
    var dropKey = { segment: 'sessions', id: 'drop-' + Date.now() };
    await engine.set(dropKey, { y: 2 }, 3600000);
    await engine.drop(dropKey);
    var result = await engine.get(dropKey);
    assert.equal(result, null);
  });

  engine.stop();
  await test('stop() makes isReady() false', function() {
    assert.equal(engine.isReady(), false);
  });

  // ── firestore-client (slug store) ──────────────────────────────────────────

  console.log('\nfirestore-client (slug store)');

  var client = require('../lib/util/store/firestore-client');
  var key2   = 'test:slug:' + Date.now();

  await test('lIndex on missing key returns null', async function() {
    assert.equal(await client.lIndex(key2, 0), null);
  });

  await test('lPush + lIndex returns head element', async function() {
    await client.lPush(key2, 'id-b');
    await client.lPush(key2, 'id-a');
    assert.equal(await client.lIndex(key2, 0), 'id-a');
  });

  await test('lRange returns all elements in insertion order', async function() {
    var all = await client.lRange(key2, 0, -1);
    assert.deepEqual(all, ['id-a', 'id-b']);
  });

  await test('rPush appends to tail', async function() {
    await client.rPush(key2, 'id-c');
    var all = await client.lRange(key2, 0, -1);
    assert.deepEqual(all, ['id-a', 'id-b', 'id-c']);
  });

  await test('lRem removes all matching values', async function() {
    var removed = await client.lRem(key2, 0, 'id-b');
    assert.equal(removed, 1);
    var all = await client.lRange(key2, 0, -1);
    assert.deepEqual(all, ['id-a', 'id-c']);
  });

  await test('exists returns 1 for non-empty list', async function() {
    assert.equal(await client.exists(key2), 1);
  });

  await test('exists returns 0 for missing key', async function() {
    assert.equal(await client.exists('no:such:key:' + Date.now()), 0);
  });

  await test('lIndex with negative index (-1 = last element)', async function() {
    assert.equal(await client.lIndex(key2, -1), 'id-c');
  });

  // ── summary ────────────────────────────────────────────────────────────────

  console.log('\n' + passed + ' passed' + (failed ? ', ' + failed + ' FAILED' : '') + '\n');
  if (failed > 0) process.exit(1);

})().catch(function(err) {
  console.error('Unexpected error:', err);
  process.exit(1);
});
