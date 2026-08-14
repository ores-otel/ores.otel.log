import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contracts = [
  {
    name: 'TypeScript/JavaScript',
    source: ['src/base-logger.ts', 'src/otel.ts'],
    tests: ['tests/event-api.test.mjs', 'tests/otel.test.mjs'],
    docs: ['README.md', 'docs/otel.md'],
    markers: ['useOtel', 'notOtel', 'withOtel', 'resetOtel', 'isOtelEnabled'],
    testMarkers: ['useOtel', 'notOtel'],
  },
  {
    name: 'Python',
    source: ['sdk/python/src/next_loggers/__init__.py'],
    tests: ['sdk/python/tests/test_conformance.py'],
    docs: ['sdk/python/README.md'],
    markers: ['use_otel', 'not_otel', 'with_otel', 'reset_otel', 'is_otel_enabled'],
    testMarkers: ['use_otel', 'not_otel'],
  },
  {
    name: 'Go',
    source: ['sdk/go/logger.go'],
    tests: ['sdk/go/logger_test.go'],
    docs: ['sdk/go/README.md'],
    markers: ['UseOtel', 'NotOtel', 'WithOtel', 'ResetOtel', 'IsOtelEnabled'],
    testMarkers: ['UseOtel', 'NotOtel'],
  },
  {
    name: 'Rust',
    source: ['sdk/rust/src/core.rs'],
    tests: ['sdk/rust/tests/conformance.rs'],
    docs: ['sdk/rust/README.md'],
    markers: ['use_otel', 'not_otel', 'with_otel', 'reset_otel', 'is_otel_enabled'],
    testMarkers: ['use_otel', 'not_otel'],
  },
  {
    name: 'Gleam',
    source: ['sdk/gleam/src/oresoftware_next_loggers.gleam'],
    tests: ['sdk/gleam/test/oresoftware_next_loggers_test.gleam'],
    docs: ['sdk/gleam/README.md'],
    markers: ['event_use_otel', 'event_not_otel', 'with_otel', 'reset_otel', 'is_otel_enabled'],
    testMarkers: ['event_use_otel', 'event_not_otel'],
  },
  {
    name: 'Java',
    source: ['sdk/java/src/main/java/cloud/oresoftware/nextloggers/NextLoggers.java'],
    tests: ['sdk/java/src/test/java/cloud/oresoftware/nextloggers/NextLoggersTest.java'],
    docs: ['sdk/java/README.md'],
    markers: ['useOtel', 'notOtel', 'withOtel', 'resetOtel', 'isOtelEnabled'],
    testMarkers: ['useOtel', 'notOtel'],
  },
  {
    name: 'Dart/Flutter',
    source: ['sdk/dart/lib/next_loggers.dart'],
    tests: ['sdk/dart/test/conformance_test.dart'],
    docs: ['sdk/dart/README.md'],
    markers: ['useOtel', 'notOtel', 'withOtel', 'resetOtel', 'isOtelEnabled'],
    testMarkers: ['useOtel', 'notOtel'],
  },
  {
    name: 'Ruby',
    source: ['sdk/ruby/lib/oresoftware/next_loggers.rb'],
    tests: ['sdk/ruby/test/next_loggers_test.rb'],
    docs: ['sdk/ruby/README.md'],
    markers: ['use_otel', 'not_otel', 'with_otel', 'reset_otel', 'otel_enabled?'],
    testMarkers: ['use_otel', 'not_otel'],
  },
  {
    name: 'Erlang',
    source: ['sdk/erlang/src/next_loggers.erl'],
    tests: ['sdk/erlang/test/next_loggers_tests.erl'],
    docs: ['sdk/erlang/README.md'],
    markers: ['use_otel', 'not_otel', 'with_otel', 'reset_otel', 'is_otel_enabled'],
    testMarkers: ['use_otel', 'not_otel'],
  },
  {
    name: 'Elixir',
    source: ['sdk/elixir/lib/next_loggers.ex'],
    tests: ['sdk/elixir/test/next_loggers_test.exs'],
    docs: ['sdk/elixir/README.md'],
    markers: ['use_otel', 'not_otel', 'with_otel', 'reset_otel', 'is_otel_enabled'],
    testMarkers: ['use_otel', 'not_otel'],
  },
  {
    name: 'Rust/WebAssembly',
    source: ['sdk/wasm/src/lib.rs'],
    tests: ['sdk/wasm/tests/conformance.rs'],
    docs: ['sdk/wasm/README.md'],
    markers: ['use_otel', 'not_otel', 'with_otel', 'reset_otel', 'is_otel_enabled'],
    testMarkers: ['use_otel', 'not_otel'],
  },
];

async function combined(paths) {
  return (await Promise.all(paths.map((path) => readFile(path, 'utf8')))).join('\n');
}

test('per-event OpenTelemetry routing stays structurally aligned across all 11 SDKs', async () => {
  assert.equal(contracts.length, 11);
  for (const contract of contracts) {
    const [source, tests, docs] = await Promise.all([
      combined(contract.source),
      combined(contract.tests),
      combined(contract.docs),
    ]);
    for (const marker of contract.markers) {
      assert.ok(source.includes(marker), `${contract.name} source lacks ${marker}`);
      assert.ok(docs.includes(marker), `${contract.name} docs lack ${marker}`);
    }
    for (const marker of contract.testMarkers) {
      assert.ok(tests.includes(marker), `${contract.name} tests lack ${marker}`);
    }
    assert.match(source, /opentelemetry/i, `${contract.name} lacks an OTEL transport marker`);
  }
});
