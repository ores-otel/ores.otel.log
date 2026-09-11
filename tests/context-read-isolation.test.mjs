import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLogContext,
  installLogContextProvider,
  runWithLogContext,
} from '../dist/context.js';

test('getLogContext returns an isolated recursive snapshot, not the mutable store', async () => {
  const uninstall = installLogContextProvider();
  try {
    await runWithLogContext(
      {
        traceId: 'trace-read-isolation',
        loggedInUser: {
          id: 'user-read-isolation',
          claims: { tenant: 'tenant-read-isolation', scopes: ['read'] },
        },
        fields: {
          tenant: { id: 'tenant-read-isolation', regions: ['west'] },
          items: [{ id: 'item-1' }, { id: 'item-2' }],
        },
      },
      async () => {
        const first = getLogContext();
        first.traceId = 'attacker';
        first.loggedInUser.claims.tenant = 'attacker';
        first.loggedInUser.claims.scopes[0] = 'attacker';
        first.fields.tenant.id = 'attacker';
        first.fields.tenant.regions.push('attacker');
        first.fields.items[0].id = 'attacker';
        await Promise.resolve();

        const second = getLogContext();
        assert.equal(second.traceId, 'trace-read-isolation');
        assert.deepEqual(second.loggedInUser.claims, {
          tenant: 'tenant-read-isolation',
          scopes: ['read'],
        });
        assert.deepEqual(second.fields.tenant, {
          id: 'tenant-read-isolation',
          regions: ['west'],
        });
        assert.deepEqual(second.fields.items, [{ id: 'item-1' }, { id: 'item-2' }]);
      },
    );
  } finally {
    uninstall();
  }
});

test('one consumer cannot mutate context observed by a sibling callback', async () => {
  const uninstall = installLogContextProvider();
  try {
    await runWithLogContext(
      {
        traceId: 'trace-sibling-read',
        fields: { tenant: { id: 'tenant-sibling-read' }, counter: { value: 1 } },
      },
      async () => {
        const [mutator, observer] = await Promise.all([
          (async () => {
            const view = getLogContext();
            view.fields.tenant.id = 'attacker';
            view.fields.counter.value = 99;
            await new Promise(resolve => setTimeout(resolve, 5));
            return view;
          })(),
          (async () => {
            await new Promise(resolve => setTimeout(resolve, 1));
            return getLogContext();
          })(),
        ]);
        assert.equal(mutator.fields.tenant.id, 'attacker');
        assert.equal(observer.fields.tenant.id, 'tenant-sibling-read');
        assert.equal(observer.fields.counter.value, 1);
        assert.equal(getLogContext().fields.tenant.id, 'tenant-sibling-read');
      },
    );
  } finally {
    uninstall();
  }
});
