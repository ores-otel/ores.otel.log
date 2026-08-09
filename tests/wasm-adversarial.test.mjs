import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import {
  createWasmLogger,
  createWasmLoggerHost,
} from '@oresoftware/next-loggers/wasm';

function createMemoryLogger() {
  const records = [];
  const logger = createLogger({
    appName: 'wasm-host',
    maxLevel: 'TRACE',
    console: false,
    transports: {
      name: 'memory',
      write(record) {
        records.push(record);
      },
    },
  });
  return { logger, records };
}

function writeBytes(memory, offset, bytes) {
  new Uint8Array(memory.buffer).set(bytes, offset);
}

test('numeric WASM levels clamp safely from TRACE through FATAL', async () => {
  const { logger, records } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = createWasmLoggerHost(logger, { memory });
  const text = new TextEncoder().encode('numeric');
  writeBytes(memory, 0, text);
  for (const level of [-100, 0, 1, 2, 3, 4, 5, 999]) {
    assert.equal(host.imports.next_loggers.emit_utf8(level, 0, text.length), 0);
  }
  await host.flush();
  assert.deepEqual(
    records.map((record) => record.level),
    ['TRACE', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL', 'FATAL'],
  );
});

test('custom import namespace exposes only the configured ABI name', () => {
  const { logger } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = createWasmLoggerHost(logger, {
    memory,
    namespace: 'telemetry_v1',
  });
  assert.deepEqual(Object.keys(host.imports), ['telemetry_v1']);
  assert.equal(typeof host.imports.telemetry_v1.emit_json, 'function');
  assert.equal('next_loggers' in host.imports, false);
});

test('late-bound memory getter supports modules whose memory is exported after instantiation', async () => {
  const { logger, records } = createMemoryLogger();
  let memory = new WebAssembly.Memory({ initial: 1 });
  const host = createWasmLoggerHost(logger, { memory: () => memory });
  const first = new TextEncoder().encode('first');
  writeBytes(memory, 0, first);
  assert.equal(host.imports.next_loggers.emit_utf8(2, 0, first.length), 0);

  memory = new WebAssembly.Memory({ initial: 2 });
  const second = new TextEncoder().encode('second');
  writeBytes(memory, 70_000, second);
  assert.equal(host.imports.next_loggers.emit_utf8(2, 70_000, second.length), 0);
  await host.flush();
  assert.deepEqual(records.map((record) => record.message), ['first', 'second']);
});

test('payload exactly at the configured byte limit is accepted', async () => {
  const { logger, records } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new TextEncoder().encode('12345678');
  writeBytes(memory, 10, bytes);
  const host = createWasmLoggerHost(logger, {
    memory,
    maximumPayloadBytes: bytes.length,
  });
  assert.equal(host.imports.next_loggers.emit_utf8(2, 10, bytes.length), 0);
  await host.flush();
  assert.equal(records[0].message, '12345678');
});

test('oversized, negative, fractional, and out-of-range pointers are rejected', async () => {
  const { logger, records } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const diagnostics = [];
  const host = createWasmLoggerHost(logger, {
    memory,
    maximumPayloadBytes: 8,
    onDecodeError: (error) => diagnostics.push(error.message),
  });
  const calls = [
    () => host.imports.next_loggers.emit_utf8(2, 0, 9),
    () => host.imports.next_loggers.emit_utf8(2, -1, 1),
    () => host.imports.next_loggers.emit_utf8(2, 1.5, 1),
    () => host.imports.next_loggers.emit_utf8(2, memory.buffer.byteLength, 1),
  ];
  for (const call of calls) assert.equal(call(), -1);
  await host.flush();
  assert.equal(diagnostics.length, 4);
  assert.equal(records.length, 4);
  assert.equal(records.every((record) => record.level === 'ERROR'), true);
});

test('fatal UTF-8 decoding rejects malformed byte sequences', async () => {
  const { logger, records } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  writeBytes(memory, 0, Uint8Array.from([0xc3, 0x28]));
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 2), -1);
  await host.flush();
  assert.equal(records.length, 1);
  assert.match(records[0].message, /Rejected WebAssembly log payload/);
});

test('invalid JSON and missing string messages are rejected through the logger', async () => {
  const { logger, records } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = createWasmLoggerHost(logger, { memory });
  const payloads = [
    new TextEncoder().encode('{not json'),
    new TextEncoder().encode(JSON.stringify({ level: 'info', message: 42 })),
    new TextEncoder().encode(JSON.stringify(null)),
  ];
  let offset = 0;
  for (const payload of payloads) {
    writeBytes(memory, offset, payload);
    assert.equal(host.imports.next_loggers.emit_json(offset, payload.length), -1);
    offset += payload.length + 1;
  }
  await host.flush();
  assert.equal(records.length, 3);
  assert.equal(records.every((record) => record.tags.includes('decode-error')), true);
});

test('decode diagnostics callbacks cannot throw through the WASM ABI', async () => {
  const { logger, records } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const host = createWasmLoggerHost(logger, {
    memory,
    maximumPayloadBytes: 1,
    onDecodeError() {
      throw new Error('diagnostic callback failed');
    },
  });
  assert.doesNotThrow(() => {
    assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 2), -1);
  });
  await host.flush();
  assert.equal(records.length, 1);
});

test('waitUntil callbacks cannot throw through the WASM ABI', async () => {
  const { logger, records } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new TextEncoder().encode('safe');
  writeBytes(memory, 0, bytes);
  const host = createWasmLoggerHost(logger, {
    memory,
    waitUntil() {
      throw new Error('host waitUntil failed');
    },
  });
  assert.doesNotThrow(() => {
    assert.equal(host.imports.next_loggers.emit_utf8(2, 0, bytes.length), 0);
  });
  await host.flush();
  assert.equal(records.length, 1);
  assert.equal(records[0].message, 'safe');
});

test('waitUntil receives each pending send promise', async () => {
  const { logger } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const promises = [];
  const host = createWasmLoggerHost(logger, {
    memory,
    waitUntil: (promise) => promises.push(promise),
  });
  const bytes = new TextEncoder().encode('queued');
  writeBytes(memory, 0, bytes);
  host.imports.next_loggers.emit_utf8(2, 0, bytes.length);
  host.imports.next_loggers.emit_utf8(3, 0, bytes.length);
  assert.equal(promises.length, 2);
  await Promise.all(promises);
  await host.flush();
});

test('JSON payload decorates every supported structured field', async () => {
  const { logger, records } = createMemoryLogger();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = new TextEncoder().encode(
    JSON.stringify({
      level: 'error',
      message: 'decode failed',
      values: [7, { codec: 'opus' }],
      fields: { frame: 42 },
      tags: ['audio', 'worker'],
      traceId: 'trace-wasm',
      routineId: 'decode-loop',
      context: [{ device: 'microphone' }],
      meta: [{ retry: 2 }],
    }),
  );
  writeBytes(memory, 64, payload);
  const host = createWasmLoggerHost(logger, { memory });
  assert.equal(host.imports.next_loggers.emit_json(64, payload.length), 0);
  await host.flush();
  const [value] = records;
  assert.equal(value.level, 'ERROR');
  assert.match(value.message, /decode failed 7/);
  assert.equal(value.fields.frame, 42);
  assert.equal(value.traceId, 'trace-wasm');
  assert.equal(value.routineId, 'decode-loop');
  assert.deepEqual(value.tags.sort(), ['audio', 'wasm', 'worker']);
  assert.deepEqual(value.context, [{ device: 'microphone' }]);
  assert.deepEqual(value.meta, [{ retry: 2 }]);
});

test('flush waits for all currently tracked sends and is reusable', async () => {
  const gate = { resolve: undefined };
  const records = [];
  let pending = new Promise((resolve) => {
    gate.resolve = resolve;
  });
  const logger = createLogger({
    console: false,
    transports: {
      async write(record) {
        await pending;
        records.push(record);
      },
    },
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const bytes = new TextEncoder().encode('delayed');
  writeBytes(memory, 0, bytes);
  const host = createWasmLoggerHost(logger, { memory });
  host.imports.next_loggers.emit_utf8(2, 0, bytes.length);
  const flush = host.flush();
  let settled = false;
  void flush.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await flush;
  assert.equal(records.length, 1);

  pending = Promise.resolve();
  host.imports.next_loggers.emit_utf8(2, 0, bytes.length);
  await host.flush();
  assert.equal(records.length, 2);
});

test('standalone WASM logger anew preserves runtime fields and merges child fields', async () => {
  const records = [];
  const parent = createWasmLogger({
    appName: 'wasm-app',
    moduleName: 'codec.wasm',
    instanceName: 'primary',
    fields: { parent: true },
    console: false,
    transports: { write: (record) => records.push(record) },
  });
  const child = parent.anew({
    instanceName: 'secondary',
    fields: { child: true },
  });
  await child.info('ready').send();
  assert.equal(records[0].runtime, 'wasm');
  assert.equal(records[0].fields.wasmModule, 'codec.wasm');
  assert.equal(records[0].fields.wasmInstance, 'secondary');
  assert.equal(records[0].fields.parent, true);
  assert.equal(records[0].fields.child, true);
});
