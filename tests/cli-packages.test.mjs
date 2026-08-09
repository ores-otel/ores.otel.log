import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PACKAGE_RELEASES,
  RELEASE_TARGET_NAMES,
  ZED_TARGET_NAMES,
  releaseTag,
} from '../dist/cli/package-catalog.js';
import { parseToml } from '../dist/cli/toml.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const zpkg = parseToml(await read('.zpkg.toml'));
const cliDocs = await read('docs/CLI.md');
const releasingDocs = await read('docs/RELEASING.md');
const nativeWorkflow = await read('.github/workflows/release-native.yml');
const zedWorkflow = await read('.github/workflows/release-zed.yml');
const tagVerifier = await read('scripts/verify-release-tag.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('the package catalog has one independent route per documented release target', () => {
  assert.deepEqual(
    PACKAGE_RELEASES.map((release) => release.target),
    RELEASE_TARGET_NAMES,
  );
  assert.equal(
    new Set(PACKAGE_RELEASES.map((release) => release.target)).size,
    PACKAGE_RELEASES.length,
  );
  assert.equal(
    new Set(PACKAGE_RELEASES.map((release) => release.tagFormat)).size,
    PACKAGE_RELEASES.length,
  );
  for (const release of PACKAGE_RELEASES) {
    assert.match(releaseTag(release, pkg.version), /v\d+\.\d+\.\d+/);
    assert.ok(release.packageName.length > 2);
    assert.ok(release.environment.length > 1);
  }
});

test('the compiled catalog agrees with every Zed native mirror declaration', () => {
  assert.deepEqual(Object.keys(zpkg.targets).sort(), [...ZED_TARGET_NAMES].sort());
  const zed = PACKAGE_RELEASES.find((release) => release.target === 'zed');
  assert.ok(zed);
  assert.equal(`${zpkg.package.org}/${zpkg.package.name}`, zed.packageName);
  assert.equal(zpkg.publish.tag_format, zed.tagFormat);

  for (const release of PACKAGE_RELEASES) {
    if (release.target === 'zed') continue;
    const target = zpkg.targets[release.zedTarget];
    assert.ok(target, `missing Zed target ${release.zedTarget}`);
    assert.equal(target.dir, release.directory);
    if (release.manifestNative) {
      assert.deepEqual(target.native, {
        registry: release.registry,
        package: release.packageName,
        tag_format: release.tagFormat,
      });
    } else {
      assert.equal(
        target.native,
        undefined,
        `${release.target} should be released to Hex outside the Zed mirror adapter`,
      );
    }
  }
});

test('next-loggers packages emits a checked, filterable machine-readable release plan', () => {
  const result = run([
    'packages',
    '--json',
    '--check',
    '--target',
    'ruby',
    '--target',
    'java',
    '--release-version',
    pkg.version,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, 'packages');
  assert.equal(output.checked, true);
  assert.equal(output.ok, true);
  assert.deepEqual(
    output.packages.map((release) => release.target),
    ['java', 'ruby'],
  );
  assert.equal(output.packages[0].registry, 'maven-central');
  assert.equal(output.packages[1].registry, 'rubygems');
});

test('package filters are equally usable through flags-2-env environment variables', () => {
  const result = run(['packages'], {
    NEXT_LOGGER_CLI_JSON: 'true',
    NEXT_LOGGER_CLI_PACKAGES_CHECK: 'true',
    NEXT_LOGGER_CLI_PACKAGE_TARGETS: '["nodejs","golang"]',
    NEXT_LOGGER_CLI_PACKAGE_REGISTRIES: '["npm","go-modules"]',
    NEXT_LOGGER_CLI_RELEASE_VERSION: pkg.version,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(
    output.packages.map((release) => release.target),
    ['nodejs', 'golang'],
  );
  assert.deepEqual(
    output.packages.map((release) => release.registry),
    ['npm', 'go-modules'],
  );
});

test('package planning fails closed on unknown targets and unbumped versions', () => {
  const unknown = run(['packages', '--target', 'cobol']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown package target/);

  const unbumped = run(['packages', '--check', '--release-version', '999.0.0']);
  assert.equal(unbumped.status, 1);
  assert.match(unbumped.stderr, /does not match package\.json/);
});

test('release workflows and the tag verifier use the compiled catalog prefixes', () => {
  for (const release of PACKAGE_RELEASES) {
    const workflow = release.target === 'zed' ? zedWorkflow : nativeWorkflow;
    const wildcardTag = release.tagFormat.replace('{version}', '*');
    const prefix = release.tagFormat.replace('{version}', '');
    assert.ok(workflow.includes(wildcardTag), `${wildcardTag} missing from release workflow`);
    assert.ok(
      workflow.includes(`environment: ${release.environment}`),
      `${release.environment} missing from release workflow`,
    );
    assert.ok(
      workflow.includes(`verify-release-tag.mjs ${release.target}`),
      `${release.target} does not invoke the fail-closed tag verifier`,
    );
    assert.ok(
      tagVerifier.includes(`prefix: '${prefix}'`),
      `${release.target} prefix ${prefix} missing from verify-release-tag.mjs`,
    );
  }
});

test('CLI and release docs enumerate every registry identity, tag, and environment', () => {
  for (const release of PACKAGE_RELEASES) {
    for (const docs of [cliDocs, releasingDocs]) {
      assert.ok(docs.includes(release.packageName), `${release.packageName} missing from docs`);
      assert.ok(
        docs.includes(release.tagFormat.replace('{version}', 'X.Y.Z')),
        `${release.tagFormat} missing from docs`,
      );
      assert.ok(
        docs.includes(`\`${release.environment}\``),
        `${release.environment} environment missing from docs`,
      );
    }
  }
});
