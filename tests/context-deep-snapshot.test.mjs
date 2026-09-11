import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLogContext,
  installLogContextProvider,
  runWithLogContext,
  updateLogContext,
} from '../dist/context.js';

test('runWithLogContext recursively snapshots nested caller-owned values', async () => {
  const uninstall = installLogContextProvider();
  try {
    const source = {
      loggedInUser: {
        id: 'user-1',
        profile: { roles: ['reader'], preferences: { locale: 'en' } },
      },
      traceId: 'trace-1',
      fields: {
        tenant: { id: 'tenant-1', regions: ['west'] },
        request: { id: 'request-1', retry: { attempt: 1 } },
      },
      tags: ['outer'],
    };

    await runWithLogContext(source, async () => {
      source.loggedInUser.profile.roles.push('admin');
      source.loggedInUser.profile.preferences.locale = 'attacker';
      source.fields.tenant.id = 'attacker';
      source.fields.tenant.regions.push('east');
      source.fields.request.retry.attempt = 99;
      source.tags.push('attacker');
      await Promise.resolve();

      const observed = getLogContext();
      assert.deepEqual(observed.loggedInUser.profile, {
        roles: ['reader'],
        preferences: { locale: 'en' },
      });
      assert.deepEqual(observed.fields.tenant, { id: 'tenant-1', regions: ['west'] });
      assert.deepEqual(observed.fields.request, { id: 'request-1', retry: { attempt: 1 } });
      assert.deepEqual(observed.tags, ['outer']);
    });
    assert.equal(getLogContext(), undefined);
  } finally {
    uninstall();
  }
});

test('updateLogContext recursively snapshots nested patch values', async () => {
  const uninstall = installLogContextProvider();
  try {
    await runWithLogContext({ traceId: 'trace-update' }, async () => {
      const patch = {
        fields: {
          tenant: { id: 'tenant-update', limits: { requests: 10 } },
          list: [{ id: 1 }, { id: 2 }],
        },
        loggedInUser: { id: 'user-update', claims: { groups: ['one'] } },
      };
      assert.equal(updateLogContext(patch), true);
      patch.fields.tenant.id = 'attacker';
      patch.fields.tenant.limits.requests = -1;
      patch.fields.list[0].id = -1;
      patch.loggedInUser.claims.groups.push('attacker');
      await Promise.resolve();

      const observed = getLogContext();
      assert.deepEqual(observed.fields.tenant, {
        id: 'tenant-update',
        limits: { requests: 10 },
      });
      assert.deepEqual(observed.fields.list, [{ id: 1 }, { id: 2 }]);
      assert.deepEqual(observed.loggedInUser.claims.groups, ['one']);
    });
  } finally {
    uninstall();
  }
});

test('nested recursive snapshots isolate sibling tenant mutations', async () => {
  const uninstall = installLogContextProvider();
  try {
    const results = await Promise.all(
      Array.from({ length: 128 }, (_, index) => {
        const source = {
          traceId: `trace-${index}`,
          loggedInUser: {
            id: `user-${index}`,
            claims: { tenant: `tenant-${index}`, scopes: [`scope-${index}`] },
          },
          fields: {
            tenant: { id: `tenant-${index}` },
            request: { id: `request-${index}` },
          },
        };
        const operation = runWithLogContext(source, async () => {
          await new Promise(resolve => setTimeout(resolve, index % 7));
          const observed = getLogContext();
          return {
            traceId: observed.traceId,
            tenant: observed.fields.tenant.id,
            request: observed.fields.request.id,
            claim: observed.loggedInUser.claims.tenant,
          };
        });
        source.loggedInUser.claims.tenant = 'attacker';
        source.loggedInUser.claims.scopes[0] = 'attacker';
        source.fields.tenant.id = 'attacker';
        source.fields.request.id = 'attacker';
        return operation;
      }),
    );

    for (let index = 0; index < results.length; index += 1) {
      assert.deepEqual(results[index], {
        traceId: `trace-${index}`,
        tenant: `tenant-${index}`,
        request: `request-${index}`,
        claim: `tenant-${index}`,
      });
    }
    assert.equal(getLogContext(), undefined);
  } finally {
    uninstall();
  }
});

test('recursive snapshots preserve cycles without retaining caller aliases', async () => {
  const uninstall = installLogContextProvider();
  try {
    const cyclic = { id: 'cycle' };
    cyclic.self = cyclic;
    await runWithLogContext({ fields: { cyclic } }, async () => {
      cyclic.id = 'attacker';
      assert.equal(getLogContext().fields.cyclic.id, 'cycle');
      assert.equal(getLogContext().fields.cyclic.self, getLogContext().fields.cyclic);
    });
  } finally {
    uninstall();
  }
});
