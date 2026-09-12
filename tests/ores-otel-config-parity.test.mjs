// Cross-language parity corpus shared with the Dart and Rust loaders and APM SDKs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

import {
  oresOtelConfigFilePath,
  oresOtelConfigToJson,
  parseOresOtelToml,
  resolveOresOtelConfig,
} from '../dist/config.js';
import { evaluateDiskPressure, pressureObservations } from '../dist/apm.js';

const fixtures = new URL('./fixtures/ores-otel-config/', import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(url, 'utf8'));
const cases = readdirSync(fixtures, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test('fixture corpus contains at least 18 cases', () => {
  assert.ok(cases.length >= 18, `found ${cases.length}`);
});

for (const name of cases) {
  test(`parity: ${name}`, () => {
    const dir = new URL(`${name}/`, fixtures);
    const input = readFileSync(new URL('input.toml', dir), 'utf8');
    const options = readJson(new URL('options.json', dir));
    const expected = readJson(new URL('expected.json', dir));
    const resolve = () =>
      oresOtelConfigToJson(
        resolveOresOtelConfig(parseOresOtelToml(input), {
          env: options.env ?? {},
          flagOverrides: options.flag_overrides ?? {},
          ...(options.role ? { role: options.role } : {}),
        }),
      );
    if (expected.error === true) {
      assert.throws(resolve);
    } else {
      assert.deepStrictEqual(resolve(), expected);
    }
  });
}

const lookup = readJson(new URL('./fixtures/ores-otel-config-lookup.json', import.meta.url));

test('lookup corpus is not empty', () => {
  assert.ok(lookup.cases.length >= 9);
});

for (const item of lookup.cases) {
  test(`lookup: ${item.name}`, () => {
    assert.equal(
      oresOtelConfigFilePath({
        ...(item.cwd === null ? {} : { cwd: item.cwd }),
        ...(item.file_path === null ? {} : { filePath: item.file_path }),
        env: { ...item.env, ...item.flag_overrides },
        currentDirectory: item.current_directory,
      }),
      item.expected,
    );
  });
}

// Shared `ores.apm.resource.pressure` disk series, pinned for TS, Dart and Rust.
const diskPressure = readJson(new URL('./fixtures/ores-otel-apm-disk-pressure.json', import.meta.url));

test('disk-pressure corpus is not empty', () => {
  assert.equal(diskPressure.metric, 'ores.apm.resource.pressure');
  assert.ok(diskPressure.cases.length >= 6);
});

for (const item of diskPressure.cases) {
  test(`disk pressure: ${item.name}`, () => {
    const m = item.measurement;
    const t = item.thresholds;
    const pressure = evaluateDiskPressure(
      {
        path: m.path,
        availableBytes: m.available_bytes,
        capacityBytes: m.capacity_bytes,
        availableInodes: m.available_inodes,
        totalInodes: m.total_inodes,
      },
      {
        ...(t.min_free_bytes === undefined ? {} : { minFreeBytes: t.min_free_bytes }),
        ...(t.min_free_ratio === undefined ? {} : { minFreeRatio: t.min_free_ratio }),
        ...(t.min_inode_free_ratio === undefined ? {} : { minInodeFreeRatio: t.min_inode_free_ratio }),
      },
    );
    assert.deepStrictEqual(
      pressureObservations(pressure.checks).map(([value, attributes]) => ({ value, attributes: { ...attributes } })),
      item.expected,
    );
  });
}
