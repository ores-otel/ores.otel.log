import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function readJson(relativeUrl) {
  const file = fileURLToPath(new URL(relativeUrl, import.meta.url));
  return JSON.parse(await readFile(file, 'utf8'));
}

function collectKeys(value, keys = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child, keys);
    }
  }
  return keys;
}

test('execution-context fixture preserves explicit zero trace flags', async () => {
  const fixture = await readJson('../schemas/fixtures/execution-context.v1.json');
  assert.equal(Object.hasOwn(fixture, 'traceFlags'), true);
  assert.equal(fixture.traceFlags, 0);
  assert.match(fixture.traceId, /^[0-9a-f]{32}$/);
  assert.match(fixture.spanId, /^[0-9a-f]{16}$/);
  assert.notEqual(fixture.traceId, '0'.repeat(32));
  assert.notEqual(fixture.spanId, '0'.repeat(16));
});

test('execution-context fixture contains no obvious secret-bearing keys', async () => {
  const fixture = await readJson('../schemas/fixtures/execution-context.v1.json');
  const forbidden = /^(?:authorization|cookie|password|passphrase|secret|session|token|recoveryCode)$/i;
  const offending = collectKeys(fixture).filter((key) => forbidden.test(key));
  assert.deepEqual(offending, []);
});

test('shutdown conformance fixture pins interactive and non-interactive behavior', async () => {
  const fixture = await readJson('../schemas/fixtures/shutdown-conformance.v1.json');
  const names = fixture.scenarios.map((scenario) => scenario.name);
  assert.equal(new Set(names).size, names.length);

  const ctrlD = fixture.scenarios.find((scenario) => scenario.name.includes('Ctrl-D'));
  assert.ok(ctrlD);
  assert.equal(ctrlD.interactive, true);
  assert.equal(ctrlD.steps[0].input, 'signal:SIGINT');
  assert.equal(ctrlD.steps[0].expectedState, 'graceful');
  assert.equal(ctrlD.steps[1].input, 'stdin:eof');
  assert.equal(ctrlD.steps[1].expectedState, 'force');

  const nonTty = fixture.scenarios.find((scenario) => scenario.name.startsWith('non-tty'));
  assert.ok(nonTty);
  assert.equal(nonTty.interactive, false);
  assert.equal(nonTty.steps[0].input, 'signal:SIGTERM');
  assert.equal(nonTty.steps[0].expectedState, 'graceful');

  for (const scenario of fixture.scenarios) {
    assert.equal(scenario.expectedFlushCalls, 1, scenario.name);
    assert.equal(scenario.steps.at(-1).expectedState, 'complete', scenario.name);
  }
});
