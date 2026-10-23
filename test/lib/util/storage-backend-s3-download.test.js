'use strict';

// The S3 read signer must behave exactly as lib/controllers/users.js did before
// downloads moved behind the storage abstraction — S3/Garage deploys (the VPS,
// and every mongo deploy) must see no change at all.
//
// S3_PUBLIC_HOST is an env-only knob with no other reference anywhere in the
// tree, so nothing here would notice if it were dropped. It was dropped once,
// in the first draft of that move.
const config = require('config');
const s3     = require('../../../lib/util/storage-backend-s3');

// Signing needs credentials (the v2 SDK, without them, returned a BARE
// https://s3.amazonaws.com/ — exactly what UIndy hit, and why the redirect
// landed on the AWS marketing page rather than 404ing on a missing object).
// Give the client fake ones so these tests exercise real URL construction.
describe('the S3 backend signs download URLs', () => {
  let savedAws;
  beforeAll(() => {
    savedAws = { keyId: config.aws.keyId, key: config.aws.key, region: config.aws.region };
    Object.assign(config.aws, { keyId: 'AKIATESTTESTTESTTEST', key: 'test-secret-not-a-real-credential', region: 'us-east-1' });
  });
  afterAll(() => { Object.assign(config.aws, savedAws); });

  const realHost = process.env.S3_PUBLIC_HOST;
  const realEndpoint = config.aws && config.aws.publicEndpoint;

  beforeEach(() => {
    config.aws = config.aws || {};
  });
  afterEach(() => {
    if (realHost === undefined) delete process.env.S3_PUBLIC_HOST;
    else process.env.S3_PUBLIC_HOST = realHost;
    config.aws.publicEndpoint = realEndpoint;
  });

  it('produces a getObject URL for the requested bucket and key', async () => {
    delete process.env.S3_PUBLIC_HOST;
    config.aws.publicEndpoint = undefined;
    const url = await s3.signDownloadUrl('some-bucket', 'exports/a/b.zip', 3600);
    expect(url).toContain('some-bucket');
    expect(url).toContain('exports/a/b.zip');
  });

  it('honours S3_PUBLIC_HOST when there is no publicEndpoint', async () => {
    config.aws.publicEndpoint = undefined;
    process.env.S3_PUBLIC_HOST = 'files.example.org';
    const url = await s3.signDownloadUrl('some-bucket', 'exports/a/b.zip', 3600);
    expect(url, 'the legacy SigV2 host swap must survive the move')
      .toMatch(/^https?:\/\/files\.example\.org\//);
  });

  it('leaves the host alone when publicEndpoint is set (SigV4 signs the host)', async () => {
    config.aws.publicEndpoint = 'http://garage.example.org:3900';
    process.env.S3_PUBLIC_HOST = 'files.example.org';
    const url = await s3.signDownloadUrl('some-bucket', 'exports/a/b.zip', 3600);
    expect(url, 'rewriting the host after a SigV4 signature would invalidate it')
      .not.toContain('files.example.org');
  });
});
