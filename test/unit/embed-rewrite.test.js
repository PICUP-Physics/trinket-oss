'use strict';
// picup #51: the course importer rewrites trinket embed iframes to point at THIS
// server. Shortcode embeds map old->new shortCode; shortcode-LESS sandbox embeds
// (e.g. https://trinket.io/embed/glowscript) previously matched no regex and were
// left loading from trinket.io. rewriteTrinketEmbeds now handles both.
const { rewriteTrinketEmbeds } = require('../../lib/util/embedRewrite');
const BASE = 'https://mysite.example';

describe('rewriteTrinketEmbeds', () => {
  it('rewrites a resolved shortcode embed to this host + the new shortCode', () => {
    const html = '<iframe src="https://trinket.io/embed/python3/abc123def0" width="100"></iframe>';
    const res = rewriteTrinketEmbeds(html, { abc123def0: 'newsc12345' }, BASE);
    expect(res.content).toContain(BASE + '/embed/python3/newsc12345');
    expect(res.content).not.toContain('trinket.io');
    expect(res.unresolved).toEqual([]);
  });

  it('rewrites a shortcode-LESS sandbox embed host to this server (issue #51)', () => {
    const html = '<iframe src="https://trinket.io/embed/glowscript" width="100"></iframe>';
    const res = rewriteTrinketEmbeds(html, {}, BASE);
    expect(res.content).toContain('src="' + BASE + '/embed/glowscript"');
    expect(res.content).not.toContain('trinket.io');
    expect(res.unresolved).toEqual([]);
  });

  it('preserves query params on a shortcode-less embed', () => {
    const html = '<iframe src="https://trinket.io/embed/glowscript?outputOnly=true"></iframe>';
    const res = rewriteTrinketEmbeds(html, {}, BASE);
    expect(res.content).toContain(BASE + '/embed/glowscript?outputOnly=true');
    expect(res.content).not.toContain('trinket.io');
  });

  it('tracks an unresolved shortcode and leaves it pointing at the original', () => {
    const html = '<iframe src="https://trinket.io/embed/python3/deadbeef99"></iframe>';
    const res = rewriteTrinketEmbeds(html, {}, BASE);
    expect(res.unresolved).toEqual(['deadbeef99']);
    expect(res.content).toContain('trinket.io/embed/python3/deadbeef99'); // unchanged
  });

  it('leaves a relative shortcode-less embed untouched (already local)', () => {
    const html = '<iframe src="/embed/glowscript"></iframe>';
    const res = rewriteTrinketEmbeds(html, {}, BASE);
    expect(res.content).toBe(html);
  });

  it('is idempotent — re-running does not double-rewrite a shortcode-less embed', () => {
    const html = '<iframe src="https://trinket.io/embed/glowscript"></iframe>';
    const once  = rewriteTrinketEmbeds(html, {}, BASE).content;
    const twice = rewriteTrinketEmbeds(once, {}, BASE).content;
    expect(twice).toBe(once);
  });
});
