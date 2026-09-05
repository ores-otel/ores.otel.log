import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createShutdownCoordinator } from '@oresoftware/next-loggers/shutdown';
import { createDenoLogger } from '@oresoftware/next-loggers/deno';
import { createEdgeLogger } from '@oresoftware/next-loggers/edge';
import { createCloudflareWorkerLogger } from '@oresoftware/next-loggers/cloudflare';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

test('the shutdown coordinator bounds a flush that never settles', async () => {
  const coordinator = createShutdownCoordinator({
    gracePeriodMillis: 50,
    flushTimeoutMillis: 25,
    drain: () => undefined,
    force: () => undefined,
    // A collector in a black hole: the promise is never settled by anyone.
    flush: () => new Promise(() => undefined),
  });
  const started = Date.now();
  const result = await coordinator.request('SIGTERM');
  assert.equal(Date.now() - started < 2_000, true, 'shutdown must not hang on the flush');
  assert.equal(result.errors.length, 1);
  assert.match(String(result.errors[0]), /flush exceeded 25ms/);
});

test('flushTimeoutMillis of 0 waits indefinitely, and a prompt flush is unaffected', async () => {
  const coordinator = createShutdownCoordinator({
    gracePeriodMillis: 500,
    flushTimeoutMillis: 0,
    drain: () => undefined,
    force: () => undefined,
    flush: async () => new Promise((resolve) => setTimeout(resolve, 10)),
  });
  const result = await coordinator.request('programmatic');
  assert.deepEqual(result.errors, []);
});

for (const [name, create] of [
  ['edge', createEdgeLogger],
  ['cloudflare worker', createCloudflareWorkerLogger],
]) {
  test(`${name} logger hands the final drain to ctx.waitUntil`, async () => {
    const handed = [];
    let closed = 0;
    const logger = create({
      console: false,
      transports: {
        write: async () => undefined,
        close: async () => {
          closed += 1;
        },
      },
      executionContext: { waitUntil: (promise) => handed.push(promise) },
    });
    await logger.info('in-flight').send();
    const beforeClose = handed.length;
    await logger.close();
    // An isolate keeps no work alive past the response unless waitUntil is told
    // about it, so the close drain has to be handed over like any other send.
    assert.equal(handed.length > beforeClose, true, 'close was not handed to waitUntil');
    assert.equal(closed, 1);
    await Promise.allSettled(handed);
  });

  test(`${name} logger reports a sealed waitUntil instead of throwing out of close`, async () => {
    const lifecycle = [];
    const logger = create({
      console: false,
      transports: { write: async () => undefined },
      executionContext: {
        waitUntil() {
          throw new Error('execution context is sealed');
        },
      },
      onLifecycleError: (error, hook) => lifecycle.push(hook),
    });
    await logger.close();
    assert.equal(lifecycle.includes('waitUntil'), true);
  });
}

test('deno logger attaches signal listeners, not just unload', async () => {
  const signals = new Map();
  const events = new Map();
  const originalDeno = globalThis.Deno;
  const originalAdd = globalThis.addEventListener;
  const originalRemove = globalThis.removeEventListener;

  globalThis.Deno = {
    pid: 1,
    addSignalListener: (signal, handler) => signals.set(signal, handler),
    removeSignalListener: (signal) => signals.delete(signal),
    exit: () => undefined,
  };
  globalThis.addEventListener = (event, handler) => events.set(event, handler);
  globalThis.removeEventListener = (event) => events.delete(event);

  try {
    const records = [];
    const logger = createDenoLogger({
      console: false,
      transports: { write: async (record) => void records.push(record) },
    });
    // A container stop is a signal, and `unload` does not fire for one.
    assert.equal(signals.has('SIGTERM'), true, 'SIGTERM listener missing');
    assert.equal(signals.has('SIGINT'), true, 'SIGINT listener missing');
    assert.equal(events.has('unload'), true, 'unload listener missing');

    logger.warn('drain me on SIGTERM');
    signals.get('SIGTERM')();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(records.length, 1);

    await logger.close();
    assert.equal(signals.size, 0, 'close must detach signal listeners');
    assert.equal(events.size, 0, 'close must detach event listeners');
  } finally {
    if (originalDeno === undefined) {
      delete globalThis.Deno;
    } else {
      globalThis.Deno = originalDeno;
    }
    if (originalAdd) {
      globalThis.addEventListener = originalAdd;
    } else {
      delete globalThis.addEventListener;
    }
    if (originalRemove) {
      globalThis.removeEventListener = originalRemove;
    } else {
      delete globalThis.removeEventListener;
    }
  }
});

/**
 * Attaching a SIGTERM listener overrides the kernel default. If the second
 * signal were swallowed, a process stuck on an unreachable collector would be
 * unkillable by ordinary means for the whole shutdown timeout -- so this is
 * checked against a real process rather than a stubbed one.
 */
test('a second signal abandons the drain instead of leaving the process unkillable', async () => {
  const program = `
    import { createNodeLogger } from '${repoRoot}/dist/node-logger.js';
    const logger = createNodeLogger({
      console: false,
      shutdownTimeoutMillis: 60_000,
      transports: { write: async () => undefined, flushOnExit: () => new Promise(() => {}) },
    });
    logger.warn('wedged');
    process.stdout.write('ready\\n');
    setInterval(() => undefined, 1_000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child never became ready')), 15_000);
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('ready')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('error', reject);
    });

    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));
    child.kill('SIGTERM');

    const outcome = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('still-running'), 8_000)),
    ]);
    assert.notEqual(outcome, 'still-running', 'the second SIGTERM did not take effect');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});
