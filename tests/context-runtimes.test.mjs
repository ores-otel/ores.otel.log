import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as nodeContext from '../dist/context.js';
import * as browserContext from '../dist/context-browser.js';
import * as workerdContext from '../dist/context-workerd.js';

const VARIANTS = [
  ['node', nodeContext],
  ['browser', browserContext],
  ['workerd', workerdContext],
];

const API = [
  'logContextStorage',
  'isAsyncContextTracked',
  'runWithLogContext',
  'getLogContext',
  'updateLogContext',
  'setContextLoggedInUser',
  'logContextProvider',
  'installLogContextProvider',
];

test('every context variant exposes the same API', () => {
  for (const [name, mod] of VARIANTS) {
    for (const key of API) {
      assert.equal(key in mod, true, `${name} context is missing "${key}"`);
    }
  }
});

test('context variants merge an available ambient frame and otherwise fail closed', () => {
  for (const [name, mod] of VARIANTS) {
    mod.runWithLogContext({ traceId: 't1', tags: ['a'], fields: { x: 1 } }, () => {
      const initial = mod.getLogContext();
      if (initial === undefined) {
        assert.equal(
          mod.updateLogContext({ tags: ['a', 'b'], fields: { y: 2 } }),
          false,
          `${name} must reject mutation when no isolated ambient frame exists`,
        );
        assert.equal(
          mod.setContextLoggedInUser({ id: 'u1' }),
          false,
          `${name} must reject user mutation when no isolated ambient frame exists`,
        );
        return;
      }

      assert.equal(mod.updateLogContext({ tags: ['a', 'b'], fields: { y: 2 } }), true, name);
      assert.equal(mod.setContextLoggedInUser({ id: 'u1' }), true, name);

      const ctx = mod.getLogContext();
      assert.deepEqual(ctx.tags, ['a', 'b'], `${name} should dedupe tags`);
      assert.deepEqual(ctx.fields, { x: 1, y: 2 }, `${name} should merge fields`);
      assert.equal(ctx.traceId, 't1', name);
      assert.equal(ctx.loggedInUser.id, 'u1', name);

      // A later traceId promotes both ids into traceIds, oldest first.
      assert.equal(mod.updateLogContext({ traceId: 't2' }), true, name);
      assert.deepEqual(mod.getLogContext().traceIds, ['t1', 't2'], name);
    });
    assert.equal(mod.getLogContext(), undefined, `${name} should restore the outer frame`);
    assert.equal(mod.updateLogContext({ traceId: 'x' }), false, `${name} outside a frame`);
  }
});

test('async-context tracking is advertised honestly per runtime', () => {
  assert.equal(nodeContext.isAsyncContextTracked(), true, 'node has AsyncLocalStorage');
  assert.equal(browserContext.isAsyncContextTracked(), false, 'browsers have no ALS');
  // Under Node, globalThis.AsyncLocalStorage is absent, so the workerd build
  // takes the same degraded path an unflagged Worker would.
  assert.equal(
    workerdContext.isAsyncContextTracked(),
    typeof globalThis.AsyncLocalStorage === 'function',
  );
});

test('node context isolates concurrent async flows', async () => {
  const seen = [];
  const flow = (id, delay) =>
    nodeContext.runWithLogContext({ traceId: id }, async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      seen.push([id, nodeContext.getLogContext()?.traceId]);
    });

  await Promise.all([flow('a', 30), flow('b', 5)]);

  for (const [id, observed] of seen) {
    assert.equal(observed, id, 'each flow must see only its own context');
  }
});

test('the single-frame fallback restores context after sync and async callbacks', async () => {
  assert.equal(browserContext.getLogContext(), undefined);

  browserContext.runWithLogContext({ traceId: 'sync' }, () => {
    assert.equal(browserContext.getLogContext().traceId, 'sync');
  });
  assert.equal(browserContext.getLogContext(), undefined);

  await browserContext.runWithLogContext({ traceId: 'async' }, async () => {
    await Promise.resolve();
  });
  assert.equal(browserContext.getLogContext(), undefined);

  assert.throws(() =>
    browserContext.runWithLogContext({ traceId: 'boom' }, () => {
      throw new Error('callback failed');
    }),
  );
  assert.equal(browserContext.getLogContext(), undefined, 'a throw must not strand the frame');
});

test('the workerd build prefers a global AsyncLocalStorage when the flag is on', async () => {
  // Simulate a Worker started with compatibility_flags = ["nodejs_als"].
  const { AsyncLocalStorage } = await import('node:async_hooks');
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
  try {
    const flagged = await import(`../dist/context-workerd.js?flagged=${Date.now()}`);
    assert.equal(flagged.isAsyncContextTracked(), true);

    const seen = [];
    await Promise.all(
      ['x', 'y'].map((id, index) =>
        flagged.runWithLogContext({ traceId: id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, index === 0 ? 20 : 2));
          seen.push([id, flagged.getLogContext()?.traceId]);
        }),
      ),
    );
    for (const [id, observed] of seen) {
      assert.equal(observed, id, 'a flagged Worker must isolate concurrent requests');
    }
  } finally {
    delete globalThis.AsyncLocalStorage;
  }
});
