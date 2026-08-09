import assert from 'node:assert/strict';
import { test } from 'node:test';

// Use the package self-reference instead of a relative dist path. This is the
// same root module r2g phase-S loads after installing the packed tarball.
import rootLogger, { base, r2gSmokeTest } from '@oresoftware/next-loggers';

test('the packed package root exposes r2g phase-S as a flat function', async () => {
  assert.equal(typeof r2gSmokeTest, 'function');
  assert.equal(r2gSmokeTest, base.r2gSmokeTest);
  assert.equal(await r2gSmokeTest(), true);
  await rootLogger.close();
});
