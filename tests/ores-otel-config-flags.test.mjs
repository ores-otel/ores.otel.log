// Fails when contracts/ores-otel.cli-flags.toml and the variables the loaders
// read drift apart in either direction.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parseToml } from '../dist/cli/toml.js';
import { ORES_OTEL_ENV_VARIABLES } from '../dist/config.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const flags = parseToml(read('../contracts/ores-otel.cli-flags.toml')).flags;
const declared = Object.values(flags).map((flag) => flag.env);
const sorted = (values) => [...values].sort();
const NON_VARIABLE_CONSTANTS = new Set([
  'ORES_OTEL_CONFIG_BASENAME',
  'ORES_OTEL_CONFIG_VERSION',
  'ORES_OTEL_ENV_VARIABLES',
  'ORES_OTEL_DEFAULT_HISTOGRAM_BOUNDARIES_MS',
]);

test('every declared flag maps to exactly one loader variable, with no defaults', () => {
  assert.equal(new Set(declared).size, declared.length, 'duplicate env names in the flags fragment');
  assert.deepEqual(sorted(declared), sorted(ORES_OTEL_ENV_VARIABLES));
  for (const [key, flag] of Object.entries(flags)) {
    assert.equal(flag.default, undefined, `${key} must not declare a default`);
    assert.ok(flag.aliases.every((alias) => alias.startsWith('otel-')), `${key} aliases must be otel-*`);
    assert.ok(['string', 'bool', 'integer', 'double', 'array'].includes(flag.type), `${key} has type ${flag.type}`);
  }
});

test('the TypeScript loader source reads no undeclared ORES_OTEL_* variable', () => {
  const literals = new Set(read('../src/ores-otel-config.ts').match(/ORES_OTEL_[A-Z0-9_]+/gu));
  const undeclared = [...literals].filter((name) => !NON_VARIABLE_CONSTANTS.has(name) && !declared.includes(name));
  assert.deepEqual(undeclared, []);
});
