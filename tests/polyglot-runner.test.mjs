import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { buildSuites } from '../scripts/test-polyglot.mjs';

function dartSuites(files) {
  const available = new Set(files);
  return buildSuites({
    rootDir: path.join(path.sep, 'repo'),
    fileExists: candidate => available.has(path.basename(candidate)),
  }).filter(suite => suite.name.startsWith('Dart'));
}

test('canonical Dart package layout runs pub get, format, and dart test', () => {
  const suites = dartSuites(['conformance_test.dart']);
  assert.deepEqual(
    suites.map(({ name, args }) => ({ name, args })),
    [
      { name: 'Dart dependencies', args: ['pub', 'get'] },
      {
        name: 'Dart format',
        args: ['format', '--output=none', '--set-exit-if-changed', 'lib', 'test'],
      },
      {
        name: 'Dart/Flutter package conformance',
        args: ['test', 'test/conformance_test.dart'],
      },
    ],
  );
});

test('legacy Dart layout remains supported with assertions and context checks', () => {
  const suites = dartSuites(['conformance.dart', 'context_shutdown.dart']);
  assert.deepEqual(
    suites.slice(2).map(({ name, args }) => ({ name, args })),
    [
      {
        name: 'Dart/Flutter wire conformance',
        args: ['--enable-asserts', 'run', 'test/conformance.dart'],
      },
      {
        name: 'Dart/Flutter context and shutdown',
        args: ['--enable-asserts', 'run', 'test/context_shutdown.dart'],
      },
    ],
  );
});

test('missing Dart conformance entrypoints fail closed', () => {
  assert.throws(
    () => dartSuites([]),
    /expected test\/conformance_test\.dart or test\/conformance\.dart/,
  );
});
