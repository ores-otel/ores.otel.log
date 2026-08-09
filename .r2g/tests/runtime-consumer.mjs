#!/usr/bin/env node
// Runtime-agnostic downstream test: runs under Node (phase-T) and under any
// phase-C container runtime (node, bun, deno) against the installed package.
import assert from 'node:assert/strict';

// r2g phase-S is a Node consumer and requires the package root to expose
// r2gSmokeTest directly. A namespace import keeps this phase-T fixture usable
// under Bun and Deno too, where only the shared `base` namespace is promised.
import rootLogger, * as root from '@oresoftware/next-loggers';
import { createLogger } from '@oresoftware/next-loggers/base';
import {
  installLogContextProvider,
  runWithLogContext,
} from '@oresoftware/next-loggers/context';

const { base } = root;
const isBun = typeof globalThis.Bun !== 'undefined';
const isDeno = typeof globalThis.Deno !== 'undefined';
const expectedRuntime = isBun ? 'bun' : isDeno ? 'deno' : 'node';
const label = `[runtime-consumer:${expectedRuntime}]`;

assert.equal(rootLogger.runtime, expectedRuntime, `expected runtime ${expectedRuntime}`);

const records = [];
const logger = createLogger({
  console: false,
  transports: { write: (record) => void records.push(record) },
});

const uninstall = installLogContextProvider();
try {
  await runWithLogContext(
    { loggedInUser: { id: 'phase-c-user' }, traceId: 'phase-c-trace' },
    async () => {
      await logger
        .error('containerized delivery', { password: 'should-hide', attempt: 1 })
        .addTags('phase-c')
        .send();
    },
  );
} finally {
  uninstall();
}

assert.equal(records.length, 1);
assert.equal(records[0].loggedInUser.id, 'phase-c-user');
assert.equal(records[0].traceId, 'phase-c-trace');
assert.equal(records[0].values[1].password, '[REDACTED]');
assert.equal(records[0].values[1].attempt, 1);

const attempts = [];
const tracked = createLogger({ console: false }).setErrorTrackingUrl(
  'https://primary.invalid/collect',
  {
    fallbackUrl: 'https://fallback.invalid/exec',
    fetch: async (url) => {
      attempts.push(url);
      return url.startsWith('https://primary')
        ? new Response(null, { status: 500, statusText: 'down' })
        : new Response(null, { status: 200 });
    },
  },
);
await tracked.error('tracked in container').send();
assert.deepEqual(attempts, ['https://primary.invalid/collect', 'https://fallback.invalid/exec']);

if (expectedRuntime === 'node') {
  assert.equal(typeof root.r2gSmokeTest, 'function');
  assert.equal(root.r2gSmokeTest, base.r2gSmokeTest);
  assert.equal(await root.r2gSmokeTest(), true);
} else {
  assert.equal(await base.r2gSmokeTest(), true);
}
await logger.close();
await tracked.close();
await rootLogger.close();
console.log(`${label} passed`);
