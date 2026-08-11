import { createHash } from 'node:crypto';

export const BACKPRESSURE_CONTRACT = 'ores.otel.log/backpressure-result/v1';
export const BACKPRESSURE_VECTOR_SET = 'ores.otel.log/backpressure-vectors/v1';

export const BACKPRESSURE_RULES = Object.freeze([
  'counter-domain',
  'attempted-accounting',
  'drop-reason-accounting',
  'queue-capacity',
  'shutdown-capacity',
  'flush-state',
  'shutdown-drain',
  'shutdown-flush',
]);

function failure(rule) {
  return Object.freeze({ valid: false, rule });
}

/**
 * Evaluate the language-neutral rules that JSON Schema cannot express.
 *
 * The result deliberately contains only a stable rule identifier. It never
 * returns or serializes the receipt, so a failing adapter cannot reproduce
 * sensitive input in its conformance report.
 */
export function evaluateBackpressureReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return failure('counter-domain');
  }

  const dropReasons = receipt.dropReasons;
  const flush = receipt.flush;
  const shutdown = receipt.shutdown;
  if (
    !dropReasons || typeof dropReasons !== 'object' || Array.isArray(dropReasons)
    || !flush || typeof flush !== 'object' || Array.isArray(flush)
    || !shutdown || typeof shutdown !== 'object' || Array.isArray(shutdown)
  ) {
    return failure('counter-domain');
  }

  const counters = [
    receipt.capacity,
    receipt.attempted,
    receipt.accepted,
    receipt.dropped,
    receipt.queued,
    dropReasons.overflow,
    dropReasons.shutdown,
    dropReasons.transport,
    shutdown.remainingQueued,
  ];
  if (!counters.every((counter) => Number.isSafeInteger(counter) && counter >= 0)) {
    return failure('counter-domain');
  }
  if (receipt.capacity < 1) return failure('counter-domain');
  if (receipt.accepted + receipt.dropped !== receipt.attempted) {
    return failure('attempted-accounting');
  }
  if (
    dropReasons.overflow + dropReasons.shutdown + dropReasons.transport
    !== receipt.dropped
  ) {
    return failure('drop-reason-accounting');
  }
  if (receipt.queued > receipt.capacity) return failure('queue-capacity');
  if (shutdown.remainingQueued > receipt.capacity) return failure('shutdown-capacity');
  if (
    (flush.completed && (!flush.requested || flush.timedOut))
    || (flush.timedOut && (!flush.requested || flush.completed))
  ) {
    return failure('flush-state');
  }
  if (shutdown.completed && (receipt.queued !== 0 || shutdown.remainingQueued !== 0)) {
    return failure('shutdown-drain');
  }
  if (
    shutdown.completed
    && (!flush.requested || !flush.completed || flush.timedOut)
  ) {
    return failure('shutdown-flush');
  }
  return Object.freeze({ valid: true, rule: 'none' });
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function runBackpressureVectorSet(vectorSet) {
  if (
    !vectorSet || typeof vectorSet !== 'object'
    || vectorSet.vectorSet !== BACKPRESSURE_VECTOR_SET
    || vectorSet.contract !== BACKPRESSURE_CONTRACT
    || !Array.isArray(vectorSet.cases)
  ) {
    throw new TypeError('invalid backpressure vector-set identity');
  }

  const failures = [];
  const ids = new Set();
  for (const vector of vectorSet.cases) {
    if (ids.has(vector.id)) throw new TypeError(`duplicate vector id: ${vector.id}`);
    ids.add(vector.id);
    const actual = evaluateBackpressureReceipt(vector.receipt);
    if (actual.valid !== vector.expectedValid || actual.rule !== vector.expectedRule) {
      failures.push({
        id: vector.id,
        expectedValid: vector.expectedValid,
        actualValid: actual.valid,
        expectedRule: vector.expectedRule,
        actualRule: actual.rule,
      });
    }
  }

  return Object.freeze({
    total: vectorSet.cases.length,
    passed: vectorSet.cases.length - failures.length,
    failed: failures.length,
    failures: Object.freeze(failures),
  });
}
