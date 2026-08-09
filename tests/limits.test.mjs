import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createLogger,
  DEFAULT_SERIALIZE_LIMITS,
  serializeLogValue,
} from '@oresoftware/next-loggers/base';

test('long strings are truncated with a visible marker', () => {
  const huge = 'x'.repeat(DEFAULT_SERIALIZE_LIMITS.maxStringLength + 500);
  const serialized = serializeLogValue(huge);
  assert.equal(typeof serialized, 'string');
  assert.match(serialized, /…\[truncated 500 chars\]$/);
  assert.equal(
    serialized.length,
    DEFAULT_SERIALIZE_LIMITS.maxStringLength + '…[truncated 500 chars]'.length,
  );
});

test('short strings are untouched', () => {
  assert.equal(serializeLogValue('hello'), 'hello');
});

test('deep nesting stops at the depth limit instead of recursing forever', () => {
  let deep = { end: true };
  for (let i = 0; i < 50; i += 1) {
    deep = { nested: deep };
  }
  const serialized = serializeLogValue(deep, { maxDepth: 3 });
  assert.equal(serialized.nested.nested.nested, '[Max depth 3 exceeded]');
});

test('a self-reference still reports Circular rather than a depth marker', () => {
  const circular = { name: 'root' };
  circular.self = circular;
  assert.equal(serializeLogValue(circular).self, '[Circular]');
});

test('large arrays are capped and report how many were dropped', () => {
  const serialized = serializeLogValue(Array.from({ length: 10 }, (_, i) => i), {
    maxArrayLength: 4,
  });
  assert.deepEqual(serialized, [0, 1, 2, 3, '[+6 more of 10]']);
});

test('large Sets and Maps are capped too', () => {
  const set = serializeLogValue(new Set([1, 2, 3, 4, 5]), { maxArrayLength: 2 });
  assert.deepEqual(set, [1, 2, '[+3 more of 5]']);

  const map = serializeLogValue(new Map([['a', 1], ['b', 2], ['c', 3]]), { maxArrayLength: 2 });
  assert.deepEqual(map, [['a', 1], ['b', 2], '[+1 more of 3]']);
});

test('objects with many properties are capped and counted', () => {
  const wide = {};
  for (let i = 0; i < 10; i += 1) {
    wide[`k${i}`] = i;
  }
  const serialized = serializeLogValue(wide, { maxProperties: 3 });
  assert.deepEqual(Object.keys(serialized), ['k0', 'k1', 'k2', '__truncatedKeys']);
  assert.equal(serialized.__truncatedKeys, 7);
});

test('error messages and stacks are truncated as well', () => {
  const error = new Error('e'.repeat(500));
  const serialized = serializeLogValue(error, { maxStringLength: 100 });
  assert.match(serialized.message, /…\[truncated 400 chars\]$/);
  assert.equal(serialized.name, 'Error');
});

test('a record built from an oversized payload stays serializable', async () => {
  const records = [];
  const logger = createLogger({
    console: false,
    limits: { maxStringLength: 50, maxArrayLength: 5 },
    transports: { write: (record) => void records.push(record) },
  });

  await logger.info('big', { blob: 'y'.repeat(5_000), list: Array.from({ length: 500 }, (_, i) => i) }).send();

  const [record] = records;
  const payload = record.values[1];
  assert.match(payload.blob, /^y{50}…\[truncated 4950 chars\]$/);
  assert.equal(payload.list.length, 6);
  assert.equal(payload.list[5], '[+495 more of 500]');
  // The whole record must still round-trip through JSON for any transport.
  assert.equal(typeof JSON.stringify(record), 'string');
  await logger.close();
});

test('limits are configurable per logger and inherited by anew children', async () => {
  const records = [];
  const parent = createLogger({
    console: false,
    limits: { maxStringLength: 10 },
    transports: { write: (record) => void records.push(record) },
  });
  const child = parent.anew({});

  await child.info('z'.repeat(100)).send();
  assert.match(records[0].values[0], /^z{10}…\[truncated 90 chars\]$/);
  await parent.close();
});
