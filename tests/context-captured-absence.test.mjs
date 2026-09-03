import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as nodeContext from '../dist/context.js';
import * as browserContext from '../dist/context-browser.js';
import * as workerdContext from '../dist/context-workerd.js';

function identityContext(id) {
  return {
    traceId: `trace-${id}`,
    loggedInUser: { id: `user-${id}` },
    fields: {
      'request.id': `request-${id}`,
      'user.id': `user-${id}`,
      'tenant.id': `tenant-${id}`,
    },
  };
}

const synchronousVariants = [
  ['node', nodeContext, true],
  ['browser', browserContext, true],
  ['workerd-explicit-only', workerdContext, false],
];

test('an explicitly absent captured snapshot clears and restores synchronous ambient identity', () => {
  for (const [name, context, hasAmbientFrame] of synchronousVariants) {
    context.runWithLogContext(identityContext(name), () => {
      assert.equal(
        context.currentLogRequestId(),
        hasAmbientFrame ? `request-${name}` : undefined,
      );

      context.runWithCapturedLogContext(undefined, () => {
        assert.equal(context.currentLogRequestId(), undefined, `${name} request ID`);
        assert.equal(context.currentLogUserId(), undefined, `${name} user ID`);
        assert.equal(context.currentLogTenantId(), undefined, `${name} tenant ID`);
      });

      assert.equal(
        context.currentLogRequestId(),
        hasAmbientFrame ? `request-${name}` : undefined,
        `${name} must restore its exact outer state`,
      );
    });
    assert.equal(context.currentLogRequestId(), undefined, `${name} cleanup`);
  }
});

test('native AsyncLocalStorage keeps a captured absence clear across await and restores its parent', async () => {
  await nodeContext.runWithLogContext(identityContext('node-async'), async () => {
    assert.equal(nodeContext.currentLogRequestId(), 'request-node-async');

    await nodeContext.runWithCapturedLogContext(undefined, async () => {
      assert.equal(nodeContext.currentLogRequestId(), undefined);
      await Promise.resolve();
      assert.equal(nodeContext.currentLogRequestId(), undefined);
      assert.equal(nodeContext.currentLogUserId(), undefined);
    });

    assert.equal(nodeContext.currentLogRequestId(), 'request-node-async');
    assert.equal(nodeContext.currentLogUserId(), 'user-node-async');
  });
  assert.equal(nodeContext.currentLogRequestId(), undefined);
});

test('the synchronous browser fallback cannot inherit an outer identity after await', async () => {
  let afterAwait = 'not-set';

  await browserContext.runWithLogContext(identityContext('browser-async'), () =>
    browserContext.runWithCapturedLogContext(undefined, async () => {
      assert.equal(browserContext.currentLogRequestId(), undefined);
      await Promise.resolve();
      afterAwait = browserContext.currentLogRequestId();
    }),
  );

  assert.equal(afterAwait, undefined);
  assert.equal(browserContext.currentLogRequestId(), undefined);
});

test('flagged Workerd AsyncLocalStorage keeps captured absence isolated across await', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  globalThis.AsyncLocalStorage = AsyncLocalStorage;
  try {
    const flagged = await import(`../dist/context-workerd.js?absence=${Date.now()}`);
    assert.equal(flagged.isAsyncContextTracked(), true);

    await flagged.runWithLogContext(identityContext('workerd-als'), async () => {
      assert.equal(flagged.currentLogRequestId(), 'request-workerd-als');
      await flagged.runWithCapturedLogContext(undefined, async () => {
        assert.equal(flagged.currentLogRequestId(), undefined);
        await Promise.resolve();
        assert.equal(flagged.currentLogRequestId(), undefined);
        assert.equal(flagged.currentLogUserId(), undefined);
      });
      assert.equal(flagged.currentLogRequestId(), 'request-workerd-als');
    });
  } finally {
    delete globalThis.AsyncLocalStorage;
  }
});
