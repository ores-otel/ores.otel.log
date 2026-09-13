import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseToml } from '../dist/cli/toml.js';
import {
  loadOresOtelConfig,
  OresOtelConfigError,
  oresOtelConfigToJson,
  parseOresOtelToml,
  resolveOresOtelConfig,
} from '../dist/config.js';

const APM = `
version = 1

[server.metrics]
exemplars = true

[server.metrics.process]
sample_interval_ms = 2500
thread_count = false

[server.metrics.filesystem]
paths = ["/", "/var/lib/data"]
min_free_bytes = 1073741824
min_free_ratio = 0.1
min_inode_free_ratio = 0.05

[server.metrics.latency]
queue_wait_ms = false
histogram_boundaries_ms = [
  1,
  2.5, # fractional boundaries are allowed
  10,
]

[server.metrics.runtime]
gc_pause_ms = false

[server.metrics.saturation]
cpu_ratio_warning = 0.9
queue_depth_warning = 500
`;

test('parses every metrics.* sub-table and resolves camelCase runtime values', () => {
  const config = resolveOresOtelConfig(parseOresOtelToml(APM), { env: {} });
  assert.equal(config.role, 'server');
  assert.equal(config.metrics.exemplars, true);
  assert.equal(config.metrics.process.sampleIntervalMs, 2500);
  assert.equal(config.metrics.process.threadCount, false);
  assert.equal(config.metrics.process.rssBytes, true);
  assert.deepEqual(config.metrics.filesystem.paths, ['/', '/var/lib/data']);
  assert.equal(config.metrics.filesystem.minFreeBytes, 1073741824);
  assert.equal(config.metrics.filesystem.minInodeFreeRatio, 0.05);
  assert.deepEqual(config.metrics.latency.histogramBoundariesMs, [1, 2.5, 10]);
  assert.equal(config.metrics.latency.queueWaitMs, false);
  assert.equal(config.metrics.runtime.gcPauseMs, false);
  assert.equal(config.metrics.saturation.cpuRatioWarning, 0.9);
  assert.equal(config.metrics.saturation.queueDepthWarning, 500);
  assert.equal(config.metrics.saturation.memoryRatioWarning, undefined);
  assert.equal(oresOtelConfigToJson(config).metrics.process.sample_interval_ms, 2500);
});

test('resolved configs are deeply frozen', () => {
  const config = resolveOresOtelConfig(parseOresOtelToml(APM), { env: {} });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.metrics.filesystem.paths));
  assert.throws(() => config.metrics.latency.histogramBoundariesMs.push(1), TypeError);
});

test('integer keys reject float spellings while ratio and boundary keys accept them', () => {
  assert.throws(() => parseOresOtelToml('version = 1.0\n'), /version must equal 1/u);
  assert.throws(
    () => parseOresOtelToml('version = 1\n[common.metrics.filesystem]\nmin_free_bytes = 1e3\n'),
    /must be an integer/u,
  );
  assert.throws(
    () => parseOresOtelToml('version = 1\n[common.metrics.saturation]\nqueue_depth_warning = 10.0\n'),
    /must be an integer/u,
  );
  assert.doesNotThrow(() => parseOresOtelToml('version = 1\n[common.metrics.saturation]\ncpu_ratio_warning = 1\n'));
});

test('flag overrides outrank env and explicit overrides outrank both, all validated', () => {
  const parsed = parseOresOtelToml('version = 1\n[common.logging]\nlevel = "error"\n');
  const config = resolveOresOtelConfig(parsed, {
    env: { ORES_OTEL_LOG_LEVEL: 'debug', ORES_OTEL_METRICS_SAMPLE_INTERVAL_MS: '3000' },
    flagOverrides: { ORES_OTEL_LOG_LEVEL: 'warn' },
    overrides: { metrics: { filesystem: { paths: ['/override'] }, saturation: { memoryRatioWarning: 0.5 } } },
  });
  assert.equal(config.logging.level, 'warn');
  assert.equal(config.metrics.process.sampleIntervalMs, 3000);
  assert.deepEqual(config.metrics.filesystem.paths, ['/override']);
  assert.equal(config.metrics.saturation.memoryRatioWarning, 0.5);

  assert.throws(
    () => resolveOresOtelConfig(parsed, { env: {}, overrides: { exporter: { headers: 'x' } } }),
    OresOtelConfigError,
  );
  assert.throws(
    () => resolveOresOtelConfig(parsed, { env: {}, overrides: { metrics: { latency: { histogramBoundariesMs: [5, 1] } } } }),
    /strictly increasing/u,
  );
  for (const bad of ['[1,', 'a,,b', '[1]', '']) {
    assert.throws(
      () => resolveOresOtelConfig(parsed, { env: { ORES_OTEL_METRICS_FILESYSTEM_PATHS: bad } }),
      OresOtelConfigError,
      bad,
    );
  }
});

test('the shared TOML reader rejects the same malformed inputs as the Dart reader', () => {
  const rejected = [
    ['inline table', 'a = { b = 1 }'],
    ['array of tables', '[[a]]'],
    ['duplicate key', 'a = 1\na = 2'],
    ['duplicate table', '[a]\n[a]'],
    ['mixed array', 'a = [1, "x"]'],
    ['boolean array', 'a = [true]'],
    ['nested array', 'a = [[1]]'],
    ['dotted key', 'a.b = 1'],
    ['literal string', "a = 'x'"],
    ['multi-line string', 'a = """x"""'],
    ['unterminated string', 'a = "x'],
    ['unterminated array', 'a = [1,'],
    ['unsupported escape', 'a = "\\q"'],
    ['leading zero', 'a = 01'],
    ['date', 'a = 2024-01-01'],
    ['missing value', 'a ='],
    ['trailing garbage', 'a = 1 2'],
    ['value redefined as table', 'a = 1\n[a]'],
    ['empty array slot', 'a = [1,,2]'],
  ];
  for (const [label, input] of rejected) {
    assert.throws(() => parseToml(input), Error, label);
  }
  assert.deepEqual(parseToml('[a.b]\nx = 1\n[a]\ny = "\\u00e9"\n'), { a: { b: { x: 1 }, y: 'é' } });
});

test('file lookup honours ORES_OTEL_CONFIG_FILE flags but an explicit cwd outranks them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ores-otel-apm-loader-'));
  await writeFile(join(root, '.ores-otel.toml'), 'version = 1\n[client]\nservice_name = "web"\n');
  const other = join(root, 'other.toml');
  await writeFile(other, 'version = 1\n[server]\nservice_name = "api"\n');

  const fromFlag = await loadOresOtelConfig({
    env: { ORES_OTEL_CONFIG_DIR: root },
    flagOverrides: { ORES_OTEL_CONFIG_FILE: other },
  });
  assert.equal(fromFlag.filePath, other);
  assert.equal(fromFlag.config.serviceName, 'api');

  const fromCwd = await loadOresOtelConfig({ cwd: root, env: {}, flagOverrides: { ORES_OTEL_CONFIG_FILE: other } });
  assert.equal(fromCwd.config.serviceName, 'web');

  const fromDirFlag = await loadOresOtelConfig({ env: {}, flagOverrides: { ORES_OTEL_CONFIG_DIR: `${root}/` } });
  assert.equal(fromDirFlag.filePath, join(root, '.ores-otel.toml'));
});
