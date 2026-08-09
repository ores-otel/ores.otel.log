import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  STRICT_SEMVER_PATTERN,
  isStrictSemVer as isStrictReleaseSemVer,
} from '../scripts/strict-semver.mjs';
import { runPackages } from '../dist/cli/commands/packages.js';
import { CommandContext } from '../dist/cli/context.js';
import { PACKAGE_RELEASES, releaseTag } from '../dist/cli/package-catalog.js';
import { SEMVER_PATTERN, isStrictSemVer } from '../dist/cli/semver.js';
import { findCommand } from '../dist/cli/spec.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const tagVerifier = fileURLToPath(
  new URL('../scripts/verify-release-tag.mjs', import.meta.url),
);
const packageManifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const zpkgSource = await readFile(new URL('../.zpkg.toml', import.meta.url), 'utf8');

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runTagVerifier(target, tag) {
  return spawnSync(process.execPath, [tagVerifier, target, tag], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: '' },
  });
}

async function runFixtureCheck(t, transform, { writeManifest = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'next-loggers-package-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ version: packageManifest.version }),
    'utf8',
  );
  if (writeManifest) {
    await writeFile(join(root, '.zpkg.toml'), transform(zpkgSource), 'utf8');
  }

  const command = findCommand('packages');
  assert.ok(command);
  const stdout = [];
  const stderr = [];
  const result = await runPackages(
    new CommandContext({
      command,
      parsed: {
        NEXT_LOGGER_CLI_JSON: 'true',
        NEXT_LOGGER_CLI_PACKAGES_CHECK: 'true',
        NEXT_LOGGER_CLI_COLOR: 'never',
      },
      positionals: [],
      env: { NO_COLOR: '1' },
      packageRoot: root,
      out: (line) => stdout.push(line),
      err: (line) => stderr.push(line),
      colorCapable: false,
    }),
  );
  return {
    result,
    output: stdout.length === 0 ? undefined : JSON.parse(stdout.join('\n')),
    stderr,
  };
}

test('CLI and release workflows use the identical strict SemVer language', () => {
  assert.equal(SEMVER_PATTERN.source, STRICT_SEMVER_PATTERN.source);

  const valid = [
    '0.0.0',
    '1.2.3',
    '1.2.3-alpha',
    '1.2.3-alpha.1',
    '1.2.3-0.3.7',
    '1.2.3-x.7.z.92',
    '1.2.3+build.001',
    '1.2.3-alpha.1+build.5',
  ];
  const invalid = [
    'v1.2.3',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+',
    '1.2.3+build..1',
  ];
  for (const value of valid) {
    assert.equal(isStrictSemVer(value), true, value);
    assert.equal(isStrictReleaseSemVer(value), true, `release workflow: ${value}`);
  }
  for (const value of invalid) {
    assert.equal(isStrictSemVer(value), false, value);
    assert.equal(isStrictReleaseSemVer(value), false, `release workflow: ${value}`);
    const result = run(['packages', '--release-version', value]);
    assert.equal(result.status, 2, `${value}: ${result.stderr}`);
    assert.match(result.stderr, /must be full semantic versioning/);
  }

  const result = run([
    'packages',
    '--json',
    '--target',
    'zed',
    '--release-version',
    '1.2.3-alpha.1+build.5',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.version, '1.2.3-alpha.1+build.5');
  assert.equal(output.packages[0].tag, 'v1.2.3-alpha.1+build.5');
});

test('every release route verifies its exact immutable tag and rejects a moved version', () => {
  for (const release of PACKAGE_RELEASES) {
    const exactTag = releaseTag(release, packageManifest.version);
    const exact = runTagVerifier(release.target, exactTag);
    assert.equal(exact.status, 0, `${release.target}: ${exact.stderr}`);
    assert.match(exact.stdout, new RegExp(`^${release.target}: verified `));

    const moved = runTagVerifier(release.target, releaseTag(release, '9.9.9'));
    assert.notEqual(moved.status, 0, `${release.target} accepted a mismatched tag`);
    assert.match(moved.stderr, /release tag mismatch/);
  }
});

test('target and registry filters normalize case, whitespace, and duplicates', () => {
  const result = run(['packages', '--json'], {
    NEXT_LOGGER_CLI_PACKAGE_TARGETS: '[" RUBY ","ruby","JAVA"]',
    NEXT_LOGGER_CLI_PACKAGE_REGISTRIES: '["RUBYGEMS","maven-central"]',
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.packages.map((release) => release.target),
    ['java', 'ruby'],
  );
  assert.equal(new Set(output.packages.map((release) => release.target)).size, 2);
});

test('target and registry categories use AND semantics and fail on an empty intersection', () => {
  const result = run([
    'packages',
    '--target',
    'ruby',
    '--registry',
    'maven-central',
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no packages matched/);
});

test('quiet suppresses human tables without suppressing explicit JSON', () => {
  const quiet = run(['packages', '--quiet', '--target', 'zed']);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, '');
  assert.equal(quiet.stderr, '');

  const json = run(['packages', '--quiet', '--json', '--target', 'zed']);
  assert.equal(json.status, 0, json.stderr);
  const output = JSON.parse(json.stdout);
  assert.deepEqual(output.packages.map((release) => release.target), ['zed']);
});

test('JSON checks report version drift structurally and return a failing status', () => {
  const result = run([
    'packages',
    '--json',
    '--check',
    '--release-version',
    '9.9.9',
  ]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.checked, true);
  assert.equal(output.ok, false);
  assert.ok(output.errors.some((error) => error.includes('does not match package.json')));
});

test('catalog checks reject undocumented Zed targets', async (t) => {
  const check = await runFixtureCheck(
    t,
    (source) => `${source}\n[targets.cobol]\ndir = "sdk/cobol"\n`,
  );
  assert.equal(check.result.exitCode, 1);
  assert.equal(check.stderr.length, 0);
  assert.equal(check.output.ok, false);
  assert.ok(
    check.output.errors.some((error) =>
      error.includes('.zpkg.toml declares undocumented target cobol'),
    ),
  );
});

test('catalog checks reject native registry identity drift', async (t) => {
  const check = await runFixtureCheck(t, (source) => {
    const changed = source.replace('registry = "npm"', 'registry = "pnpm"');
    assert.notEqual(changed, source, 'fixture did not contain the npm registry declaration');
    return changed;
  });
  assert.equal(check.result.exitCode, 1);
  assert.equal(check.output.ok, false);
  assert.ok(
    check.output.errors.some((error) =>
      error.includes('targets.nodejs.native.registry'),
    ),
  );
});

test('catalog checks fail closed when repository-only Zed metadata is unavailable', async (t) => {
  const check = await runFixtureCheck(t, (source) => source, { writeManifest: false });
  assert.equal(check.result.exitCode, 1);
  assert.equal(check.output.ok, false);
  assert.ok(
    check.output.errors.some((error) => error.includes('cannot read .zpkg.toml')),
  );
});
