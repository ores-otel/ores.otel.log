#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vectorPath = path.join(root, 'formal', 'shutdown-transitions.v1.json');
const vectorSchemaPath = path.join(
  root,
  'contracts',
  'schemas',
  'shutdown-transition-vectors.schema.json',
);

export const SHUTDOWN_PHASES = Object.freeze([
  'running',
  'draining',
  'forced',
  'closed',
]);

export const SHUTDOWN_EVENTS = Object.freeze([
  'trigger',
  'force-now',
  'mark-closed',
]);

const SHUTDOWN_TRANSITIONS = Object.freeze({
  'running:trigger': Object.freeze({ phase: 'draining', action: 'begin-graceful' }),
  'draining:trigger': Object.freeze({ phase: 'forced', action: 'force' }),
  'running:force-now': Object.freeze({ phase: 'forced', action: 'force' }),
  'draining:force-now': Object.freeze({ phase: 'forced', action: 'force' }),
  'draining:mark-closed': Object.freeze({ phase: 'closed', action: 'close' }),
});

export function shutdownTransition(phase, event) {
  if (!SHUTDOWN_PHASES.includes(phase)) {
    throw new TypeError(`unknown shutdown phase: ${phase}`);
  }
  if (!SHUTDOWN_EVENTS.includes(event)) {
    throw new TypeError(`unknown shutdown event: ${event}`);
  }

  return SHUTDOWN_TRANSITIONS[`${phase}:${event}`]
    ?? Object.freeze({ phase, action: 'ignore' });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function checkShutdownVectors() {
  const [vectors, schema] = await Promise.all([
    readJson(vectorPath),
    readJson(vectorSchemaPath),
  ]);

  assert(
    schema.$schema === 'https://json-schema.org/draft/2020-12/schema',
    'shutdown vector schema must use JSON Schema 2020-12',
  );
  assert(schema.additionalProperties === false, 'shutdown vector schema must be closed');
  assert(
    vectors.$schema === '../contracts/schemas/shutdown-transition-vectors.schema.json',
    'shutdown vectors must identify their schema',
  );
  assert(
    vectors.schema === 'ores.otel.log/shutdown-transition-vectors/v1',
    'shutdown vector contract identity drifted',
  );
  assert(vectors.machine === 'server-shutdown/v1', 'shutdown machine identity drifted');
  assert(Array.isArray(vectors.cases), 'shutdown vector cases must be an array');

  const expectedPairs = new Set(
    SHUTDOWN_PHASES.flatMap((phase) =>
      SHUTDOWN_EVENTS.map((event) => `${phase}:${event}`),
    ),
  );
  const ids = new Set();
  const pairs = new Set();

  for (const vector of vectors.cases) {
    assert(typeof vector.id === 'string' && vector.id.length > 0, 'vector id is required');
    assert(!ids.has(vector.id), `duplicate shutdown vector id: ${vector.id}`);
    ids.add(vector.id);

    const pair = `${vector.phase}:${vector.event}`;
    assert(expectedPairs.has(pair), `unknown shutdown transition pair: ${pair}`);
    assert(!pairs.has(pair), `duplicate shutdown transition pair: ${pair}`);
    pairs.add(pair);

    const actual = shutdownTransition(vector.phase, vector.event);
    assert(
      actual.phase === vector.expectedPhase,
      `${vector.id}: expected phase ${vector.expectedPhase}, received ${actual.phase}`,
    );
    assert(
      actual.action === vector.expectedAction,
      `${vector.id}: expected action ${vector.expectedAction}, received ${actual.action}`,
    );
  }

  assert(pairs.size === expectedPairs.size, 'shutdown transition relation is not exhaustive');
  for (const pair of expectedPairs) {
    assert(pairs.has(pair), `missing shutdown transition pair: ${pair}`);
  }

  return Object.freeze({ cases: pairs.size, phases: SHUTDOWN_PHASES.length });
}

export function initialDeliveryState() {
  return Object.freeze({
    phase: 'open',
    attempted: 0,
    accepted: 0,
    acknowledged: 0,
    queued: 0,
    inFlight: 0,
    overflowDropped: 0,
    transportDropped: 0,
    shutdownDropped: 0,
    retries: 0,
    flushRequested: false,
    flushed: false,
  });
}

function successor(action, state, changes) {
  return Object.freeze({ action, state: Object.freeze({ ...state, ...changes }) });
}

export function deliveryTransitions(
  state,
  { maxQueue = 2, maxAttempts = 4, maxRetries = 2 } = {},
) {
  if (
    !Number.isSafeInteger(maxQueue) || maxQueue < 1
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1
    || !Number.isSafeInteger(maxRetries) || maxRetries < 0
  ) {
    throw new TypeError('delivery model bounds are invalid');
  }

  const transitions = [];
  if (state.phase === 'open' && state.attempted < maxAttempts) {
    if (state.queued < maxQueue) {
      transitions.push(successor('enqueue-accepted', state, {
        attempted: state.attempted + 1,
        accepted: state.accepted + 1,
        queued: state.queued + 1,
      }));
    } else if (state.queued === maxQueue) {
      transitions.push(successor('enqueue-overflow', state, {
        attempted: state.attempted + 1,
        accepted: state.accepted + 1,
        overflowDropped: state.overflowDropped + 1,
      }));
    }
  }

  if (
    (state.phase === 'open' || state.phase === 'closing')
    && state.queued > 0
    && state.inFlight === 0
  ) {
    transitions.push(successor('start-send', state, {
      queued: state.queued - 1,
      inFlight: 1,
    }));
  }

  if (
    (state.phase === 'open' || state.phase === 'closing')
    && state.inFlight === 1
  ) {
    transitions.push(successor('acknowledge', state, {
      acknowledged: state.acknowledged + 1,
      inFlight: 0,
      retries: 0,
    }));
    if (state.retries < maxRetries) {
      if (state.queued < maxQueue) {
        transitions.push(successor('retry', state, {
          queued: state.queued + 1,
          inFlight: 0,
          retries: state.retries + 1,
        }));
      } else if (state.queued === maxQueue) {
        transitions.push(successor('retry-at-capacity', state, {
          inFlight: 0,
          overflowDropped: state.overflowDropped + 1,
          retries: state.retries + 1,
        }));
      }
    } else if (state.retries === maxRetries) {
      transitions.push(successor('drop-transport', state, {
        transportDropped: state.transportDropped + 1,
        inFlight: 0,
        retries: 0,
      }));
    }
  }

  if (state.phase === 'open') {
    transitions.push(successor('begin-close', state, {
      phase: 'closing',
      flushRequested: true,
    }));
  }

  if (state.phase === 'closing' && state.queued === 0 && state.inFlight === 0) {
    transitions.push(successor('finish-close', state, {
      phase: 'closed',
      flushed: true,
    }));
  }

  if (state.phase === 'closing' && state.queued + state.inFlight > 0) {
    transitions.push(successor('force-close', state, {
      phase: 'closed',
      shutdownDropped: state.shutdownDropped + state.queued + state.inFlight,
      queued: 0,
      inFlight: 0,
      retries: 0,
      flushed: true,
    }));
  }

  return Object.freeze(transitions);
}

function assertDeliveryInvariants(state, bounds, transitions) {
  const counters = [
    state.attempted,
    state.accepted,
    state.acknowledged,
    state.queued,
    state.inFlight,
    state.overflowDropped,
    state.transportDropped,
    state.shutdownDropped,
    state.retries,
  ];
  assert(counters.every((value) => Number.isSafeInteger(value) && value >= 0), 'counter domain');
  assert(['open', 'closing', 'closed'].includes(state.phase), 'phase domain');
  assert(state.inFlight === 0 || state.inFlight === 1, 'in-flight bound');
  assert(state.queued <= bounds.maxQueue, 'queue capacity');
  assert(state.retries <= bounds.maxRetries, 'retry capacity');
  assert(
    state.attempted === state.accepted,
    'attempted accounting',
  );
  assert(
    state.accepted
      === state.acknowledged
        + state.queued
        + state.inFlight
        + state.overflowDropped
        + state.transportDropped
        + state.shutdownDropped,
    'accepted accounting',
  );
  assert(!state.flushed || state.flushRequested, 'flush requires close request');

  if (state.phase !== 'open') {
    assert(
      transitions.every(({ action }) => !action.startsWith('enqueue-')),
      'admission after close request',
    );
  }
  if (state.phase === 'closed') {
    assert(state.queued === 0 && state.inFlight === 0, 'closed transport is not drained');
    assert(state.flushRequested && state.flushed, 'closed transport is not flushed');
    assert(transitions.length === 0, 'closed transport is not terminal');
  } else {
    assert(transitions.length > 0, `nonterminal deadlock in ${state.phase}`);
  }
}

function deliveryStateKey(state) {
  return JSON.stringify(state);
}

export function checkDeliveryModel(
  bounds = Object.freeze({ maxQueue: 2, maxAttempts: 4, maxRetries: 2 }),
) {
  const initial = initialDeliveryState();
  const pending = [initial];
  const visited = new Map([[deliveryStateKey(initial), initial]]);
  const actions = new Set();
  let transitionsChecked = 0;
  let terminalStates = 0;

  for (let index = 0; index < pending.length; index += 1) {
    const state = pending[index];
    const transitions = deliveryTransitions(state, bounds);
    assertDeliveryInvariants(state, bounds, transitions);
    if (state.phase === 'closed') terminalStates += 1;

    for (const transition of transitions) {
      transitionsChecked += 1;
      actions.add(transition.action);
      const key = deliveryStateKey(transition.state);
      if (!visited.has(key)) {
        visited.set(key, transition.state);
        pending.push(transition.state);
      }
    }
  }

  const expectedActions = [
    'enqueue-accepted',
    'enqueue-overflow',
    'start-send',
    'acknowledge',
    'retry',
    'retry-at-capacity',
    'drop-transport',
    'begin-close',
    'finish-close',
    'force-close',
  ];
  for (const action of expectedActions) {
    assert(actions.has(action), `unreachable delivery action: ${action}`);
  }
  assert(terminalStates > 0, 'delivery model has no terminal states');

  return Object.freeze({
    states: visited.size,
    transitions: transitionsChecked,
    terminalStates,
    actions: Object.freeze([...actions].sort()),
  });
}

export async function checkFormalModels() {
  return Object.freeze({
    shutdown: await checkShutdownVectors(),
    delivery: checkDeliveryModel(),
  });
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    process.stdout.write(`${JSON.stringify(await checkFormalModels(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
