'use strict';
// Each v3 S3Client owns its own keep-alive connection pool, so config/aws.js
// hands out one client per effective configuration instead of a new one per
// call; a change to config.aws (the garage profile, tests) still gets its own.
const config = require('config');
const aws    = require('../../config/aws');

describe('aws.s3Client', () => {
  let saved;
  beforeEach(() => { saved = { region: config.aws.region, endpoint: config.aws.endpoint }; });
  afterEach(() => { Object.assign(config.aws, saved); });

  it('reuses one client for the same configuration', () => {
    expect(aws.s3Client()).toBe(aws.s3Client());
    expect(aws.s3Client({ endpoint: 'https://files.example.org' }))
      .toBe(aws.s3Client({ endpoint: 'https://files.example.org' }));
  });

  it('gives a different configuration its own client', () => {
    const plain = aws.s3Client();
    expect(aws.s3Client({ endpoint: 'https://files.example.org' })).not.toBe(plain);
    config.aws.region = 'eu-west-1';
    expect(aws.s3Client()).not.toBe(plain);
  });
});
