import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function readJson(relativeUrl) {
  const file = fileURLToPath(new URL(relativeUrl, import.meta.url));
  return JSON.parse(await readFile(file, 'utf8'));
}

function assertBackpressureInvariants(receipt) {
  const counters = [
    receipt.capacity,
    receipt.attempted,
    receipt.accepted,
    receipt.dropped,
    receipt.queued,
    ...Object.values(receipt.dropReasons),
    receipt.shutdown.remainingQueued,
  ];
  assert.ok(counters.every(Number.isSafeInteger), 'all counters must be safe integers');
  assert.equal(receipt.accepted + receipt.dropped, receipt.attempted);
  assert.equal(
    Object.values(receipt.dropReasons).reduce((sum, count) => sum + count, 0),
    receipt.dropped,
  );
  assert.ok(receipt.queued <= receipt.capacity, 'queued work cannot exceed bounded capacity');
  assert.ok(
    receipt.shutdown.remainingQueued <= receipt.capacity,
    'shutdown remainder cannot exceed bounded capacity',
  );
  if (receipt.shutdown.completed) {
    assert.equal(receipt.shutdown.remainingQueued, 0);
    assert.equal(receipt.flush.completed, true);
    assert.equal(receipt.flush.timedOut, false);
  }
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

test('canonical backpressure fixture has lossless bounded accounting', async () => {
  const receipt = await readJson('../contracts/fixtures/valid/backpressure-result.json');
  assertBackpressureInvariants(receipt);
  assert.equal(receipt.schema, 'ores.otel.log/backpressure-result/v1');
  assert.equal(receipt.policy, 'drop-newest');
});

test('schema exposes only bounded cross-language policies', async () => {
  const schema = await readJson('../contracts/schemas/backpressure-result.schema.json');
  assert.deepEqual(schema.properties.policy.enum, [
    'drop-newest',
    'drop-oldest',
    'block-with-timeout',
    'reject',
  ]);
  assert.equal(schema.properties.capacity.minimum, 1);
  assert.equal(schema.properties.capacity.maximum, 1_000_000);
});

test('logical counter drift is rejected by the conformance invariant', async () => {
  const receipt = await readJson('../contracts/fixtures/valid/backpressure-result.json');
  receipt.dropReasons.overflow -= 1;
  assert.throws(() => assertBackpressureInvariants(receipt));
});

test('backpressure receipts cannot carry obvious credential fields', async () => {
  const receipt = await readJson('../contracts/fixtures/valid/backpressure-result.json');
  const forbidden = /^(?:authorization|cookie|password|passphrase|secret|session|token|recoveryCode)$/i;
  assert.deepEqual(collectKeys(receipt).filter((key) => forbidden.test(key)), []);
});
