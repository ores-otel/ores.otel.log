import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contracts = [
  {
    name: 'TypeScript/JavaScript',
    sources: ['src/otel.ts', 'src/base-logger.ts'],
    tests: ['tests/otel.test.mjs', 'tests/transports.test.mjs'],
    markers: ['OpenTelemetryTransport', 'SupabaseRealtimeTransport'],
  },
  {
    name: 'Python',
    sources: ['sdk/python/src/next_loggers/__init__.py'],
    tests: ['sdk/python/tests/test_conformance.py'],
    markers: ['OpenTelemetryTransport', 'SupabaseTransport'],
  },
  {
    name: 'Go',
    sources: ['sdk/go/logger.go'],
    tests: ['sdk/go/logger_test.go'],
    markers: ['OpenTelemetryTransport', 'SupabaseTransport'],
  },
  {
    name: 'Rust',
    sources: ['sdk/rust/src/lib.rs'],
    tests: ['sdk/rust/tests/conformance.rs'],
    markers: ['OpenTelemetryTransport', 'SupabaseTransport'],
  },
  {
    name: 'Gleam',
    sources: ['sdk/gleam/src/oresoftware_next_loggers.gleam'],
    tests: ['sdk/gleam/test/oresoftware_next_loggers_test.gleam'],
    markers: ['otel_transport', 'supabase_transport'],
  },
  {
    name: 'Java',
    sources: ['sdk/java/src/main/java/cloud/oresoftware/nextloggers/NextLoggers.java'],
    tests: ['sdk/java/src/test/java/cloud/oresoftware/nextloggers/NextLoggersTest.java'],
    markers: ['OtelTransport', 'SupabaseTransport'],
  },
  {
    name: 'Dart/Flutter',
    sources: ['sdk/dart/lib/next_loggers.dart'],
    tests: ['sdk/dart/test/conformance.dart'],
    markers: ['OpenTelemetryTransport', 'SupabaseTransport'],
  },
  {
    name: 'Ruby',
    sources: ['sdk/ruby/lib/oresoftware/next_loggers.rb'],
    tests: ['sdk/ruby/test/next_loggers_test.rb'],
    markers: ['OtelTransport', 'SupabaseTransport'],
  },
  {
    name: 'Erlang',
    sources: ['sdk/erlang/src/next_loggers.erl'],
    tests: ['sdk/erlang/test/next_loggers_tests.erl'],
    markers: ['otel_transport', 'supabase_transport'],
  },
  {
    name: 'Elixir',
    sources: ['sdk/elixir/lib/next_loggers.ex'],
    tests: ['sdk/elixir/test/next_loggers_test.exs'],
    markers: ['otel_transport', 'supabase_transport'],
  },
  {
    name: 'Rust/WebAssembly',
    sources: ['sdk/wasm/src/lib.rs'],
    tests: ['sdk/wasm/tests/conformance.rs'],
    markers: ['OpenTelemetryTransport', 'SupabaseTransport'],
  },
];

for (const contract of contracts) {
  test(`${contract.name} exposes and tests explicit OTEL and Supabase transports`, async () => {
    const source = (await Promise.all(contract.sources.map(path => readFile(path, 'utf8')))).join('\n');
    const tests = (await Promise.all(contract.tests.map(path => readFile(path, 'utf8')))).join('\n');

    for (const marker of contract.markers) {
      const pattern = new RegExp(marker, 'i');
      assert.match(source, pattern, `${contract.name} source lacks ${marker}`);
      assert.match(tests, pattern, `${contract.name} tests lack ${marker}`);
    }
  });
}
