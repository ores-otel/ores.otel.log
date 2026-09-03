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
  'currentLogRequestId',
  'currentLogTraceId',
  'currentLogUserId',
  'currentLogLoggedInUserId',
  'currentLogTenantId',
  'updateLogContext',
  'setContextLoggedInUser',
  'logContextProvider',
  'installLogContextProvider',
];

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function identityContext(id) {
  return {
    traceId: `trace-${id}`,
    loggedInUser: { id: `user-${id}` },
    fields: {
      'request.id': `request-${id}`,
      'trace.id': `field-trace-${id}`,
      'user.id': `field-user-${id}`,
      'tenant.id': `tenant-${id}`,
    },
  };
}

test('every context variant exposes the same API', () => {
  for (const [name, mod] of VARIANTS) {
    for (const key of API) {
      assert.equal(key in mod, true, `${name} context is missing "${key}"`);
    }
  }
});

test('every context variant provides canonical request identity accessors', () => {
  for (const [name, mod] of VARIANTS) {
    mod.runWithLogContext(identityContext(name), () => {
      assert.equal(mod.currentLogRequestId(), `request-${name}`);
      assert.equal(mod.currentLogTraceId(), `trace-${name}`);
      assert.equal(mod.currentLogUserId(), `user-${name}`);
      assert.equal(mod.currentLogLoggedInUserId(), `user-${name}`);
      assert.equal(mod.currentLogTenantId(), `tenant-${name}`);
    });

    mod.runWithLogContext(
      {
        fields: {
          'trace.id': `field-only-trace-${name}`,
          'user.id': `field-only-user-${name}`,
        },
      },
      () => {
        assert.equal(mod.currentLogTraceId(), `field-only-trace-${name}`);
        assert.equal(mod.currentLogUserId(), `field-only-user-${name}`);
      },
    );

    assert.equal(mod.currentLogRequestId(), undefined);
    assert.equal(mod.currentLogLoggedInUserId(), undefined);
  }
});

test('every context variant merges patches identically', () => {
  for (const [name, mod] of VARIANTS) {
    mod.runWithLogContext({ traceId: 't1', tags: ['a'], fields: { x: 1 } }, () => {
      assert.equal(mod.updateLogContext({ tags: ['a', 'b'], fields: { y: 2 } }), true, name);
      mod.setContextLoggedInUser({ id: 'u1' });

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
  // takes the same fail-closed path an unflagged Worker would.
  assert.equal(
    workerdContext.isAsyncContextTracked(),
    typeof globalThis.AsyncLocalStorage === 'function',
  );
});

test('node context isolates concurrent async flows', async () => {
  const seen = [];
  const flow = (id, delay) =>
    nodeContext.runWithLogContext(identityContext(id), async () => {
      await sleep(delay);
      seen.push([
        id,
        nodeContext.currentLogRequestId(),
        nodeContext.currentLogUserId(),
      ]);
    });

  await Promise.all([flow('a', 30), flow('b', 5)]);

  for (const [id, requestId, userId] of seen) {
    assert.equal(requestId, `request-${id}`, 'each flow must see its request ID');
    assert.equal(userId, `user-${id}`, 'each flow must see its user ID');
  }
});

test('single-frame fallback restores after sync work and fails closed after await', async () => {
  assert.equal(browserContext.getLogContext(), undefined);

  browserContext.runWithLogContext({ traceId: 'sync' }, () => {
    assert.equal(browserContext.getLogContext().traceId, 'sync');
  });
  assert.equal(browserContext.getLogContext(), undefined);

  let afterAwait;
  const asynchronous = browserContext.runWithLogContext(
    identityContext('async'),
    async () => {
      assert.equal(browserContext.currentLogRequestId(), 'request-async');
      await Promise.resolve();
      afterAwait = browserContext.currentLogRequestId();
    },
  );

  assert.equal(
    browserContext.getLogContext(),
    undefined,
    'the global frame must be restored as soon as the callback returns a Promise',
  );
  await asynchronous;
  assert.equal(afterAwait, undefined, 'untracked async continuation must fail closed');

  assert.throws(() =>
    browserContext.runWithLogContext({ traceId: 'boom' }, () => {
      throw new Error('callback failed');
    }),
  );
  assert.equal(browserContext.getLogContext(), undefined, 'a throw must not strand the frame');
});

test('browser and unflagged workerd never leak identity between overlapping promises', async () => {
  for (const [name, mod] of [
    ['browser', browserContext],
    ['unflagged-workerd', workerdContext],
  ]) {
    assert.equal(mod.isAsyncContextTracked(), false, `${name} should be untracked in this test`);
    const seen = [];

    const flow = (id, delay) =>
      mod.runWithLogContext(identityContext(id), async () => {
        assert.equal(mod.currentLogRequestId(), `request-${id}`);
        await sleep(delay);
        seen.push([id, mod.currentLogRequestId(), mod.currentLogUserId()]);
      });

    await Promise.all([flow('a', 20), flow('b', 2)]);
    for (const [id, requestId, userId] of seen) {
      assert.equal(
        requestId,
        undefined,
        `${name}/${id} must not observe a sibling request ID`,
      );
      assert.equal(
        userId,
        undefined,
        `${name}/${id} must not observe a sibling user ID`,
      );
    }
  }
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
        flagged.runWithLogContext(identityContext(id), async () => {
          await sleep(index === 0 ? 20 : 2);
          seen.push([
            id,
            flagged.currentLogRequestId(),
            flagged.currentLogUserId(),
          ]);
        }),
      ),
    );
    for (const [id, requestId, userId] of seen) {
      assert.equal(requestId, `request-${id}`, 'flagged Worker request isolation');
      assert.equal(userId, `user-${id}`, 'flagged Worker user isolation');
    }
  } finally {
    delete globalThis.AsyncLocalStorage;
  }
});
