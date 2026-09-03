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
  'runWithMergedLogContext',
  'getLogContext',
  'currentLogRequestId',
  'currentLogTraceId',
  'currentLogUserId',
  'currentLogLoggedInUserId',
  'currentLogTenantId',
  'captureLogContext',
  'runWithCapturedLogContext',
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

test('tracked and synchronous variants provide canonical request identity accessors', () => {
  for (const [name, mod] of [
    ['node', nodeContext],
    ['browser', browserContext],
  ]) {
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

test('context variants merge an available frame and otherwise fail closed', () => {
  for (const [name, mod] of VARIANTS) {
    mod.runWithLogContext({ traceId: 't1', tags: ['a'], fields: { x: 1 } }, () => {
      const initial = mod.getLogContext();
      if (initial === undefined) {
        assert.equal(
          mod.updateLogContext({ tags: ['a', 'b'], fields: { y: 2 } }),
          false,
          `${name} must reject mutation without an isolated ambient frame`,
        );
        assert.equal(
          mod.setContextLoggedInUser({ id: 'u1' }),
          false,
          `${name} must reject user mutation without an isolated ambient frame`,
        );
        assert.equal(mod.captureLogContext(), undefined);
        return;
      }

      assert.equal(mod.updateLogContext({ tags: ['a', 'b'], fields: { y: 2 } }), true, name);
      assert.equal(mod.setContextLoggedInUser({ id: 'u1' }), true, name);

      const context = mod.getLogContext();
      assert.deepEqual(context.tags, ['a', 'b'], `${name} should dedupe tags`);
      assert.deepEqual(context.fields, { x: 1, y: 2 }, `${name} should merge fields`);
      assert.equal(context.traceId, 't1', name);
      assert.equal(context.loggedInUser.id, 'u1', name);

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

test('browser fallback supports synchronous lookup and fails closed after await', async () => {
  assert.equal(browserContext.getLogContext(), undefined);

  browserContext.runWithLogContext(identityContext('sync'), () => {
    assert.equal(browserContext.currentLogRequestId(), 'request-sync');
    assert.equal(browserContext.currentLogUserId(), 'user-sync');
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

test('overlapping browser promises never observe a sibling identity', async () => {
  const seen = [];
  const flow = (id, delay) =>
    browserContext.runWithLogContext(identityContext(id), async () => {
      assert.equal(browserContext.currentLogRequestId(), `request-${id}`);
      await sleep(delay);
      seen.push([
        id,
        browserContext.currentLogRequestId(),
        browserContext.currentLogUserId(),
      ]);
    });

  await Promise.all([flow('a', 20), flow('b', 2)]);
  for (const [id, requestId, userId] of seen) {
    assert.equal(requestId, undefined, `browser/${id} must not observe a sibling request ID`);
    assert.equal(userId, undefined, `browser/${id} must not observe a sibling user ID`);
  }
});

test('unflagged workerd is explicit-only before and after async boundaries', async () => {
  assert.equal(workerdContext.isAsyncContextTracked(), false);
  const seen = [];
  const flow = (id, delay) =>
    workerdContext.runWithLogContext(identityContext(id), async () => {
      assert.equal(workerdContext.getLogContext(), undefined);
      assert.equal(workerdContext.currentLogRequestId(), undefined);
      assert.equal(workerdContext.currentLogUserId(), undefined);
      assert.equal(workerdContext.currentLogTenantId(), undefined);
      await sleep(delay);
      seen.push([
        id,
        workerdContext.currentLogRequestId(),
        workerdContext.currentLogUserId(),
      ]);
    });

  await Promise.all([flow('a', 20), flow('b', 2)]);
  for (const [id, requestId, userId] of seen) {
    assert.equal(requestId, undefined, `workerd/${id} must not expose ambient request ID`);
    assert.equal(userId, undefined, `workerd/${id} must not expose ambient user ID`);
  }
});

test('the workerd build prefers a global AsyncLocalStorage when the flag is on', async () => {
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
