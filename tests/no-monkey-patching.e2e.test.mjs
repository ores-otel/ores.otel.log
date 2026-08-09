import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runIsolated(script) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('runtime and OTEL imports preserve core network, module, event, and console functions', () => {
  runIsolated(`
    import assert from 'node:assert/strict';
    import * as http from 'node:http';
    import * as https from 'node:https';
    import { EventEmitter } from 'node:events';
    import Module from 'node:module';

    const before = {
      fetch: globalThis.fetch,
      setTimeout: globalThis.setTimeout,
      queueMicrotask: globalThis.queueMicrotask,
      consoleLog: console.log,
      consoleError: console.error,
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      emitterEmit: EventEmitter.prototype.emit,
      moduleLoad: Module._load,
    };

    await import('@oresoftware/next-loggers/node');
    await import('@oresoftware/next-loggers/context');
    await import('@oresoftware/next-loggers/otel');

    assert.strictEqual(globalThis.fetch, before.fetch);
    assert.strictEqual(globalThis.setTimeout, before.setTimeout);
    assert.strictEqual(globalThis.queueMicrotask, before.queueMicrotask);
    assert.strictEqual(console.log, before.consoleLog);
    assert.strictEqual(console.error, before.consoleError);
    assert.strictEqual(http.request, before.httpRequest);
    assert.strictEqual(http.get, before.httpGet);
    assert.strictEqual(https.request, before.httpsRequest);
    assert.strictEqual(EventEmitter.prototype.emit, before.emitterEmit);
    assert.strictEqual(Module._load, before.moduleLoad);
  `);
});

test('sending through the explicit OTEL transport installs no globals or process error hooks', () => {
  runIsolated(`
    import assert from 'node:assert/strict';
    import * as http from 'node:http';
    import * as https from 'node:https';
    import { EventEmitter } from 'node:events';
    import Module from 'node:module';
    import { createLogger } from '@oresoftware/next-loggers/base';
    import { createOpenTelemetryTransport } from '@oresoftware/next-loggers/otel';

    const globalKeys = new Set(Reflect.ownKeys(globalThis));
    const before = {
      fetch: globalThis.fetch,
      httpRequest: http.request,
      httpsRequest: https.request,
      emitterEmit: EventEmitter.prototype.emit,
      moduleLoad: Module._load,
      uncaughtException: process.listenerCount('uncaughtException'),
      unhandledRejection: process.listenerCount('unhandledRejection'),
    };
    const emitted = [];
    const metrics = [];
    const transport = createOpenTelemetryTransport({
      logger: { emit: record => emitted.push(record) },
      activeSpan: () => ({
        spanContext: () => ({
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
          traceFlags: 1,
        }),
        isRecording: () => true,
        addEvent() {},
      }),
      recordMetric: (name, value) => metrics.push({ name, value }),
    });
    const logger = createLogger({
      appName: 'no-patch-e2e',
      console: false,
      idFactory: () => 'record-1',
      clock: () => new Date('2026-08-03T05:00:00.000Z'),
      transports: transport,
    });

    await logger.info('explicit transport').send();

    assert.equal(emitted.length, 1);
    assert.deepEqual(metrics.map(item => item.name), ['next_loggers.records']);
    assert.strictEqual(globalThis.fetch, before.fetch);
    assert.strictEqual(http.request, before.httpRequest);
    assert.strictEqual(https.request, before.httpsRequest);
    assert.strictEqual(EventEmitter.prototype.emit, before.emitterEmit);
    assert.strictEqual(Module._load, before.moduleLoad);
    assert.equal(process.listenerCount('uncaughtException'), before.uncaughtException);
    assert.equal(process.listenerCount('unhandledRejection'), before.unhandledRejection);

    const suspicious = Reflect.ownKeys(globalThis)
      .filter(key => !globalKeys.has(key))
      .map(String)
      .filter(key => /(?:otel|opentelemetry|next[_-]?logger|trace[_-]?provider)/i.test(key));
    assert.deepEqual(suspicious, []);
  `);
});

test('AsyncLocalStorage context remains concurrent-flow isolated without patching promises or timers', () => {
  runIsolated(`
    import assert from 'node:assert/strict';
    import {
      getLogContext,
      isAsyncContextTracked,
      runWithLogContext,
      updateLogContext,
    } from '@oresoftware/next-loggers/context';

    const before = {
      promiseThen: Promise.prototype.then,
      promiseCatch: Promise.prototype.catch,
      setTimeout: globalThis.setTimeout,
      queueMicrotask: globalThis.queueMicrotask,
    };
    assert.equal(isAsyncContextTracked(), true);

    const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const [first, second] = await Promise.all([
      runWithLogContext({ traceId: 'trace-a', fields: { request: 'a' } }, async () => {
        await delay(15);
        updateLogContext({ fields: { phase: 'late-a' } });
        await delay(5);
        return getLogContext();
      }),
      runWithLogContext({ traceId: 'trace-b', fields: { request: 'b' } }, async () => {
        await delay(5);
        updateLogContext({ fields: { phase: 'early-b' } });
        await delay(20);
        return getLogContext();
      }),
    ]);

    assert.equal(first.traceId, 'trace-a');
    assert.deepEqual(first.fields, { request: 'a', phase: 'late-a' });
    assert.equal(second.traceId, 'trace-b');
    assert.deepEqual(second.fields, { request: 'b', phase: 'early-b' });
    assert.equal(getLogContext(), undefined);
    assert.strictEqual(Promise.prototype.then, before.promiseThen);
    assert.strictEqual(Promise.prototype.catch, before.promiseCatch);
    assert.strictEqual(globalThis.setTimeout, before.setTimeout);
    assert.strictEqual(globalThis.queueMicrotask, before.queueMicrotask);
  `);
});
