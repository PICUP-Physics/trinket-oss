const { test, expect } = require('@playwright/test');

// The components prefix is CONTENT-addressed (#238), and the worker is a MODULE
// worker (#215/#242). Both are deploy facts no unit test can establish.
//
// #238's whole claim is that a component URL survives a deploy while /js/ and
// /css/ roll. A single run cannot prove that — it needs two deploys — so this
// records the current prefixes in a way a second run can compare, and asserts
// the invariant that IS checkable now: components and js must not share a token
// once the hash is in play.

test.describe('asset prefixes', () => {
  test('components use a different token from js/css', async ({ page }) => {
    await page.goto('/embed/glowscript');
    const html = await page.content();

    const comp = /cache-prefix-([a-f0-9]{6,64})\/components\//.exec(html);
    const other = /cache-prefix-([a-f0-9]{6,64})\/(?:js|css)\//.exec(html);
    test.skip(!comp || !other, 'this deploy does not emit both kinds of prefixed URL');

    // Before #238 both were the deploy commit. After it, components carry a
    // content hash — so they diverge, and that divergence is what stops every
    // deploy re-issuing 6.6 MB of unchanged URLs.
    console.log(`  components token: ${comp[1]}   js/css token: ${other[1]}`);
    expect(comp[1], 'components should not be on the deploy token (#238)')
      .not.toBe(other[1]);
  });

  test('the components bundle is served immutable', async ({ page, request }) => {
    await page.goto('/embed/glowscript');
    const html = await page.content();
    const m = /(\/cache-prefix-[a-f0-9]{6,64}\/components\/[^"'\s)]+\.js)/.exec(html);
    test.skip(!m, 'no prefixed component URL on this page');

    const res = await request.get(m[1]);
    expect(res.status()).toBe(200);
    const cc = res.headers()['cache-control'] || '';
    // A deploy without app.cache.enabled serves no-store; that is a real
    // configuration, not a failure, so report rather than fail.
    test.skip(/no-store/.test(cc), 'app.cache.enabled is off on this deploy');
    expect(cc, 'a content-addressed asset should be immutable').toContain('immutable');
  });

  test('the pyodide worker is requested as a module', async ({ page, request, baseURL }) => {
    // #242: a classic worker cannot load pyodide 314.x, so the worker must be
    // constructed with { type: 'module' } and reach the runtime through a
    // dynamic import() of pyodide.mjs rather than importScripts().
    //
    // This used to grep page.content() for "pyodide.mjs" and could NEVER pass:
    // that URL is assembled at runtime inside /js/embed/pyodide.js, so it is
    // not in the DOM at all. The test skipped on every main-thread deploy and
    // failed on the first worker deploy it ever met — so it had never once
    // produced a signal. Assert against the scripts the page actually loads.
    await page.goto('/embed/python3');
    const html = await page.content();
    test.skip(!/workerRuntime["']?\s*:\s*true/.test(html), 'not a worker deploy');

    const src = async (p) => (await request.get(new URL(p, baseURL).toString())).text();

    const client = await src('/js/embed/worker-client.js');
    expect(client, 'the worker must be constructed as a module worker')
      .toMatch(/type:\s*['"]module['"]/);

    const host = await src('/js/embed/pyodide.js');
    expect(host, 'the worker must be pointed at the module build (#215)')
      .toContain('pyodide.mjs');

    const worker = await src('/js/embed/pyodide-worker.js');
    expect(worker, 'a module worker loads its runtime with import(), not importScripts')
      .toMatch(/import\(/);
    expect(worker, 'importScripts is unavailable in a module worker')
      .not.toMatch(/self\.importScripts\s*\(/);
  });
});
