import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';
import { createBunLogger } from '@oresoftware/next-loggers/bun';
import { createDenoLogger } from '@oresoftware/next-loggers/deno';
import { createEdgeLogger } from '@oresoftware/next-loggers/edge';
import { createCloudflareWorkerLogger } from '@oresoftware/next-loggers/cloudflare';
import { createNodeLogger } from '@oresoftware/next-loggers/node';
import {
  getLogContext,
  installLogContextProvider,
  runWithLogContext,
  updateLogContext,
  setContextLoggedInUser,
} from '@oresoftware/next-loggers/context';

const makeMemoryLogger = (options = {}) => {
  const records = [];
  const logger = createLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
    ...options,
  });
  return { logger, records };
};

test('installed ALS context flows into records and uninstalls cleanly', async () => {
  const uninstall = installLogContextProvider();
  try {
    const { logger, records } = makeMemoryLogger();
    await runWithLogContext(
      {
        loggedInUser: { id: 'user-9', email: 'nine@example.test' },
        traceId: 'req-123',
        fields: { route: '/checkout' },
        tags: ['request'],
      },
      async () => {
        await logger.info('inside request').send();
      },
    );
    await logger.info('outside request').send();

    assert.equal(records.length, 2);
    assert.equal(records[0].loggedInUser.id, 'user-9');
    assert.equal(records[0].traceId, 'req-123');
    assert.deepEqual(records[0].traceIds, ['req-123']);
    assert.equal(records[0].fields.route, '/checkout');
    assert.deepEqual(records[0].tags, ['request']);
    assert.equal(records[1].loggedInUser, undefined);
    assert.equal(records[1].traceId, undefined);
  } finally {
    uninstall();
  }
  const { logger, records } = makeMemoryLogger();
  await runWithLogContext({ traceId: 'ignored-after-uninstall' }, async () => {
    await logger.info('provider uninstalled').send();
  });
  assert.equal(records[0].traceId, undefined);
});

test('event-level calls take precedence over ambient context', async () => {
  const uninstall = installLogContextProvider();
  try {
    const { logger, records } = makeMemoryLogger();
    await runWithLogContext(
      { loggedInUser: { id: 'ambient' }, traceId: 'ambient-trace', fields: { source: 'ambient' } },
      async () => {
        await logger
          .warn('explicit wins')
          .addLoggedInUserId('explicit')
          .addTrace('explicit-trace')
          .addFields({ source: 'event' })
          .send();
      },
    );
    assert.equal(records[0].loggedInUser.id, 'explicit');
    assert.equal(records[0].traceId, 'explicit-trace');
    assert.deepEqual(records[0].traceIds.sort(), ['ambient-trace', 'explicit-trace']);
    assert.equal(records[0].fields.source, 'event');
  } finally {
    uninstall();
  }
});

test('concurrent async flows keep isolated contexts', async () => {
  const uninstall = installLogContextProvider();
  try {
    const { logger, records } = makeMemoryLogger();
    await Promise.all(
      Array.from({ length: 25 }, async (_, index) =>
        runWithLogContext({ traceId: `trace-${index}`, loggedInUser: { id: `user-${index}` } }, async () => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
          updateLogContext({ fields: { step: index } });
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));
          await logger.info(`task ${index}`).send();
        }),
      ),
    );
    assert.equal(records.length, 25);
    for (const record of records) {
      const index = Number(record.message.split(' ')[1]);
      assert.equal(record.traceId, `trace-${index}`);
      assert.equal(record.loggedInUser.id, `user-${index}`);
      assert.equal(record.fields.step, index);
    }
  } finally {
    uninstall();
  }
});

test('updateLogContext merges instead of replacing and reports inactivity', () => {
  assert.equal(updateLogContext({ traceId: 'nowhere' }), false);
  runWithLogContext({ traceId: 'a', tags: ['one'] }, () => {
    assert.equal(setContextLoggedInUser({ id: 'late-user' }), true);
    assert.equal(updateLogContext({ traceIds: ['b'], tags: ['two', 'one'] }), true);
    const context = getLogContext();
    assert.equal(context.loggedInUser.id, 'late-user');
    assert.deepEqual(context.traceIds.sort(), ['a', 'b']);
    assert.deepEqual(context.tags.sort(), ['one', 'two']);
  });
});

test('setALS attaches a custom AsyncLocalStorage with validation and selector', async () => {
  const storage = new AsyncLocalStorage();
  const { logger, records } = makeMemoryLogger();
  assert.throws(() => logger.setALS({}), /getStore/);
  assert.throws(() => logger.setALS(storage, 'not-a-function'), /select/);

  logger.setALS(storage, (store) => ({
    loggedInUser: { id: store.userId },
    traceId: store.requestId,
  }));
  await storage.run({ userId: 'als-user', requestId: 'als-request' }, async () => {
    await logger.info('selected store').send();
  });
  assert.equal(records[0].loggedInUser.id, 'als-user');
  assert.equal(records[0].traceId, 'als-request');

  const child = logger.anew({});
  await storage.run({ userId: 'child-user', requestId: 'child-request' }, async () => {
    await child.info('child inherits ALS').send();
  });
  const childRecord = records.find((record) => record.message === 'child inherits ALS');
  assert.equal(childRecord.loggedInUser.id, 'child-user');

  logger.setContextProvider(null);
  await storage.run({ userId: 'gone' }, async () => {
    await logger.info('detached').send();
  });
  const detached = records.find((record) => record.message === 'detached');
  assert.equal(detached.loggedInUser, undefined);
});

test('a throwing context provider never blocks logging', async () => {
  const { logger, records } = makeMemoryLogger({
    contextProvider: () => {
      throw new Error('context lookup failed');
    },
  });
  await logger.error('still delivered').send();
  assert.equal(records.length, 1);
  assert.equal(records[0].message, 'still delivered');
});

test('record shape is consistent across every runtime logger', async () => {
  const clock = () => new Date('2026-03-04T05:06:07.000Z');
  const idFactory = () => 'fixed-id';
  const factories = {
    base: (transports) => createLogger({ console: false, transports, clock, idFactory }),
    browser: (transports) =>
      createBrowserLogger({ console: false, transports, clock, idFactory, flushOnUnload: false }),
    edge: (transports) => createEdgeLogger({ console: false, transports, clock, idFactory }),
    cloudflare: (transports) =>
      createCloudflareWorkerLogger({ console: false, transports, clock, idFactory }),
    node: (transports) =>
      createNodeLogger({ console: false, transports, clock, idFactory, flushOnShutdown: false }),
    bun: (transports) =>
      createBunLogger({ console: false, transports, clock, idFactory, flushOnShutdown: false }),
    deno: (transports) =>
      createDenoLogger({ console: false, transports, clock, idFactory, flushOnUnload: false }),
  };

  const byRuntime = {};
  for (const [runtime, make] of Object.entries(factories)) {
    const records = [];
    const logger = make({ write: (record) => void records.push(record) });
    await logger
      .warn('consistency probe', 7)
      .addTrace('trace-x')
      .addTags('tag-a')
      .send();
    await logger.close();
    byRuntime[runtime] = records[0];
  }

  const reference = byRuntime.base;
  for (const [runtime, record] of Object.entries(byRuntime)) {
    assert.equal(record.schema, 'next-loggers/v1', runtime);
    assert.equal(record.runtime, runtime === 'base' ? 'base' : runtime);
    assert.deepEqual(Object.keys(record), Object.keys(reference), `key order differs for ${runtime}`);
    assert.equal(record.timestamp, reference.timestamp, runtime);
    assert.equal(record.message, reference.message, runtime);
    assert.deepEqual(record.values, reference.values, runtime);
    assert.deepEqual(record.traceIds, reference.traceIds, runtime);
    assert.deepEqual(record.tags, reference.tags, runtime);
    assert.equal(typeof record.fields, 'object', runtime);
    assert.equal(JSON.parse(JSON.stringify(record)) instanceof Object, true, runtime);
  }
});

test('browser fallback restores frames around sync, async, and throwing callbacks', async () => {
  const browserContext = await import('../dist/context-browser.js');

  const syncResult = browserContext.runWithLogContext({ traceId: 'sync' }, () => {
    assert.equal(browserContext.getLogContext().traceId, 'sync');
    return 'done';
  });
  assert.equal(syncResult, 'done');
  assert.equal(browserContext.getLogContext(), undefined);

  await browserContext.runWithLogContext({ traceId: 'async' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(browserContext.getLogContext().traceId, 'async');
    assert.equal(browserContext.updateLogContext({ fields: { late: true } }), true);
    assert.equal(browserContext.getLogContext().fields.late, true);
  });
  assert.equal(browserContext.getLogContext(), undefined);

  assert.throws(() =>
    browserContext.runWithLogContext({ traceId: 'boom' }, () => {
      throw new Error('sync failure');
    }),
  );
  assert.equal(browserContext.getLogContext(), undefined);

  const uninstall = browserContext.installLogContextProvider();
  try {
    const { logger, records } = makeMemoryLogger();
    await browserContext.runWithLogContext({ loggedInUser: { id: 'browser-user' } }, async () => {
      await logger.info('browser frame').send();
    });
    assert.equal(records[0].loggedInUser.id, 'browser-user');
  } finally {
    uninstall();
  }
});

test('performance: ALS context adds acceptable overhead per record', async () => {
  const uninstall = installLogContextProvider();
  try {
    const sink = { write: () => undefined };
    const logger = createLogger({ console: false, transports: sink });
    const COUNT = 5_000;

    const baselineStart = process.hrtime.bigint();
    for (let index = 0; index < COUNT; index += 1) {
      await logger.info('baseline', index).send();
    }
    const baselineMillis = Number(process.hrtime.bigint() - baselineStart) / 1e6;

    const contextStart = process.hrtime.bigint();
    await runWithLogContext(
      { loggedInUser: { id: 'perf-user' }, traceId: 'perf-trace', fields: { load: true } },
      async () => {
        for (let index = 0; index < COUNT; index += 1) {
          await logger.info('with context', index).send();
        }
      },
    );
    const contextMillis = Number(process.hrtime.bigint() - contextStart) / 1e6;

    // Generous CI-safe bounds: both loops must be fast in absolute terms, and
    // context lookup must not blow up relative cost by an order of magnitude.
    assert.equal(
      contextMillis < 5_000,
      true,
      `context loop took ${contextMillis.toFixed(1)}ms for ${COUNT} records`,
    );
    assert.equal(
      contextMillis < Math.max(baselineMillis * 10, 1_000),
      true,
      `context overhead too high: baseline ${baselineMillis.toFixed(1)}ms vs context ${contextMillis.toFixed(1)}ms`,
    );
  } finally {
    uninstall();
  }
});

test('performance: getStore lookups are cheap even when no frame is active', () => {
  const start = process.hrtime.bigint();
  for (let index = 0; index < 100_000; index += 1) {
    getLogContext();
  }
  const millis = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(millis < 500, true, `100k getLogContext() calls took ${millis.toFixed(1)}ms`);
});
