import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import { createWasmLoggerHost } from '@oresoftware/next-loggers/wasm';

function memoryLogger(options = {}) {
  const records = [];
  const logger = createLogger({
    appName: 'wasm-matrix',
    maxLevel: 'TRACE',
    console: false,
    transports: {
      name: 'memory',
      write(value) {
        records.push(value);
      },
    },
    ...options,
  });
  return { logger, records };
}

function put(memory, offset, value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  new Uint8Array(memory.buffer).set(bytes, offset);
  return bytes;
}

test('host requires a next-loggers logger', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  assert.throws(
    () => createWasmLoggerHost(undefined, { memory }),
    /requires a next-loggers logger/,
  );
  assert.throws(
    () => createWasmLoggerHost({}, { memory }),
    /requires a next-loggers logger/,
  );
});

test('host requires WebAssembly memory configuration', () => {
  const { logger } = memoryLogger();
  assert.throws(
    () => createWasmLoggerHost(logger, {}),
    /requires WebAssembly memory/,
  );
});

test('memory getters returning the wrong type produce a deterministic ABI error', async () => {
  const { logger, records } = memoryLogger();
  const diagnostics = [];
  const host = createWasmLoggerHost(logger, {
    memory: () => ({ buffer: new ArrayBuffer(8) }),
    onDecodeError: (error) => diagnostics.push(error),
  });
  assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 0), -1);
  await host.flush();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0] instanceof TypeError, true);
  assert.match(diagnostics[0].message, /did not return WebAssembly.Memory/);
  assert.equal(records.length, 1);
});

test('throwing memory getters cannot throw through the WASM ABI', async () => {
  const { logger, records } = memoryLogger();
  const host = createWasmLoggerHost(logger, {
    memory() {
      throw new Error('memory unavailable');
    },
  });
  assert.doesNotThrow(() => {
    assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 0), -1);
  });
  await host.flush();
  assert.equal(records.length, 1);
  assert.match(records[0].message, /Rejected WebAssembly log payload/);
});

test('zero-length payload at the exact end of memory is valid', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(
    host.imports.next_loggers.emit_utf8(2, memory.buffer.byteLength, 0),
    0,
  );
  await host.flush();
  assert.equal(records.length, 1);
  assert.equal(records[0].message, '');
});

test('a one-byte payload ending at the final memory byte is valid', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const offset = memory.buffer.byteLength - 1;
  put(memory, offset, 'x');
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_utf8(2, offset, 1), 0);
  await host.flush();
  assert.equal(records[0].message, 'x');
});

test('direct memory instances observe memory growth after host creation', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 3 });
  const host = createWasmLoggerHost(logger, { memory });
  memory.grow(1);
  const offset = 70_000;
  const bytes = put(memory, offset, 'after-grow');
  assert.equal(host.imports.next_loggers.emit_utf8(2, offset, bytes.length), 0);
  await host.flush();
  assert.equal(records[0].message, 'after-grow');
});

test('maximumPayloadBytes zero and negative values clamp to one byte', async () => {
  for (const maximumPayloadBytes of [0, -10]) {
    const { logger, records } = memoryLogger();
    const memory = new WebAssembly.Memory({ initial: 1 });
    put(memory, 0, 'ab');
    const host = createWasmLoggerHost(logger, { memory, maximumPayloadBytes });
    assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 1), 0);
    assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 2), -1);
    await host.flush();
    assert.equal(records[0].message, 'a');
    assert.equal(records[1].level, 'ERROR');
  }
});

test('fractional maximumPayloadBytes values are floored', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  put(memory, 0, 'abc');
  const host = createWasmLoggerHost(logger, {
    memory,
    maximumPayloadBytes: 2.99,
  });
  assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 2), 0);
  assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 3), -1);
  await host.flush();
  assert.equal(records.length, 2);
});

test('non-finite maximumPayloadBytes values use the safe default', async () => {
  for (const maximumPayloadBytes of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const { logger, records } = memoryLogger();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = put(memory, 0, 'default-limit');
    const host = createWasmLoggerHost(logger, { memory, maximumPayloadBytes });
    assert.equal(host.imports.next_loggers.emit_utf8(2, 0, bytes.length), 0);
    await host.flush();
    assert.equal(records[0].message, 'default-limit');
  }
});

test('unknown string levels fall back to INFO', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = put(
    memory,
    0,
    JSON.stringify({ level: 'UNKNOWN', message: 'fallback' }),
  );
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_json(0, payload.length), 0);
  await host.flush();
  assert.equal(records[0].level, 'INFO');
});

test('fractional numeric levels are truncated before clamping', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = put(memory, 0, 'fractional');
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_utf8(3.99, 0, bytes.length), 0);
  assert.equal(host.imports.next_loggers.emit_utf8(4.01, 0, bytes.length), 0);
  await host.flush();
  assert.deepEqual(records.map((value) => value.level), ['WARN', 'ERROR']);
});

test('non-array JSON values are rejected rather than corrupting the ABI', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = put(
    memory,
    0,
    JSON.stringify({ message: 'invalid values', values: { not: 'an array' } }),
  );
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_json(0, payload.length), -1);
  await host.flush();
  assert.equal(records.length, 1);
  assert.equal(records[0].tags.includes('decode-error'), true);
});

test('empty arrays and empty structured fields remain valid JSON payloads', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = put(
    memory,
    0,
    JSON.stringify({
      message: 'empty structures',
      values: [],
      fields: {},
      tags: [],
      context: [],
      meta: [],
    }),
  );
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_json(0, payload.length), 0);
  await host.flush();
  assert.equal(records[0].message, 'empty structures');
  assert.deepEqual(records[0].fields, {});
});

test('duplicate payload tags are deduplicated with the wasm tag', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = put(
    memory,
    0,
    JSON.stringify({ message: 'tags', tags: ['wasm', 'audio', 'audio'] }),
  );
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_json(0, payload.length), 0);
  await host.flush();
  assert.deepEqual(records[0].tags.sort(), ['audio', 'wasm']);
});

test('explicit WASM trace IDs take precedence over ambient context trace IDs', async () => {
  const { logger, records } = memoryLogger({
    contextProvider: () => ({
      traceId: 'ambient-trace',
      traceIds: ['ambient-trace'],
      fields: { ambient: true },
    }),
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = put(
    memory,
    0,
    JSON.stringify({ message: 'trace', traceId: 'wasm-trace' }),
  );
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_json(0, payload.length), 0);
  await host.flush();
  assert.equal(records[0].traceId, 'wasm-trace');
  assert.deepEqual(records[0].traceIds, ['wasm-trace', 'ambient-trace']);
  assert.equal(records[0].fields.ambient, true);
});

test('memory mutations after emit do not alter the already-decoded event', async () => {
  const gate = deferred();
  const records = [];
  const logger = createLogger({
    console: false,
    transports: {
      async write(value) {
        await gate.promise;
        records.push(value);
      },
    },
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const original = put(memory, 0, 'original');
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_utf8(2, 0, original.length), 0);
  put(memory, 0, 'mutated!');
  gate.resolve();
  await host.flush();
  assert.equal(records[0].message, 'original');
});

test('empty custom namespaces are supported as explicit import keys', () => {
  const { logger } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = createWasmLoggerHost(logger, { memory, namespace: '' });
  assert.deepEqual(Object.keys(host.imports), ['']);
  assert.equal(typeof host.imports[''].emit_utf8, 'function');
});

test('onDecodeError receives a normalized Error instance for JSON failures', async () => {
  const { logger } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = put(memory, 0, '{broken');
  const diagnostics = [];
  const host = createWasmLoggerHost(logger, {
    memory,
    onDecodeError: (error) => diagnostics.push(error),
  });
  assert.equal(host.imports.next_loggers.emit_json(0, bytes.length), -1);
  await host.flush();
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0] instanceof Error, true);
});

test('valid writes after logger close remain ABI-safe and are acknowledged', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = put(memory, 0, 'closed');
  const host = createWasmLoggerHost(logger, { memory });
  await logger.close();
  assert.doesNotThrow(() => {
    assert.equal(host.imports.next_loggers.emit_utf8(2, 0, bytes.length), 0);
  });
  await host.flush();
  assert.equal(records.length, 1);
  assert.equal(records[0].message, 'closed');
});

test('concurrent flush calls both wait for all pending events', async () => {
  const gate = deferred();
  const records = [];
  const logger = createLogger({
    console: false,
    transports: {
      async write(value) {
        await gate.promise;
        records.push(value);
      },
    },
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = put(memory, 0, 'pending');
  const host = createWasmLoggerHost(logger, { memory });
  host.imports.next_loggers.emit_utf8(2, 0, bytes.length);
  const first = host.flush();
  const second = host.flush();
  let settled = 0;
  void first.then(() => { settled += 1; });
  void second.then(() => { settled += 1; });
  await Promise.resolve();
  assert.equal(settled, 0);
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(records.length, 1);
  assert.equal(settled, 2);
});

test('one hundred synchronous ABI calls deliver one hundred exact records', async () => {
  const { logger, records } = memoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = createWasmLoggerHost(logger, { memory });
  for (let index = 0; index < 100; index += 1) {
    const message = `message-${index}`;
    const bytes = put(memory, 0, message);
    assert.equal(host.imports.next_loggers.emit_utf8(index % 6, 0, bytes.length), 0);
  }
  await host.flush();
  assert.equal(records.length, 100);
  assert.deepEqual(
    records.map((value) => value.message),
    Array.from({ length: 100 }, (_, index) => `message-${index}`),
  );
  assert.equal(records.every((value) => value.tags.includes('wasm')), true);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
