import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BACKPRESSURE_RULES,
  evaluateBackpressureReceipt,
  runBackpressureVectorSet,
  sha256,
} from '../scripts/backpressure-conformance.mjs';

async function readJson(relativeUrl) {
  const file = fileURLToPath(new URL(relativeUrl, import.meta.url));
  return JSON.parse(await readFile(file, 'utf8'));
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
  assert.deepEqual(evaluateBackpressureReceipt(receipt), { valid: true, rule: 'none' });
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

test('semantic vector corpus exercises every cross-field invariant', async () => {
  const vectors = await readJson(
    '../contracts/fixtures/valid/backpressure-conformance-vectors.json',
  );
  const result = runBackpressureVectorSet(vectors);
  assert.equal(result.total, 10);
  assert.equal(result.passed, result.total);
  assert.equal(result.failed, 0);
  assert.deepEqual(result.failures, []);

  const covered = new Set(vectors.cases.map((vector) => vector.expectedRule));
  for (const rule of BACKPRESSURE_RULES.filter((candidate) => candidate !== 'counter-domain')) {
    assert.equal(covered.has(rule), true, `missing semantic vector for ${rule}`);
  }

  const malformed = structuredClone(vectors.cases[0].receipt);
  malformed.dropped = -1;
  assert.deepEqual(
    evaluateBackpressureReceipt(malformed),
    { valid: false, rule: 'counter-domain' },
  );
});

test('backpressure vectors cannot carry credential or personal-data fields', async () => {
  const vectors = await readJson(
    '../contracts/fixtures/valid/backpressure-conformance-vectors.json',
  );
  const forbidden = /(?:authorization|cookie|password|passphrase|secret|session|token|recoverycode|apikey|clientsecret|email|phone|filepath|providerpayload)/i;
  const offending = vectors.cases.flatMap((vector) => collectKeys(vector.receipt))
    .map((key) => key.replaceAll(/[^a-z0-9]/gi, ''))
    .filter((key) => forbidden.test(key));
  assert.deepEqual(offending, []);
});

test('machine-readable conformance report binds source, runtime, schema, and vectors', async () => {
  const script = fileURLToPath(
    new URL('../scripts/run-backpressure-conformance.mjs', import.meta.url),
  );
  const root = fileURLToPath(new URL('..', import.meta.url));
  const sourceSha = '1'.repeat(40);
  const output = execFileSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ORES_OTEL_SOURCE_SHA: sourceSha },
  });
  const report = JSON.parse(output);
  const vectorBytes = await readFile(new URL(
    '../contracts/fixtures/valid/backpressure-conformance-vectors.json',
    import.meta.url,
  ));

  assert.equal(report.reportVersion, 'ores.otel.log/conformance-report/v1');
  assert.equal(report.contract, 'ores.otel.log/backpressure-result/v1');
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.vectorDigest, `sha256:${sha256(vectorBytes)}`);
  assert.equal(report.implementation.sourceSha, sourceSha);
  assert.equal(report.implementation.version, '0.1.0');
  assert.equal(report.runtime.name, 'node');
  assert.equal(report.runtime.version, process.versions.node);
  assert.deepEqual(report.results, {
    total: 10,
    passed: 10,
    failed: 0,
    failures: [],
  });
});
