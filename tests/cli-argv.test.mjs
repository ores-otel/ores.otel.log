import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDefaults, parseArgv } from '../dist/cli/argv.js';
import { flagsInScope } from '../dist/cli/spec.js';

const parse = (...argv) => parseArgv(argv);

test('every accepted long and short form maps to the same env var', () => {
  const forms = [
    ['--app-name', 'api'],
    ['--app-name=api'],
    ['-L', 'debug'],
    ['-Ldebug'],
    ['-L=debug'],
  ];
  const expected = ['NEXT_LOGGER_APP_NAME', 'NEXT_LOGGER_APP_NAME', 'NEXT_LOGGER_MAX_LEVEL', 'NEXT_LOGGER_MAX_LEVEL', 'NEXT_LOGGER_MAX_LEVEL'];
  forms.forEach((argv, index) => {
    const result = parse(...argv);
    assert.deepEqual(result.errors, [], `${argv.join(' ')} should parse cleanly`);
    assert.equal(
      result.env[expected[index]] !== undefined,
      true,
      `${argv.join(' ')} did not set ${expected[index]}`,
    );
  });
  assert.equal(parse('--app-name', 'api').env.NEXT_LOGGER_APP_NAME, 'api');
  assert.equal(parse('--app-name=api').env.NEXT_LOGGER_APP_NAME, 'api');
  assert.equal(parse('-Ldebug').env.NEXT_LOGGER_MAX_LEVEL, 'debug');
  assert.equal(parse('-L=debug').env.NEXT_LOGGER_MAX_LEVEL, 'debug');
});

test('bare booleans are true and never consume the next token', () => {
  const result = parse('--json', 'smoke');
  assert.equal(result.env.NEXT_LOGGER_CLI_JSON, 'true');
  assert.equal(result.command?.name, 'smoke');
});

test('booleans accept explicit values and canonicalize them', () => {
  assert.equal(parse('--json=yes').env.NEXT_LOGGER_CLI_JSON, 'true');
  assert.equal(parse('--json=0').env.NEXT_LOGGER_CLI_JSON, 'false');
  assert.equal(parse('--console', '--json').env.NEXT_LOGGER_CONSOLE, 'true');
});

test('--no- negates booleans only', () => {
  assert.equal(parse('--no-json').env.NEXT_LOGGER_CLI_JSON, 'false');
  assert.equal(parse('--no-console').env.NEXT_LOGGER_CONSOLE, 'false');

  // --no- on a string flag is not a valid flag, and must be reported rather
  // than silently ignored.
  const result = parse('--no-app-name');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /unknown flag --no-app-name/);
});

test('a string flag never swallows an option-looking token', () => {
  const result = parse('pretty', '--grep', '--json');
  assert.equal(result.env.NEXT_LOGGER_CLI_GREP, undefined);
  assert.equal(result.env.NEXT_LOGGER_CLI_JSON, 'true', '--json must still parse as a flag');
  assert.match(result.errors[0], /--grep expects a value/);
});

test('short bundling applies only when every letter is a boolean', () => {
  // -q is bool; bundling with another bool works.
  const bundled = parse('-q');
  assert.equal(bundled.env.NEXT_LOGGER_CLI_QUIET, 'true');

  // -p is a string flag on `smoke`, so the tail is an inline value.
  const inline = parse('smoke', '-p/tmp/pkg');
  assert.equal(inline.env.NEXT_LOGGER_CLI_SMOKE_PACKAGE, '/tmp/pkg');
  assert.deepEqual(inline.errors, []);
});

test('-- stops parsing and the remainder become positionals', () => {
  const result = parse('pretty', '--', '--json', 'literal');
  assert.equal(result.env.NEXT_LOGGER_CLI_JSON, undefined);
  assert.deepEqual(result.positionals, ['--json', 'literal']);
});

test('command scope gates which flags resolve', () => {
  // --depth exists only under `smoke`.
  const scoped = parse('smoke', '--depth', 'full');
  assert.deepEqual(scoped.errors, []);
  assert.equal(scoped.env.NEXT_LOGGER_CLI_SMOKE_DEPTH, 'full');

  const unscoped = parse('--depth', 'full');
  assert.match(unscoped.errors[0], /unknown flag --depth/);
});

test('the resolved command is written to the command env var', () => {
  assert.equal(parse('doctor').env.NEXT_LOGGER_CLI_COMMAND, 'doctor');
  assert.equal(parse().env.NEXT_LOGGER_CLI_COMMAND, undefined);
});

test('array flags accumulate across repeats', () => {
  const result = parse('resolve', '--condition', 'node', '--condition', 'import');
  assert.deepEqual(JSON.parse(result.env.NEXT_LOGGER_CLI_CONDITIONS), ['node', 'import']);

  const jsonForm = parse('resolve', '--condition', '["a","b"]');
  assert.deepEqual(JSON.parse(jsonForm.env.NEXT_LOGGER_CLI_CONDITIONS), ['a', 'b']);
});

test('unknown flags are reported, not ignored', () => {
  const result = parse('--totally-unknown', 'x');
  assert.match(result.errors[0], /unknown flag --totally-unknown/);
});

test('--help and --version are recognized at any position', () => {
  assert.equal(parse('--help').helpRequested, true);
  assert.equal(parse('smoke', '--help').helpRequested, true);
  assert.equal(parse('smoke', '--help').command?.name, 'smoke');
  assert.equal(parse('-V').versionRequested, true);
});

test('defaults apply only when argv and the environment are both silent', () => {
  const scope = flagsInScope(undefined);

  const untouched = applyDefaults(scope, {}, {});
  assert.equal(untouched.NEXT_LOGGER_CLI_COLOR, 'auto', 'the declared default should fill in');

  // The documented deviation from upstream flags-2-env: a real environment
  // variable must beat a declared default, never the other way round.
  const fromEnv = applyDefaults(scope, {}, { NEXT_LOGGER_CLI_COLOR: 'never' });
  assert.equal(
    fromEnv.NEXT_LOGGER_CLI_COLOR,
    undefined,
    'a set env var must not be overwritten by a default',
  );

  // Explicit argv still wins over both.
  const fromArgv = applyDefaults(scope, { NEXT_LOGGER_CLI_COLOR: 'always' }, {
    NEXT_LOGGER_CLI_COLOR: 'never',
  });
  assert.equal(fromArgv.NEXT_LOGGER_CLI_COLOR, 'always');
});

test('typed flags reject values they cannot hold', () => {
  const badBool = parse('--console=maybe');
  assert.match(badBool.errors[0], /expects a boolean/);

  const badArray = parse('resolve', '--condition', '{"not":"an array"}');
  assert.match(badArray.errors[0], /expects a JSON array/);
});
