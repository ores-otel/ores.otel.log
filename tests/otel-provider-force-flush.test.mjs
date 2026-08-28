import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createLogger } from '@oresoftware/next-loggers/base';
import { createOpenTelemetryTransport } from '@oresoftware/next-loggers/otel';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class AppOwnedProvider {
  constructor(gate = null) {
    this.gate = gate;
    this.forceFlushCalls = 0;
    this.shutdownCalls = 0;
  }

  async forceFlush() {
    this.forceFlushCalls += 1;
    await this.gate?.promise;
  }

  async shutdown() {
    this.shutdownCalls += 1;
  }
}

test('Node refines the shared app-owned provider lifecycle corpus', async () => {
  const corpus = JSON.parse(
    await readFile(new URL('../formal/app_owned_provider_flush.v1.json', import.meta.url), 'utf8'),
  );
  assert.equal(corpus.schema, 'ores.otel.log/app-owned-provider-flush/v1');
  assert.equal(corpus.maximumCallbacks, 32);
  assert.equal(Object.values(corpus.invariants).every(Boolean), true);

  for (const vector of corpus.vectors) {
    const gate = deferred();
    const providers = Array.from(
      { length: vector.callbackCount },
      () => new AppOwnedProvider(gate),
    );
    let transport;
    try {
      transport = createOpenTelemetryTransport({
        logger: { emit() {} },
        forceFlushCallbacks: providers.map((provider) => provider.forceFlush.bind(provider)),
      });
    } catch (error) {
      assert.equal(vector.expectedValid, false, vector.id);
      assert.match(String(error), /at most 32/);
      continue;
    }
    assert.equal(vector.expectedValid, true, vector.id);
    const flushes = Array.from(
      { length: vector.concurrentFlushCallers },
      () => transport.flush(),
    );
    await Promise.resolve();
    for (const provider of providers) {
      assert.equal(
        provider.forceFlushCalls,
        vector.expectedForceFlushCallsPerProvider,
        vector.id,
      );
      assert.equal(provider.shutdownCalls, vector.expectedShutdownCalls, vector.id);
    }
    gate.resolve();
    await Promise.all(flushes);
  }
});

test('logger close force-flushes but never shuts down an app-owned provider', async () => {
  const provider = new AppOwnedProvider();
  const logger = createLogger({
    console: false,
    transports: createOpenTelemetryTransport({
      logger: { emit() {} },
      forceFlushCallbacks: [provider.forceFlush.bind(provider)],
    }),
  });
  await logger.info('before logout').send();
  await logger.close({ throwOnError: true });
  assert.equal(provider.forceFlushCalls, 1);
  assert.equal(provider.shutdownCalls, 0);
});

test('strict logger flush reports provider failures while ordinary flush stays fail-open', async () => {
  let calls = 0;
  const diagnostics = [];
  const logger = createLogger({
    console: false,
    transports: createOpenTelemetryTransport({
      logger: { emit() {} },
      forceFlushCallbacks: [async () => {
        calls += 1;
        throw new Error('provider unavailable');
      }],
      onBridgeError: (_error, operation) => diagnostics.push(operation),
    }),
  });

  await logger.flush();
  await assert.rejects(
    logger.flush({ throwOnError: true }),
    /next-loggers flush failed/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(diagnostics, ['provider.forceFlush', 'provider.forceFlush']);
});

test('strict logger flush reports its bounded timeout', async () => {
  const never = new Promise(() => undefined);
  const logger = createLogger({
    console: false,
    transports: createOpenTelemetryTransport({
      logger: { emit() {} },
      forceFlushCallbacks: [() => never],
    }),
  });
  await assert.rejects(
    logger.flush({ throwOnError: true, timeoutMillis: 5 }),
    /flush exceeded 5ms/,
  );
});
