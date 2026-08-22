import assert from 'node:assert/strict';
import test from 'node:test';

import { transitionShutdownState as productionShutdownTransition } from '../dist/server-lifecycle.js';

import {
  checkDeliveryModel,
  checkShutdownVectors,
  deliveryTransitions,
  initialDeliveryState,
  shutdownTransition,
} from '../scripts/check-formal-model.mjs';

test('shutdown relation is total across the shared transition vectors', async () => {
  const report = await checkShutdownVectors();
  assert.deepEqual(report, { cases: 12, phases: 4 });
});

test('TypeScript shutdown implementation refines the executable model', () => {
  for (const phase of ['running', 'draining', 'forced', 'closed']) {
    for (const event of ['trigger', 'force-now', 'mark-closed']) {
      assert.deepEqual(
        productionShutdownTransition(phase, event),
        shutdownTransition(phase, event),
        `${phase}:${event}`,
      );
    }
  }
});

test('shutdown terminal phases ignore every external transition', () => {
  for (const phase of ['forced', 'closed']) {
    for (const event of ['trigger', 'force-now', 'mark-closed']) {
      assert.deepEqual(shutdownTransition(phase, event), {
        phase,
        action: 'ignore',
      });
    }
  }
});

test('delivery explicit-state model checks all loss and close paths', () => {
  const report = checkDeliveryModel();
  assert.ok(report.states > 100);
  assert.ok(report.transitions > report.states);
  assert.ok(report.terminalStates > 0);
  assert.deepEqual(report.actions, [
    'acknowledge',
    'begin-close',
    'drop-transport',
    'enqueue-accepted',
    'enqueue-overflow',
    'finish-close',
    'force-close',
    'retry',
    'retry-at-capacity',
    'start-send',
  ]);
});

test('delivery relation rejects invalid model bounds', () => {
  assert.throws(
    () => deliveryTransitions(initialDeliveryState(), { maxQueue: 0 }),
    /bounds are invalid/,
  );
});
