import assert from 'node:assert/strict';
import test from 'node:test';

import { transitionShutdownState as productionShutdownTransition } from '../dist/server-lifecycle.js';
import { InternalDiagnosticReporter } from '../dist/internal-diagnostics.js';

import {
  checkDeliveryModel,
  checkInternalDiagnosticModel,
  checkShutdownVectors,
  deliveryTransitions,
  initialDeliveryState,
  initialInternalDiagnosticState,
  internalDiagnosticTransitions,
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

test('every shutdown transition is phase-monotone', () => {
  const rank = { running: 0, draining: 1, forced: 2, closed: 3 };
  for (const phase of Object.keys(rank)) {
    for (const event of ['trigger', 'force-now', 'mark-closed']) {
      const transition = shutdownTransition(phase, event);
      assert.ok(
        rank[transition.phase] >= rank[phase],
        `${phase}:${event} regressed to ${transition.phase}`,
      );
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

test('internal diagnostic model checks reentrancy, fallback failure, and terminal close', () => {
  const report = checkInternalDiagnosticModel();
  assert.equal(report.states, 1154);
  assert.equal(report.transitions, 2955);
  assert.ok(report.closedStates > 0);
  assert.deepEqual(report.actions, [
    'begin-close',
    'begin-report',
    'close-idle',
    'reject-closed',
    'sink-failure-next',
    'sink-success',
    'sinks-failed',
    'suppress-report',
    'suppress-saturated',
  ]);
});

test('internal diagnostic relation conserves every bounded report outcome', () => {
  const bounds = { maxReports: 5, maxSuppressed: 1 };
  const pending = [initialInternalDiagnosticState()];
  const visited = new Set();
  while (pending.length > 0) {
    const state = pending.pop();
    const key = JSON.stringify(state);
    if (visited.has(key)) continue;
    visited.add(key);
    assert.equal(
      state.reports,
      state.delivered +
        state.failed +
        state.suppressed +
        state.closedRejected +
        state.inFlight,
      key,
    );
    for (const transition of internalDiagnosticTransitions(state, bounds)) {
      pending.push(transition.state);
    }
  }
  assert.equal(visited.size, 1154);
});

test('internal diagnostic relation rejects invalid finite bounds', () => {
  assert.throws(
    () => internalDiagnosticTransitions(initialInternalDiagnosticState(), { maxReports: 1, maxSuppressed: 1 }),
    /report bound is invalid/,
  );
  assert.throws(
    () => internalDiagnosticTransitions(initialInternalDiagnosticState(), { maxReports: 5, maxSuppressed: 0 }),
    /suppression bound is invalid/,
  );
  assert.throws(
    () =>
      internalDiagnosticTransitions(initialInternalDiagnosticState(), {
        maxReports: 5,
        maxSuppressed: 1,
        maxSinks: 4,
      }),
    /sink bound is invalid/,
  );
});

test('production reporter refines fallback, suppression, and close transitions', async () => {
  const bounds = { maxReports: 5, maxSuppressed: 1, maxSinks: 3 };
  let modeled = initialInternalDiagnosticState();
  const take = (action, predicate = () => true) => {
    const transition = internalDiagnosticTransitions(modeled, bounds).find(
      (candidate) => candidate.action === action && predicate(candidate.state),
    );
    assert.ok(transition, `${action} must be enabled from ${JSON.stringify(modeled)}`);
    modeled = transition.state;
  };

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let nested;
  let reporter;
  reporter = new InternalDiagnosticReporter({
    service: 'formal-refinement',
    component: 'otel_bridge',
    now: () => new Date('2026-08-29T18:00:00.000Z'),
    sinks: [
      () => {
        nested = reporter.report({
          severity: 'error',
          operation: 'exporter_write',
          outcome: 'failed',
        });
        throw new Error('first sink fails');
      },
      () => {
        throw new Error('second sink fails');
      },
      async () => gate,
    ],
  });

  const reporting = reporter.report({
    severity: 'error',
    operation: 'exporter_write',
    outcome: 'failed',
  });
  take('begin-report', (state) => state.sinkCount === 3);
  await new Promise((resolve) => setImmediate(resolve));
  take('suppress-report');
  take('sink-failure-next');
  take('sink-failure-next');
  const closing = reporter.close();
  take('begin-close');
  assert.equal(reporter.snapshot().state, 'closing');
  release();
  assert.deepEqual(await nested, { status: 'suppressed' });
  assert.deepEqual(await reporting, { status: 'delivered', sinkIndex: 2 });
  take('sink-success');
  await closing;

  assert.equal(reporter.snapshot().state, modeled.phase);
  assert.equal(modeled.phase, 'closed');
  assert.equal(modeled.reports, 2);
  assert.equal(modeled.delivered, 1);
  assert.equal(modeled.suppressed, 1);
  assert.deepEqual(
    await reporter.report({
      severity: 'error',
      operation: 'exporter_write',
      outcome: 'failed',
    }),
    { status: 'closed' },
  );
});
