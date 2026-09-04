import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';

import {
  createLogger,
  getPendingLogCount,
  HttpTransport,
  SupabaseRealtimeTransport,
} from '@oresoftware/next-loggers/base';
import { browserLogger, createBrowserLogger } from '@oresoftware/next-loggers/browser';
import { createBunLogger } from '@oresoftware/next-loggers/bun';
import { createDenoLogger } from '@oresoftware/next-loggers/deno';
import { createEdgeLogger } from '@oresoftware/next-loggers/edge';
import { createCloudflareWorkerLogger } from '@oresoftware/next-loggers/cloudflare';
import { createNodeLogger } from '@oresoftware/next-loggers/node';
import { logger as conditionLogger } from '@oresoftware/next-loggers';

test('Node selects the node logger from the root export', () => {
  assert.equal(conditionLogger.runtime, 'node');
});

test('all explicit runtime entry points are importable from ESM', () => {
  assert.equal(createLogger({ console: false }).runtime, 'base');
  assert.equal(createBrowserLogger({ console: false, flushOnUnload: false }).runtime, 'browser');
  assert.equal(createEdgeLogger({ console: false }).runtime, 'edge');
  assert.equal(createCloudflareWorkerLogger({ console: false }).runtime, 'cloudflare');
  assert.equal(createNodeLogger({ console: false, flushOnShutdown: false }).runtime, 'node');
  assert.equal(createBunLogger({ console: false, flushOnShutdown: false }).runtime, 'bun');
  assert.equal(createDenoLogger({ console: false, flushOnUnload: false }).runtime, 'deno');
});

test('chainable events serialize context and difficult values', async () => {
  const records = [];
  const circular = { name: 'root' };
  circular.self = circular;
  const logger = createLogger({
    appName: 'test-app',
    console: false,
    clock: () => new Date('2026-01-02T03:04:05.000Z'),
    idFactory: () => 'event-id',
    fields: { inherited: true },
    transports: {
      name: 'memory',
      write(record) {
        records.push(record);
      },
    },
  }).setCurrentUser({ ddUserId: 'user-1' });

  await logger
    .error('failed', new Error('boom'), 42n, circular)
    .addTrace('trace-1')
    .addTrace('trace-2')
    .addRoutineId('routine-1')
    .addTags('one', 'two')
    .addFields({ requestId: 'request-1' })
    .addContext({ attempt: 2 })
    .addMeta(new Map([['source', 'test']]))
    .send();

  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.schema, 'next-loggers/v1');
  assert.equal(record.id, 'event-id');
  assert.equal(record.timestamp, '2026-01-02T03:04:05.000Z');
  assert.equal(record.level, 'ERROR');
  assert.equal(record.message.startsWith('failed boom 42n'), true);
  assert.deepEqual(record.traceIds, ['trace-1', 'trace-2']);
  assert.equal(record.fields.inherited, true);
  assert.equal(record.fields.requestId, 'request-1');
  assert.equal(record.loggedInUser.ddUserId, 'user-1');
  assert.equal(record.values[2], '42n');
  assert.equal(record.values[3].self, '[Circular]');
  assert.equal(record.errors[0].message, 'boom');
});

test('level threshold and send(false) skip transports', async () => {
  let writes = 0;
  const logger = createLogger({
    maxLevel: 'warn',
    console: false,
    transports: { write: () => void (writes += 1) },
  });

  await logger.info('below threshold').send();
  await logger.error('console only').send(false);
  await logger.warn('stored').send();
  assert.equal(writes, 1);
});

test('flushOnExit sends unfinished chains and drains the shared promise registry', async () => {
  const records = [];
  const waitUntilPromises = [];
  const afterCallbacks = [];
  const logger = createLogger({
    console: false,
    transports: { write: async (record) => records.push(record) },
    waitUntil: (promise) => waitUntilPromises.push(promise),
    after: (callback) => afterCallbacks.push(callback),
  });

  logger.info('forgotten until shutdown').addFields({ recovered: true });
  assert.equal(records.length, 0);
  await logger.flushOnExit({ timeoutMillis: 500 });

  assert.equal(records.length, 1);
  assert.equal(records[0].message, 'forgotten until shutdown');
  assert.equal(records[0].fields.recovered, true);
  assert.equal(waitUntilPromises.length, 1);
  assert.equal(afterCallbacks.length, 1);
  await afterCallbacks[0]();
  assert.equal(getPendingLogCount(), 0);
});

test('browser pagehide and freeze flush unfinished events exactly once', async () => {
  await browserLogger.close();
  const eventTarget = new EventTarget();
  const originalAddEventListener = globalThis.addEventListener;
  const originalRemoveEventListener = globalThis.removeEventListener;
  globalThis.addEventListener = eventTarget.addEventListener.bind(eventTarget);
  globalThis.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);

  try {
    const records = [];
    const logger = createBrowserLogger({
      console: false,
      transports: { write: async (record) => records.push(record) },
    });
    logger.warn('flush me on browser shutdown');
    // pagehide replaces beforeunload: it fires in every case beforeunload does,
    // and unlike beforeunload it does not disqualify the page from bfcache.
    eventTarget.dispatchEvent(new Event('pagehide'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(records.length, 1);

    // One teardown fires several of these in sequence; the buffer goes out
    // once, not once per event.
    eventTarget.dispatchEvent(new Event('pagehide'));
    eventTarget.dispatchEvent(new Event('freeze'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(records.length, 1, 'a single teardown must not re-send the buffer');

    // A tab restored from bfcache goes on living, so its next teardown must
    // flush again.
    logger.warn('after bfcache restore');
    await new Promise((resolve) => setTimeout(resolve, 5));
    eventTarget.dispatchEvent(new Event('pagehide'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(records.length, 2, 'a later teardown must flush again');
    await logger.close();
  } finally {
    if (originalAddEventListener) {
      globalThis.addEventListener = originalAddEventListener;
    } else {
      delete globalThis.addEventListener;
    }
    if (originalRemoveEventListener) {
      globalThis.removeEventListener = originalRemoveEventListener;
    } else {
      delete globalThis.removeEventListener;
    }
  }
});

test('HTTP shutdown delivery uses sendBeacon for active browser requests', async () => {
  const beacons = [];
  const logger = createLogger({
    console: false,
    transports: new HttpTransport({
      endpoint: 'https://logs.example.test/shutdown',
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Response(null, { status: 202 });
      },
      sendBeacon: (url, body) => {
        beacons.push({ url, body });
        return true;
      },
    }),
  });

  logger.error('shutdown beacon');
  await logger.flushOnExit({ timeoutMillis: 5 });
  assert.equal(beacons.length, 1);
  assert.equal(beacons[0].url, 'https://logs.example.test/shutdown');
  assert.equal(JSON.parse(beacons[0].body).message, 'shutdown beacon');
  await new Promise((resolve) => setTimeout(resolve, 30));
});

test('HTTP transport posts a JSON-safe record', async () => {
  const requests = [];
  const transport = new HttpTransport({
    endpoint: 'https://logs.example.test/events',
    headers: { authorization: 'Bearer test' },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return new Response(null, { status: 202 });
    },
  });
  const logger = createLogger({ console: false, transports: transport });

  await logger.info('hello').send();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://logs.example.test/events');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(JSON.parse(requests[0].init.body).message, 'hello');
});

test('Supabase transport joins and broadcasts through WebSocket', async () => {
  let socket;
  let socketUrl = '';
  const sent = [];

  class MockWebSocket {
    readyState = 0;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;

    send(data) {
      const message = JSON.parse(data);
      sent.push(message);
      if (message.event === 'phx_join') {
        queueMicrotask(() => {
          this.onmessage?.({
            data: JSON.stringify({
              topic: message.topic,
              event: 'phx_reply',
              payload: { status: 'ok', response: {} },
              ref: message.ref,
            }),
          });
        });
      }
    }

    open() {
      this.readyState = 1;
      this.onopen?.({});
    }

    close() {
      this.readyState = 3;
      this.onclose?.({});
    }
  }

  const transport = new SupabaseRealtimeTransport({
    url: 'https://project.supabase.co',
    anonKey: 'anon-key',
    channel: 'application-logs',
    event: 'log-entry',
    webSocketFactory(url) {
      socketUrl = url;
      socket = new MockWebSocket();
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  const logger = createLogger({ console: false, transports: transport });

  await logger.warn('stream me').send();
  const join = sent.find((message) => message.event === 'phx_join');
  const broadcast = sent.find((message) => message.event === 'broadcast');
  assert.match(socketUrl, /^wss:\/\/project\.supabase\.co\/realtime\/v1\/websocket/);
  assert.match(socketUrl, /apikey=anon-key/);
  assert.equal(broadcast.topic, 'realtime:application-logs');
  assert.equal(broadcast.join_ref, join.join_ref);
  assert.equal(broadcast.payload.event, 'log-entry');
  assert.equal(broadcast.payload.payload.message, 'stream me');
  await logger.close();
});

test('edge logger passes remote delivery to waitUntil', async () => {
  const promises = [];
  const logger = createEdgeLogger({
    console: false,
    transports: { write: async () => undefined },
    executionContext: { waitUntil: (promise) => promises.push(promise) },
  });

  await logger.info('edge').send();
  assert.equal(promises.length, 1);
  await Promise.all(promises);
});

test('cloudflare worker logger attaches request, cf, and env fields', async () => {
  const records = [];
  const logger = createCloudflareWorkerLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
    envFields: ['ENVIRONMENT', 'API_TOKEN', 'KV'],
  });

  const request = {
    url: 'https://worker.example.com/orders',
    method: 'POST',
    headers: new Headers({ 'cf-ray': '8f3a1b2c4d5e6f70-SJC', 'cf-connecting-ip': '203.0.113.7' }),
    cf: { colo: 'SJC', country: 'US', city: 'San Jose', asn: 13335, httpProtocol: 'HTTP/2' },
  };
  const promises = [];
  const child = logger.forRequest(request, { waitUntil: (promise) => promises.push(promise) }, {
    ENVIRONMENT: 'production',
    API_TOKEN: 'super-secret',
    KV: { get: async () => null },
  });

  await child.info('handled').send();
  assert.equal(promises.length, 1);
  await Promise.all(promises);

  const [record] = records;
  assert.equal(record.runtime, 'cloudflare');
  assert.equal(record.fields.requestUrl, 'https://worker.example.com/orders');
  assert.equal(record.fields.requestMethod, 'POST');
  assert.equal(record.fields.rayId, '8f3a1b2c4d5e6f70-SJC');
  assert.equal(record.fields.colo, 'SJC');
  assert.equal(record.fields.country, 'US');
  assert.equal(record.fields.asn, 13335);
  assert.equal(record.fields.ENVIRONMENT, 'production');
  // cf-connecting-ip stays off unless includeClientIp is set; bindings are not primitives.
  assert.equal('clientIp' in record.fields, false);
  assert.equal('KV' in record.fields, false);
  // redaction still applies to runtime fields
  assert.equal(record.fields.API_TOKEN, '[REDACTED]');
});

test('cloudflare worker logger honours includeClientIp and includeCfProperties', async () => {
  const records = [];
  const logger = createCloudflareWorkerLogger({
    console: false,
    includeClientIp: true,
    includeCfProperties: false,
    transports: { write: (record) => void records.push(record) },
    request: {
      url: 'https://worker.example.com/',
      method: 'GET',
      headers: new Headers({ 'cf-connecting-ip': '203.0.113.7' }),
      cf: { colo: 'SJC' },
    },
  });

  await logger.info('direct').send();
  const [record] = records;
  assert.equal(record.fields.clientIp, '203.0.113.7');
  assert.equal('colo' in record.fields, false);
});

test('cloudflare worker logger swaps fetch and scheduled bindings per invocation', async () => {
  const records = [];
  const logger = createCloudflareWorkerLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
  });

  const fetchLogger = logger.forRequest({ url: 'https://worker.example.com/', method: 'GET' });
  const cronLogger = fetchLogger.forScheduled({ cron: '*/5 * * * *', scheduledTime: 1767225845000 });

  await cronLogger.info('cron tick').send();
  const [record] = records;
  assert.equal(record.fields.cron, '*/5 * * * *');
  assert.equal(record.fields.scheduledTime, '2026-01-01T00:04:05.000Z');
  assert.equal('requestUrl' in record.fields, false);
});

test('cloudflare worker logger routes a throwing waitUntil to onLifecycleError', async () => {
  const failures = [];
  const logger = createCloudflareWorkerLogger({
    console: false,
    transports: { write: async () => undefined },
    executionContext: {
      waitUntil: () => {
        throw new Error('isolate already cancelled');
      },
    },
    onLifecycleError: (error, hook) => void failures.push([hook, String(error)]),
  });

  await logger.info('cloudflare lifecycle').send();
  assert.equal(failures.length, 1);
  assert.equal(failures[0][0], 'waitUntil');
});

test('Node SIGTERM drains unsent events before preserving signal shutdown', async () => {
  const source = `
    import { createNodeLogger } from '@oresoftware/next-loggers/node';
    const logger = createNodeLogger({
      console: false,
      shutdownTimeoutMillis: 1000,
      transports: {
        async write(record) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          console.log('DELIVERED:' + record.message);
        }
      }
    });
    logger.error('signal shutdown');
    console.log('READY');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`shutdown child timed out\n${stdout}\n${stderr}`));
    }, 5_000);
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY')) {
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  assert.match(stdout, /DELIVERED:signal shutdown/);
  assert.equal(result.code, null, stderr);
  assert.equal(result.signal, 'SIGTERM');
});

test('ordered export conditions select each runtime implementation', () => {
  for (const [condition, runtime] of [
    ['browser', 'browser'],
    ['edge-light', 'edge'],
    ['workerd', 'cloudflare'],
    ['worker', 'edge'],
    ['bun', 'bun'],
    ['deno', 'deno'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        `--conditions=${condition}`,
        '--input-type=module',
        '--eval',
        "import('@oresoftware/next-loggers').then(({logger}) => console.log(logger.runtime))",
      ],
      { encoding: 'utf8', cwd: process.cwd() },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), runtime);
  }
});
