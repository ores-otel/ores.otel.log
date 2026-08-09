#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);

async function text(path) {
  return readFile(resolve(root, path), 'utf8');
}

async function exists(path) {
  try {
    await stat(resolve(root, path));
    return true;
  } catch {
    return false;
  }
}

const requiredFiles = [
  'src/otel.ts',
  'src/prometheus.ts',
  'src/loki.ts',
  'src/wasm-logger.ts',
  'src/observability.ts',
  'sdk/go/context.go',
  'sdk/rust/src/context.rs',
  'sdk/java/src/main/java/com/oresoftware/nextloggers/NextLoggers.java',
  'sdk/dart/lib/next_loggers.dart',
  'sdk/erlang/src/next_loggers.erl',
  'sdk/elixir/lib/next_loggers.ex',
];

for (const path of requiredFiles) {
  assert.equal(await exists(path), true, `required observability file is missing: ${path}`);
}

const packageJson = JSON.parse(await text('package.json'));
for (const subpath of ['./otel', './prometheus', './loki', './wasm', './observability']) {
  assert.ok(packageJson.exports[subpath], `missing package export ${subpath}`);
}
for (const path of ['contracts', 'docs']) {
  assert.ok(packageJson.files.includes(path), `npm package omits ${path}`);
}
assert.ok(
  packageJson.files.some(path => path.startsWith('sdk/')),
  'npm package omits native SDK sources',
);

const barrel = await text('src/observability.ts');
for (const moduleName of ['otel', 'prometheus', 'loki', 'wasm-logger']) {
  assert.match(
    barrel,
    new RegExp(`export \\* from './${moduleName}\\.js'`),
    `observability barrel omits ${moduleName}`,
  );
}

const strategies = [
  ['sdk/go/context.go', /context\.Context/, 'Go must propagate context explicitly'],
  ['sdk/rust/src/context.rs', /thread_local!/, 'Rust must declare thread-local sync context'],
  ['sdk/rust/src/context.rs', /PhantomData<Rc<\(\)>>/, 'Rust scope must remain non-Send/non-Sync'],
  ['sdk/java/src/main/java/com/oresoftware/nextloggers/NextLoggers.java', /ThreadLocal<Deque<TraceContext>>/, 'Java must use guarded thread-local context'],
  ['sdk/dart/lib/next_loggers.dart', /runZoned\(/, 'Dart must propagate context through Zones'],
  ['sdk/erlang/src/next_loggers.erl', /erlang:get\(\?CONTEXT_KEY\)/, 'Erlang must use process-local context'],
  ['sdk/elixir/lib/next_loggers.ex', /Process\.get\(@context_key/, 'Elixir must use process-local context'],
];
for (const [path, pattern, message] of strategies) {
  assert.match(await text(path), pattern, message);
}

const schemaFiles = [
  'src/base-logger.ts',
  'sdk/go/logger.go',
  'sdk/rust/src/core.rs',
  'sdk/java/src/main/java/com/oresoftware/nextloggers/NextLoggers.java',
  'sdk/dart/lib/next_loggers.dart',
  'sdk/erlang/src/next_loggers.erl',
  'sdk/elixir/lib/next_loggers.ex',
];
for (const path of schemaFiles) {
  assert.match(await text(path), /next-loggers\/v1/, `${path} drifted from the wire schema`);
}

const inspected = await Promise.all(requiredFiles.map(async (path) => [path, await text(path)]));
const forbidden = [
  [/\b(?:globalThis|global|window)\.(?:fetch|setTimeout|setInterval|Promise)\s*=/, 'global runtime reassignment'],
  [/\bconsole\.(?:log|warn|error|debug|info)\s*=/, 'console method reassignment'],
  [/\.prototype\.[A-Za-z_$][\w$]*\s*=/, 'prototype mutation'],
  [/\bModule\._load\s*=/, 'Node module loader mutation'],
  [/require-in-the-middle|\bshimmer\b/i, 'monkey-patching instrumentation dependency'],
  [/registerInstrumentations\s*\(/, 'automatic instrumentation registration'],
  [/getNodeAutoInstrumentations\s*\(/, 'Node automatic instrumentation'],
];
for (const [path, source] of inspected) {
  for (const [pattern, label] of forbidden) {
    assert.doesNotMatch(source, pattern, `${path} contains forbidden ${label}`);
  }
}

const otel = await text('src/otel.ts');
assert.doesNotMatch(otel, /from ['"]@opentelemetry\//, 'core OTEL bridge must remain SDK-agnostic');
assert.doesNotMatch(otel, /node:async_hooks/, 'OTEL bridge must not own AsyncLocalStorage');
assert.match(otel, /failOnStartError/, 'explicit no-op span fallback option is missing');
assert.match(otel, /metricAttributeKeys/, 'metric cardinality allowlist is missing');

const loki = await text('src/loki.ts');
assert.match(loki, /RESERVED_LABELS/, 'Loki protected labels are not enforced');
assert.match(loki, /maxQueueSize/, 'Loki queue bound is missing');
assert.match(loki, /AbortController/, 'Loki timeout cancellation is missing');
assert.match(loki, /NonRetryableLokiError/, 'Loki terminal 4xx handling is missing');

const prometheus = await text('src/prometheus.ts');
assert.match(prometheus, /maxSeriesPerMetric/, 'Prometheus cardinality guard is missing');
assert.match(prometheus, /dropped_series_total/, 'Prometheus cardinality drop metric is missing');

const wasm = await text('src/wasm-logger.ts');
assert.match(wasm, /TextDecoder\('utf-8', \{ fatal: true \}\)/, 'WASM UTF-8 validation must be fatal');
assert.match(wasm, /maximumPayloadBytes/, 'WASM payload bound is missing');
assert.match(wasm, /outside linear memory/, 'WASM memory bounds check is missing');

const dart = await text('sdk/dart/lib/next_loggers.dart');
assert.match(dart, /class SupabaseTransport/, 'Dart client Supabase transport is missing');
assert.doesNotMatch(dart, /service_role|SUPABASE_SERVICE_ROLE/i, 'client SDK must not embed a Supabase service key');

console.log(`observability contracts: ${requiredFiles.length} files, ${forbidden.length} monkey-patch rules, all passed`);
