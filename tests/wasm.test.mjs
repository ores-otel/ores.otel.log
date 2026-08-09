import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import { createWasmLogger, createWasmLoggerHost } from '@oresoftware/next-loggers/wasm';

test('WASM host import decodes a bounded payload and sends through next-loggers', async () => {
  const records = [];
  const logger = createLogger({
    appName: 'wasm-client',
    console: false,
    transports: { write: (record) => void records.push(record) },
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const payload = JSON.stringify({
    level: 'warn',
    message: 'wasm warning',
    values: [7],
    fields: { component: 'codec' },
    tags: ['client'],
    traceId: 'trace-wasm',
    routineId: 'decode-frame',
  });
  const bytes = new TextEncoder().encode(payload);
  new Uint8Array(memory.buffer).set(bytes, 32);
  const host = createWasmLoggerHost(logger, { memory });

  assert.equal(host.imports.next_loggers.emit_json(32, bytes.length), 0);
  await host.flush();
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'WARN');
  assert.equal(records[0].message, 'wasm warning 7');
  assert.equal(records[0].fields.component, 'codec');
  assert.equal(records[0].traceId, 'trace-wasm');
  assert.deepEqual(records[0].tags.sort(), ['client', 'wasm']);
});

test('WASM host rejects out-of-bounds payloads without throwing into the module', async () => {
  const records = [];
  const memory = new WebAssembly.Memory({ initial: 1 });
  const logger = createLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
  });
  const host = createWasmLoggerHost(logger, { memory, maximumPayloadBytes: 16 });
  assert.equal(host.imports.next_loggers.emit_utf8(2, 0, 100), -1);
  await host.flush();
  assert.equal(records.length, 1);
  assert.equal(records[0].level, 'ERROR');
  assert.deepEqual(records[0].tags.sort(), ['decode-error', 'wasm']);
});

test('standalone WASM logger emits the shared record with wasm runtime fields', async () => {
  const records = [];
  const logger = createWasmLogger({
    appName: 'module-host',
    moduleName: 'audio.wasm',
    instanceName: 'worker-1',
    console: false,
    transports: { write: (record) => void records.push(record) },
  });
  await logger.info('ready').send();
  assert.equal(records[0].runtime, 'wasm');
  assert.equal(records[0].fields.wasmModule, 'audio.wasm');
  assert.equal(records[0].fields.wasmInstance, 'worker-1');
  await logger.close();
});
