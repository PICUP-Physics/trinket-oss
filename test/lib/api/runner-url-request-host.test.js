'use strict';

// The glowscript runner loads its runtime from trinketAppConfig.url. That came
// from config.url, computed once at boot from the CONFIGURED public host, while
// the hostname beside it (trinketAppConfig.domain) already follows the request.
// So a page served by a no-traffic candidate (candidate---<svc>.run.app) loaded
// the runtime through the public host -- i.e. from the OLD revision -- and a
// candidate test ran the old compiler while reporting on the new build.
// (2026-11-04: the arithmetic table failed on both prods' candidates, and the
// old revision's compiler was cached under the new build's URL.)
const config = require('config');
const flow = require('../../helpers/flow.cjs');

const PAGE = '/embed/glowscript';
const CANDIDATE = 'candidate---trinket-abc123-uc.a.run.app';

async function render(headers) {
  await flow.get('/version');                       // boots and initializes the app
  const server = await require('../../../app.js');
  return server.inject({ method: 'GET', url: PAGE, headers });
}

const field = (html, name) => {
  const m = new RegExp('^\\s+' + name + "\\s+:\\s+'([^']*)'", 'm').exec(html);
  return m && m[1];
};

describe('the glowscript runner loads its runtime from the host that served the page', () => {
  it('a page served on a candidate host points the runtime at that host', async () => {
    const res = await render({ host: CANDIDATE });
    if (res.statusCode === 404) return;             // page not served by this deploy
    expect(res.statusCode).toBe(200);
    expect(field(res.payload, 'domain')).toBe(CANDIDATE);
    expect(field(res.payload, 'url')).toBe(config.app.url.protocol + '://' + CANDIDATE);
    expect(res.payload).not.toContain("'" + config.url + "/' + prefix");
  });

  it('a page served on the public host is unchanged', async () => {
    const res = await render({ host: config.app.url.hostname });
    if (res.statusCode === 404) return;
    expect(field(res.payload, 'url')).toBe(config.url);
  });
});
