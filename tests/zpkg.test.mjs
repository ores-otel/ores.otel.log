import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseToml } from '../dist/cli/toml.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = parseToml(await read('.zpkg.toml'));
const pkg = JSON.parse(await read('package.json'));
const nodePackage = JSON.parse(await read('sdk/nodejs/package.json'));
const rustCargo = await read('sdk/rust/Cargo.toml');
const zedInclude = await read('.zedinclude');
const zedCliCommit = '5cef340b85b91f77c8b8644ac66e3534f58f85b6';
const interfacesCommit = '6b2e674464933a4de38785c03c33564661290454';
const checkoutCommit = '3d3c42e5aac5ba805825da76410c181273ba90b1';

const expectedTargets = {
  repository: { dir: '.', adapter: 'none' },
  contracts: { dir: 'contracts', name: 'next-loggers-contracts', adapter: 'none' },
  'k8s-sidecar': { dir: 'sidecar', name: 'otel-k8s-sidecar', adapter: 'none' },
  nodejs: {
    dir: 'sdk/nodejs',
    name: 'next-loggers-nodejs',
    adapter: 'node',
    native: {
      registry: 'npm',
      package: '@oresoftware/next-loggers',
      tag_format: 'sdk/nodejs/v{version}',
    },
  },
  python: {
    dir: 'sdk/python',
    name: 'next-loggers-python',
    adapter: 'python',
    native: {
      registry: 'pypi',
      package: 'oresoftware-next-loggers',
      tag_format: 'sdk/python/v{version}',
    },
  },
  golang: {
    dir: 'sdk/go',
    name: 'next-loggers-golang',
    adapter: 'go',
    native: {
      registry: 'go-modules',
      package: 'github.com/ores-otel/ores.otel.log/sdk/go',
      tag_format: 'sdk/go/v{version}',
    },
  },
  rust: {
    dir: 'sdk/rust',
    name: 'next-loggers-rust',
    adapter: 'rust',
    native: {
      registry: 'crates-io',
      package: 'oresoftware-next-loggers',
      tag_format: 'sdk/rust/v{version}',
    },
  },
  'rust-wasm': {
    dir: 'sdk/wasm',
    name: 'next-loggers-rust-wasm',
    adapter: 'rust',
    ecosystem: 'cargo',
    native: {
      registry: 'crates-io',
      package: 'oresoftware-next-loggers-wasm',
      tag_format: 'sdk/wasm/v{version}',
    },
  },
  java: {
    dir: 'sdk/java',
    name: 'next-loggers-java',
    adapter: 'java',
    native: {
      registry: 'maven-central',
      package: 'io.github.oresoftware:next-loggers',
      tag_format: 'sdk/java/v{version}',
    },
  },
  dart: {
    dir: 'sdk/dart',
    name: 'next-loggers-dart',
    adapter: 'dart',
    native: {
      registry: 'pub.dev',
      package: 'oresoftware_next_loggers',
      tag_format: 'sdk/dart/v{version}',
    },
  },
  ruby: {
    dir: 'sdk/ruby',
    name: 'next-loggers-ruby',
    adapter: 'none',
    native: {
      registry: 'rubygems',
      package: 'oresoftware-next-loggers',
      tag_format: 'sdk/ruby/v{version}',
    },
  },
  'rust-context': {
    dir: 'sdk/rust-context',
    name: 'next-loggers-rust-context',
    adapter: 'rust',
    ecosystem: 'cargo',
    native: {
      registry: 'crates-io',
      package: 'oresoftware-next-loggers-context',
      tag_format: 'sdk/rust-context/v{version}',
    },
  },
  'rust-otel': {
    dir: 'sdk/rust-otel',
    name: 'next-loggers-rust-otel',
    adapter: 'rust',
    ecosystem: 'cargo',
    native: {
      registry: 'crates-io',
      package: 'oresoftware-next-loggers-otel',
      tag_format: 'sdk/rust-otel/v{version}',
    },
  },
  gleam: { dir: 'sdk/gleam', name: 'next-loggers-gleam', adapter: 'none' },
  erlang: { dir: 'sdk/erlang', name: 'next-loggers-erlang', adapter: 'none' },
  elixir: { dir: 'sdk/elixir', name: 'next-loggers-elixir', adapter: 'none' },
};

const expectedLifecyclePhases = [
  'pre-install', 'post-install', 'pre-build', 'post-build', 'pre-pack', 'pre-publish',
];

function capture(text, expression, label) {
  const value = text.match(expression)?.[1];
  assert.ok(value, `${label} version was not found`);
  return value;
}

test('.zpkg.toml and package.json agree on the root Zed identity', () => {
  assert.equal(manifest.package.version, pkg.version);
  assert.equal(manifest.package.description, pkg.description);
  assert.equal(manifest.package.license, pkg.license);
  assert.deepEqual(manifest.package.keywords, pkg.keywords);
  assert.equal(`@${manifest.package.org}/${manifest.package.name}`, pkg.name);
});

test('Zed lifecycle phases use reviewed executable repository hooks', async () => {
  assert.equal(
    manifest.lifecycle,
    undefined,
    'convention hooks avoid the manifest field until zed validate accepts it',
  );
  for (const phase of expectedLifecyclePhases) {
    const path = new URL(`../.zed/${phase}`, import.meta.url);
    const metadata = await stat(path);
    assert.equal(metadata.isFile(), true, `.zed/${phase} must be a regular file`);
    assert.notEqual(metadata.mode & 0o111, 0, `.zed/${phase} must be executable`);
    assert.match(await read(`.zed/${phase}`), /^#!\/usr\/bin\/env sh\nset -eu\n/u);
  }
});

test('all language slices are explicit, unique, and registry-correct', () => {
  assert.deepEqual(Object.keys(manifest.targets).sort(), Object.keys(expectedTargets).sort());
  const dirs = new Set();
  const names = new Set();
  const tags = new Set();
  for (const [target, expected] of Object.entries(expectedTargets)) {
    const actual = manifest.targets[target];
    assert.deepEqual(actual, expected, `${target} target drifted`);
    assert.equal(dirs.has(actual.dir), false, `duplicate target directory: ${actual.dir}`);
    if (actual.name === undefined) {
      assert.equal(target, 'repository', `only the canonical root target may omit name: ${target}`);
    } else {
      assert.equal(names.has(actual.name), false, `duplicate Zed target name: ${actual.name}`);
      names.add(actual.name);
    }
    dirs.add(actual.dir);
    if (actual.native) {
      assert.equal(tags.has(actual.native.tag_format), false, `duplicate native tag: ${actual.native.tag_format}`);
      tags.add(actual.native.tag_format);
    }
  }
});

test('Go uses the required nested-module tag prefix', () => {
  assert.equal(manifest.targets.golang.native.package, 'github.com/ores-otel/ores.otel.log/sdk/go');
  assert.equal(manifest.targets.golang.native.tag_format, 'sdk/go/v{version}');
});

test('BEAM targets remain first-class Zed packages while Hex is released externally', () => {
  for (const target of ['gleam', 'erlang', 'elixir']) {
    assert.equal(manifest.targets[target].native, undefined);
    assert.equal(manifest.targets[target].adapter, 'none');
  }
});

test('root publish metadata is target-safe', () => {
  assert.equal(manifest.bin, undefined, 'a root bin would leak the Node CLI into every target');
  assert.equal(manifest.install, undefined, 'target adapters own installation behavior');
  assert.equal(manifest.scripts, undefined, 'root lifecycle scripts would leak into every target');
  assert.equal(manifest.publish.include_readme, true);
  assert.equal(manifest.publish.tag_format, 'v{version}');
  assert.equal(manifest.publish.smoke_test, 'sh "$ZED_PKG_TEST_TARGET/.zpkg-smoke.sh"');
  for (const pattern of [
    '.github/**',
    '.r2g/**',
    '**/pubspec.lock',
    '**/target/**',
    '**/*.egg-info/**',
    '**/*.gem',
    '**/test.sh',
  ]) {
    assert.ok(manifest.publish.exclude.includes(pattern), `publish.exclude should strip ${pattern}`);
  }
});

test('generated Node release files use a bounded Zed allowlist', () => {
  const patterns = zedInclude
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(patterns, [
    'dist/**',
    'sdk/nodejs/.cli-flags.toml',
    'sdk/nodejs/LICENSE',
    'sdk/nodejs/README.md',
    'sdk/nodejs/dist/**',
    'sdk/nodejs/src/**',
  ]);
  assert.equal(patterns.some((pattern) => ['*', '**', '**/*'].includes(pattern)), false);
});

test('the Rust SDK exact-pins the audited time release', () => {
  assert.match(rustCargo, /^rust-version = "1\.88"$/mu);
  assert.match(
    rustCargo,
    /^time = \{ version = "=0\.3\.54", features = \["formatting"\] \}$/mu,
  );
  assert.doesNotMatch(rustCargo, /^time = \{ version = "(?:0\.3|=0\.3\.36)",/mu);
});

test('the root and every slice carry a target-local smoke contract', async () => {
  await access(new URL('../.zpkg-smoke.sh', import.meta.url));
  for (const { dir } of Object.values(expectedTargets)) {
    const smoke = await read(`${dir}/.zpkg-smoke.sh`);
    assert.match(smoke, /ZED_PKG_TEST_TARGET/);
    assert.match(smoke, /\.zpkg\.toml/);
  }
});

test('all native package versions are synchronized', async () => {
  const versions = new Map([
    ['root npm/Zed', pkg.version],
    ['staged npm', nodePackage.version],
    ['Python', capture(await read('sdk/python/pyproject.toml'), /^version\s*=\s*"([^"]+)"/m, 'Python')],
    ['Rust', capture(await read('sdk/rust/Cargo.toml'), /^version\s*=\s*"([^"]+)"/m, 'Rust')],
    ['WASM', capture(await read('sdk/wasm/Cargo.toml'), /^version\s*=\s*"([^"]+)"/m, 'WASM')],
    // Two publishable crates sat outside this check entirely, so they could
    // ship a version no other artifact reported.
    [
      'Rust context',
      capture(await read('sdk/rust-context/Cargo.toml'), /^version\s*=\s*"([^"]+)"/m, 'Rust context'),
    ],
    [
      'Rust OTEL',
      capture(await read('sdk/rust-otel/Cargo.toml'), /^version\s*=\s*"([^"]+)"/m, 'Rust OTEL'),
    ],
    // The gemspec is the artifact RubyGems publishes. It carried its own
    // literal, unchecked by anything, so it could ship a version the library
    // did not report.
    [
      'Ruby gemspec',
      capture(
        await read('sdk/ruby/oresoftware-next-loggers.gemspec'),
        /spec\.version\s*=\s*(.+)$/m,
        'Ruby gemspec',
      ).trim().replace(/^"|"$/g, ''),
    ],
    ['Java', capture(await read('sdk/java/pom.xml'), /<version>([^<]+)<\/version>/, 'Java')],
    ['Dart', capture(await read('sdk/dart/pubspec.yaml'), /^version:\s*([^\s]+)$/m, 'Dart')],
    ['Ruby', capture(await read('sdk/ruby/lib/oresoftware/next_loggers/version.rb'), /VERSION\s*=\s*"([^"]+)"/, 'Ruby')],
    ['Gleam', capture(await read('sdk/gleam/gleam.toml'), /^version\s*=\s*"([^"]+)"/m, 'Gleam')],
    ['Erlang', capture(await read('sdk/erlang/src/oresoftware_next_loggers_erlang.app.src'), /\{vsn,\s*"([^"]+)"\}/, 'Erlang')],
    ['Elixir', capture(await read('sdk/elixir/mix.exs'), /@version\s+"([^"]+)"/, 'Elixir')],
  ]);
  for (const [name, version] of versions) {
    if (version === 'ORESoftware::NextLoggers::VERSION') {
      // Derived from lib/oresoftware/next_loggers/version.rb, checked on its
      // own row above; there is no second literal to drift.
      continue;
    }
    assert.equal(version, pkg.version, `${name} version drifted`);
  }
});

test('the staged npm manifest is publish-only and preserves the public surface', () => {
  assert.equal(nodePackage.name, pkg.name);
  assert.equal(nodePackage.version, pkg.version);
  assert.deepEqual(nodePackage.exports, pkg.exports);
  assert.deepEqual(nodePackage.bin, pkg.bin);
  assert.equal(nodePackage.scripts, undefined);
  assert.equal(nodePackage.devDependencies, undefined);
  assert.equal(nodePackage.repository.directory, 'sdk/nodejs');
});

test('release tags are fail-closed', () => {
  const good = spawnSync(process.execPath, ['scripts/verify-release-tag.mjs', 'nodejs', `sdk/nodejs/v${pkg.version}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(good.status, 0, good.stderr);
  const bad = spawnSync(process.execPath, ['scripts/verify-release-tag.mjs', 'nodejs', `v${pkg.version}`], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /tag mismatch/);
});

test('the repository URL and slugs satisfy Zed validation', () => {
  const slug = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  assert.match(manifest.package.org, slug);
  assert.match(manifest.package.name, slug);
  for (const [key, target] of Object.entries(manifest.targets)) {
    if (target.name === undefined) {
      assert.equal(key, 'repository', `only the canonical root target may omit name: ${key}`);
    } else {
      assert.match(target.name, slug);
    }
  }
  assert.equal(manifest.package.repository.vcs, 'git');
  assert.match(manifest.package.repository.url, /^(?:https?|ssh|git|git\+ssh):\/\//);
});

test('the Zed manifest declares the canonical interface dependency', () => {
  assert.deepEqual(manifest.dependencies, {
    'ores-otel/ores-interfaces': '^0.1.0',
  });
  assert.equal(pkg.dependencies, undefined);
});

test('Zed roundtrip workflows seed the canonical interface dependency hermetically', async () => {
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/packaging.yml']) {
    const workflow = await read(path);
    assert.match(workflow, /permissions:\n(?:[^\n]*\n)*?\s+contents: read/u, `${path} must be read-only`);
    assert.ok(
      workflow.includes(`uses: actions/checkout@${checkoutCommit} # v7`),
      `${path} must use the reviewed checkout commit`,
    );
    assert.ok(workflow.includes(`ref: ${interfacesCommit}`), `${path} must pin ores-interfaces`);
    assert.match(workflow, new RegExp(`--rev\\s+${zedCliCommit}`, 'u'), `${path} must pin zed-cli`);
    assert.match(
      workflow,
      /zed \\\n\s+--registry "file:\/\/\$registry" \\\n\s+--home "\$RUNNER_TEMP\/zed-seed-home" \\\n\s+publish --skip-vcs-checks/u,
      `${path} must seed its file registry in an isolated home`,
    );
    assert.match(
      workflow,
      /--registry "file:\/\/\$registry" \\\n\s+--home "\$RUNNER_TEMP\/zed-home" \\\n\s+r2g --r2g-root/u,
      `${path} must roundtrip against the seeded registry in an isolated home`,
    );
  }
});

test('the eslint plugin version tracks package.json', async () => {
  const source = await read('src/eslint-plugin.ts');
  const declared = source.match(/version:\s*'([^']+)'/)?.[1];
  assert.equal(declared, pkg.version);
});
