import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Linter } from 'eslint';
import eslintPlugin from '@oresoftware/next-loggers/eslint';
import { createLogger } from '@oresoftware/next-loggers/base';
import { loadNextLoggerConfig } from '@oresoftware/next-loggers/config';

const makeMemoryLogger = (options = {}) => {
  const records = [];
  const logger = createLogger({
    console: false,
    transports: { write: (record) => void records.push(record) },
    ...options,
  });
  return { logger, records };
};

test('addTrace makeFirst reorders the primary trace id', async () => {
  const { logger, records } = makeMemoryLogger();
  await logger
    .info('traces')
    .addTrace('second')
    .addTraceId('first', { makeFirst: true })
    .addTagList(['a', 'b', 'a'])
    .send();
  assert.equal(records[0].traceId, 'first');
  assert.deepEqual(records[0].traceIds.sort(), ['first', 'second']);
  assert.deepEqual(records[0].tags, ['a', 'b']);
});

test('setUserContext records both the acting user and affected users', async () => {
  const { logger, records } = makeMemoryLogger();
  await logger
    .warn('user context')
    .setUserContext({ ddUserId: 'dd-9' }, { id: 'other-user', firstName: 'Sam' })
    .send();
  assert.equal(records[0].loggedInUser.ddUserId, 'dd-9');
  assert.equal(records[0].users.length, 1);
  assert.equal(records[0].users[0].id, 'other-user');
});

test('toJSON caches the record and getHashCode is stable and level-sensitive', () => {
  const logger = createLogger({ console: false, idFactory: () => 'stable-id' });
  const event = logger.info('hash me').addTrace('t-1');
  const first = event.toJSON();
  const second = event.toJSON();
  assert.equal(first, second, 'toJSON should cache the record object');
  assert.equal(typeof event.getJSON(), 'string');

  const eventA = logger.info('hash me').addTrace('t-1');
  const eventB = logger.error('hash me').addTrace('t-1');
  assert.equal(event.getHashCode(), eventA.getHashCode());
  assert.notEqual(eventA.getHashCode(), eventB.getHashCode());
});

test('send() is idempotent per event', async () => {
  const { logger, records } = makeMemoryLogger();
  const event = logger.info('once only');
  await Promise.all([event.send(), event.send(), event.send()]);
  assert.equal(records.length, 1);
});

test('per-event OTEL routing overrides the inherited logger default only for OTEL transports', async () => {
  const otel = [];
  const namedOtel = [];
  const regular = [];
  const logger = createLogger({
    console: false,
    otel: false,
    transports: [
      { otel: true, write: (record) => otel.push(record.message) },
      { name: 'opentelemetry', write: (record) => namedOtel.push(record.message) },
      { name: 'memory', write: (record) => regular.push(record.message) },
    ],
  });

  const defaultOff = logger.info('default-off');
  assert.equal(defaultOff.isOtelEnabled(logger.isOtelEnabled()), false);
  await defaultOff.send();
  await logger.info('forced-on').useOtel().send();
  await logger.info('reset-to-default').useOtel().resetOtel().send();

  logger.useOtel();
  await logger.warn('forced-off').notOtel().send();
  await logger.info('logger-on').withOtel(true).send();

  assert.deepEqual(otel, ['forced-on', 'logger-on']);
  assert.deepEqual(namedOtel, ['forced-on', 'logger-on']);
  assert.deepEqual(regular, [
    'default-off',
    'forced-on',
    'reset-to-default',
    'forced-off',
    'logger-on',
  ]);

  const child = logger.notOtel().anew();
  assert.equal(child.isOtelEnabled(), false, 'anew children inherit the write-through default');
});

test('close() is safe to call twice', async () => {
  const { logger, records } = makeMemoryLogger();
  logger.info('drained at close');
  await logger.close();
  await logger.close();
  assert.equal(records.length, 1);
});

test('anew children inherit errorTracking from options write-through', async () => {
  const posts = [];
  const parent = createLogger({ console: false }).setErrorTrackingUrl(
    'https://errors.example.test/collect',
    {
      dedupe: false,
      fetch: async (url, init) => {
        posts.push(JSON.parse(init.body).message);
        return new Response(null, { status: 200 });
      },
    },
  );
  const child = parent.anew({ appName: 'child-app' });
  await child.error('child error').send();
  assert.deepEqual(posts, ['child error']);
});

test('loadNextLoggerConfig honors NEXT_LOGGER_CONFIG_DIR and named config exports', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'next-logger-dir-'));
  try {
    await writeFile(
      path.join(directory, '.next-logger.mjs'),
      `export const config = { appName: 'named-export-app' };`,
    );
    const { options, filePath } = await loadNextLoggerConfig({
      env: { NEXT_LOGGER_CONFIG_DIR: directory },
    });
    assert.equal(options.appName, 'named-export-app');
    assert.equal(filePath, path.join(directory, '.next-logger.mjs'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('require-send tracks loggers assigned to this.* properties', () => {
  const linter = new Linter();
  const messages = linter.verify(
    `
    import { createLogger } from '@oresoftware/next-loggers';
    class Service {
      constructor() {
        this.log = createLogger();
      }
      fail() {
        this.log.error('missing send');
        this.log.error('has send').send();
      }
    }
    void Service;
    `,
    [
      {
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
        plugins: { 'next-loggers': eslintPlugin },
        rules: { 'next-loggers/require-send': 'warn' },
      },
    ],
    { filename: 'service.mjs' },
  );
  assert.equal(messages.length, 1);
});
