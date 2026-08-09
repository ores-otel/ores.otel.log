import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensions = new Set(['.ts', '.js', '.mjs', '.rs', '.go', '.java', '.erl', '.ex', '.exs', '.dart', '.gleam']);
const ignored = new Set(['node_modules', 'dist', 'build', 'target', '.git']);
const telemetrySourceNames = new Set([
  'browser-stream.ts',
  'otel.ts',
  'prometheus.ts',
  'supabase.ts',
  'supabase-ingest.ts',
]);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...await sourceFiles(filename));
    } else if (extensions.has(path.extname(entry.name))) {
      results.push(filename);
    }
  }
  return results;
}

// Match a direct assignment without treating equality checks (`===`) as writes.
const assignment = '=(?!=|>)';

test('telemetry integrations contain no automatic instrumentation or runtime monkey patching', async () => {
  const files = [
    ...(await sourceFiles(path.join(root, 'src'))).filter((filename) =>
      telemetrySourceNames.has(path.basename(filename)),
    ),
    ...(await sourceFiles(path.join(root, 'sdk'))),
  ];
  const forbidden = [
    ['automatic instrumentation registration', /registerInstrumentations\s*\(/u],
    ['global tracer provider registration', /setGlobalTracerProvider\s*\(/u],
    ['global meter provider registration', /setGlobalMeterProvider\s*\(/u],
    ['global logger provider registration', /setGlobalLoggerProvider\s*\(/u],
    ['require-in-the-middle hook', /require-in-the-middle/u],
    ['shimmer hook', /(?:from|require\s*\()\s*['"]shimmer['"]/u],
    ['Node module loader interception', new RegExp(`Module\\s*\\.\\s*_load\\s*${assignment}`, 'u')],
    ['prototype replacement', new RegExp(`\\.\\s*prototype\\s*\\.[\\w$]+\\s*${assignment}`, 'u')],
    ['console replacement', new RegExp(`console\\s*\\.\\s*(?:log|debug|info|warn|error)\\s*${assignment}`, 'u')],
    ['global fetch replacement', new RegExp(`globalThis\\s*\\.\\s*fetch\\s*${assignment}`, 'u')],
  ];

  for (const filename of files) {
    const source = await readFile(filename, 'utf8');
    for (const [description, pattern] of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${description} is forbidden in ${path.relative(root, filename)}`,
      );
    }
  }
});
