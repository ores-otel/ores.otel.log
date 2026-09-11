import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLogContext,
  installLogContextProvider,
  runWithLogContext,
} from '../dist/context.js';

test('context snapshots clone supported structured values without rejecting opaque values', async () => {
  const uninstall = installLogContextProvider();
  try {
    const date = new Date('2026-01-02T03:04:05.000Z');
    const map = new Map([['tenant', { id: 'tenant-map' }]]);
    const set = new Set([{ id: 'set-item' }, 'stable']);
    const bytes = new Uint8Array([1, 2, 3]);
    const error = new Error('context error');
    error.details = { code: 'E_CONTEXT' };
    const opaqueFunction = () => 'opaque';

    await runWithLogContext(
      {
        traceId: 'trace-types',
        fields: { date, map, set, bytes, error, opaqueFunction },
      },
      async () => {
        date.setUTCFullYear(1999);
        map.get('tenant').id = 'attacker';
        map.set('attacker', { id: 'attacker' });
        for (const item of set) {
          if (item && typeof item === 'object') item.id = 'attacker';
        }
        set.add('attacker');
        bytes[0] = 255;
        error.details.code = 'ATTACKER';
        await Promise.resolve();

        const observed = getLogContext().fields;
        assert.equal(observed.date.toISOString(), '2026-01-02T03:04:05.000Z');
        assert.equal(observed.map.get('tenant').id, 'tenant-map');
        assert.equal(observed.map.has('attacker'), false);
        assert.equal([...observed.set].some(value => value === 'attacker'), false);
        assert.equal([...observed.set].find(value => value && typeof value === 'object').id, 'set-item');
        assert.deepEqual([...observed.bytes], [1, 2, 3]);
        assert.equal(observed.error.message, 'context error');
        assert.equal(observed.error.details.code, 'E_CONTEXT');
        assert.equal(observed.opaqueFunction, opaqueFunction);
        assert.equal(observed.opaqueFunction(), 'opaque');
      },
    );
  } finally {
    uninstall();
  }
});

test('context snapshots preserve shared references within a snapshot but detach from the caller', async () => {
  const uninstall = installLogContextProvider();
  try {
    const shared = { id: 'shared' };
    const source = {
      fields: {
        first: shared,
        second: shared,
        list: [shared],
      },
    };
    await runWithLogContext(source, async () => {
      shared.id = 'attacker';
      const observed = getLogContext().fields;
      assert.equal(observed.first.id, 'shared');
      assert.equal(observed.first, observed.second);
      assert.equal(observed.first, observed.list[0]);
    });
  } finally {
    uninstall();
  }
});
