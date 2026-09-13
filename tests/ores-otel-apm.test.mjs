import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  createLatencyHistogramSnapshot,
  createLatencyRecorder,
  evaluateDiskPressure,
  evaluateSaturation,
  oresOtelResourceThresholds,
  recordLatency,
  sampleFilesystem,
  sampleProcessMemory,
  startOresOtelApm,
} from '../dist/apm.js';
import { OresOtelConfigError, parseOresOtelToml, resolveOresOtelConfig } from '../dist/config.js';

const configFrom = (toml, env = {}) => resolveOresOtelConfig(parseOresOtelToml(`version = 1\n${toml}`), { env });

function fakeMeter() {
  const instruments = [];
  const create = (kind) => (name, options) => {
    const instrument = {
      kind,
      name,
      options,
      callbacks: new Set(),
      records: [],
      addCallback(callback) {
        this.callbacks.add(callback);
      },
      removeCallback(callback) {
        this.callbacks.delete(callback);
      },
      record(value, attributes) {
        this.records.push([value, attributes]);
      },
    };
    instruments.push(instrument);
    return instrument;
  };
  return {
    instruments,
    createObservableGauge: create('gauge'),
    createObservableCounter: create('counter'),
    createHistogram: create('histogram'),
    find: (name) => instruments.find((instrument) => instrument.name === name),
    collect(name) {
      const observations = [];
      for (const callback of this.find(name)?.callbacks ?? []) {
        callback({ observe: (value, attributes) => observations.push([value, attributes]) });
      }
      return observations;
    },
  };
}

test('package manifest exports ./apm', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.exports['./apm'], { types: './dist/apm.d.ts', default: './dist/apm.js' });
});

test('thresholds honour the master and sub-table switches', () => {
  const on = configFrom('[common.metrics.filesystem]\nmin_free_bytes = 10\n[common.metrics.saturation]\nmemory_ratio_warning = 0.8\n');
  assert.deepEqual(oresOtelResourceThresholds(on), { minFreeBytes: 10, memoryRatioWarning: 0.8 });
  const diskOff = configFrom(
    '[common.metrics.filesystem]\nenabled = false\nmin_free_bytes = 10\n[common.metrics.saturation]\nmemory_ratio_warning = 0.8\n',
  );
  assert.deepEqual(oresOtelResourceThresholds(diskOff), { memoryRatioWarning: 0.8 });
  const masterOff = configFrom('[common.metrics]\nenabled = false\n[common.metrics.filesystem]\nmin_free_bytes = 10\n');
  assert.deepEqual(oresOtelResourceThresholds(masterOff), {});
});

test('evaluateDiskPressure and evaluateSaturation report every evaluable threshold', () => {
  const disk = evaluateDiskPressure(
    { path: '/data', availableBytes: 5, capacityBytes: 100, availableInodes: 1, totalInodes: 100 },
    { minFreeBytes: 10, minFreeRatio: 0.01, minInodeFreeRatio: 0.5 },
  );
  assert.equal(disk.freeRatio, 0.05);
  assert.deepEqual(
    disk.checks.map((check) => [check.kind, check.breached]),
    [
      ['disk_free_bytes', true],
      ['disk_free_ratio', false],
      ['disk_inode_free_ratio', true],
    ],
  );
  assert.equal(disk.underPressure, true);
  const empty = evaluateDiskPressure({ path: '/x', availableBytes: 0, capacityBytes: 0 }, { minFreeRatio: 0.5 });
  assert.deepEqual(empty.checks, []);
  assert.throws(() => evaluateDiskPressure({ path: '/x', availableBytes: -1, capacityBytes: 1 }, {}), RangeError);

  assert.deepEqual(
    evaluateSaturation({ target: 'process', memoryRatio: 0.9, queueDepth: 3 }, { memoryRatioWarning: 0.8, queueDepthWarning: 3 }),
    [
      { kind: 'memory_ratio_warning', target: 'process', breached: true },
      { kind: 'queue_depth_warning', target: 'process', breached: false },
    ],
  );
});

test('latency histogram snapshots are immutable values', () => {
  const empty = createLatencyHistogramSnapshot([1, 5]);
  const recorded = [0.5, 5, 7].reduce(recordLatency, empty);
  assert.deepEqual(recorded.bucketCounts, [1, 1, 1]);
  assert.equal(recorded.count, 3);
  assert.equal(recorded.min, 0.5);
  assert.equal(recorded.max, 7);
  assert.deepEqual(empty.bucketCounts, [0, 0, 0]);
  assert.ok(Object.isFrozen(recorded.bucketCounts));
  assert.throws(() => createLatencyHistogramSnapshot([5, 1]), OresOtelConfigError);
  assert.throws(() => recordLatency(empty, Number.NaN), RangeError);
});

test('createLatencyRecorder uses configured boundaries and per-kind signal flags', async () => {
  const meter = fakeMeter();
  const recorder = createLatencyRecorder(
    meter,
    configFrom('[common.metrics.latency]\nqueue_wait_ms = false\nhistogram_boundaries_ms = [2, 4]\n'),
  );
  const histogram = meter.find('ores.apm.latency');
  assert.equal(histogram.options.unit, 'ms');
  assert.deepEqual(histogram.options.advice.explicitBucketBoundaries, [2, 4]);
  recorder.record('request', 3, { route: '/a' });
  recorder.record('queue_wait', 3);
  assert.equal(recorder.time('operation', () => 42), 42);
  assert.equal(await recorder.timeAsync('operation', async () => 'ok'), 'ok');
  assert.deepEqual(histogram.records[0], [3, { route: '/a', 'ores.apm.latency.kind': 'request' }]);
  assert.deepEqual(
    histogram.records.map(([, attributes]) => attributes['ores.apm.latency.kind']),
    ['request', 'operation', 'operation'],
  );

  const disabledMeter = fakeMeter();
  const disabled = createLatencyRecorder(disabledMeter, configFrom('[common.metrics.latency]\nenabled = false\n'));
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.time('request', () => 1), 1);
  assert.equal(disabledMeter.instruments.length, 0);
});

test('sampleProcessMemory and sampleFilesystem return live measurements', async () => {
  const memory = sampleProcessMemory();
  assert.ok(memory.rssBytes > 0 && memory.heapUsedBytes > 0);
  const disk = await sampleFilesystem(tmpdir());
  assert.ok(disk.capacityBytes > 0);
  assert.ok(disk.availableBytes <= disk.freeBytes && disk.freeBytes <= disk.capacityBytes);
});

test('startOresOtelApm registers enabled instruments, reports pressure, and stop removes everything', async () => {
  const meter = fakeMeter();
  const config = configFrom(
    `[common.metrics.filesystem]\npaths = ["${tmpdir()}", "/definitely/not/a/real/path"]\nmin_free_ratio = 1.0\n`,
  );
  const errors = [];
  const handle = startOresOtelApm({ meter, config, onError: (error) => errors.push(error) });
  await handle.refreshFilesystem();

  assert.ok(meter.collect('process.memory.usage')[0][0] > 0);
  assert.deepEqual(
    meter.collect('process.cpu.time').map(([, attributes]) => attributes['cpu.mode']),
    ['user', 'system'],
  );
  assert.equal(meter.collect('nodejs.eventloop.utilization').length, 1);
  assert.equal(handle.filesystemSamples().length, 1);
  assert.ok(errors.length >= 1, 'the missing path is reported through onError');
  assert.deepEqual(
    meter.collect('system.filesystem.usage').map(([, attributes]) => attributes['system.filesystem.state']),
    ['used', 'free', 'reserved'],
  );
  const pressure = meter.collect('ores.apm.resource.pressure');
  assert.deepEqual(pressure, [
    [1, { 'ores.apm.pressure.kind': 'disk_free_ratio', 'ores.apm.pressure.target': tmpdir() }],
  ]);

  handle.stop();
  handle.stop();
  assert.ok(meter.instruments.every((instrument) => instrument.callbacks.size === 0));
});

test('startOresOtelApm registers nothing when metrics are disabled', () => {
  const meter = fakeMeter();
  const handle = startOresOtelApm({ meter, config: configFrom('[common.metrics]\nenabled = false\n') });
  assert.equal(meter.instruments.length, 0);
  assert.equal(handle.latency.enabled, false);
  handle.stop();
});
