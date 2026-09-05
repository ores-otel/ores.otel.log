#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { isStrictSemVer } from './strict-semver.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');

const textVersion = (path, expression, label) => async () => {
  const text = await readFile(join(root, path), 'utf8');
  const version = text.match(expression)?.[1];
  if (!version) throw new Error(`could not read ${label} version from ${path}`);
  return version;
};

const jsonVersion = (path) => async () => {
  const value = JSON.parse(await readFile(join(root, path), 'utf8'));
  if (typeof value.version !== 'string') throw new Error(`${path} has no string version`);
  return value.version;
};

const releases = {
  zed: { prefix: 'v', version: jsonVersion('package.json') },
  nodejs: { prefix: 'sdk/nodejs/v', version: jsonVersion('sdk/nodejs/package.json') },
  python: {
    prefix: 'sdk/python/v',
    version: textVersion('sdk/python/pyproject.toml', /^version\s*=\s*"([^"]+)"/m, 'Python'),
  },
  golang: { prefix: 'sdk/go/v', version: jsonVersion('package.json') },
  rust: {
    prefix: 'sdk/rust/v',
    version: textVersion('sdk/rust/Cargo.toml', /^version\s*=\s*"([^"]+)"/m, 'Rust'),
  },
  'rust-context': {
    prefix: 'sdk/rust-context/v',
    version: textVersion('sdk/rust-context/Cargo.toml', /^version\s*=\s*"([^"]+)"/m, 'Rust context'),
  },
  'rust-otel': {
    prefix: 'sdk/rust-otel/v',
    version: textVersion('sdk/rust-otel/Cargo.toml', /^version\s*=\s*"([^"]+)"/m, 'Rust OTEL'),
  },
  wasm: {
    prefix: 'sdk/wasm/v',
    version: textVersion('sdk/wasm/Cargo.toml', /^version\s*=\s*"([^"]+)"/m, 'WASM'),
  },
  java: {
    prefix: 'sdk/java/v',
    version: textVersion('sdk/java/pom.xml', /<version>([^<]+)<\/version>/, 'Java'),
  },
  dart: {
    prefix: 'sdk/dart/v',
    version: textVersion('sdk/dart/pubspec.yaml', /^version:\s*([^\s]+)$/m, 'Dart'),
  },
  ruby: {
    prefix: 'sdk/ruby/v',
    version: textVersion(
      'sdk/ruby/lib/oresoftware/next_loggers/version.rb',
      /VERSION\s*=\s*"([^"]+)"/,
      'Ruby',
    ),
  },
  gleam: {
    prefix: 'sdk/gleam/v',
    version: textVersion('sdk/gleam/gleam.toml', /^version\s*=\s*"([^"]+)"/m, 'Gleam'),
  },
  erlang: {
    prefix: 'sdk/erlang/v',
    version: textVersion(
      'sdk/erlang/src/oresoftware_next_loggers_erlang.app.src',
      /\{vsn,\s*"([^"]+)"\}/,
      'Erlang',
    ),
  },
  elixir: {
    prefix: 'sdk/elixir/v',
    version: textVersion('sdk/elixir/mix.exs', /@version\s+"([^"]+)"/, 'Elixir'),
  },
};

const target = process.argv[2];
if (!target || !(target in releases)) {
  throw new Error(`usage: verify-release-tag.mjs <${Object.keys(releases).join('|')}> [tag]`);
}

const release = releases[target];
const version = await release.version();
if (!isStrictSemVer(version)) {
  throw new Error(`${target} version ${version} is not strict Semantic Versioning 2.0.0`);
}

const tag =
  process.argv[3] ??
  process.env.GITHUB_REF_NAME ??
  process.env.GITHUB_REF?.replace(/^refs\/tags\//, '');
if (!tag) throw new Error('release tag is required as argv[3], GITHUB_REF_NAME, or GITHUB_REF');

const expected = `${release.prefix}${version}`;
if (tag !== expected) {
  throw new Error(`${target} release tag mismatch: expected ${expected}, received ${tag}`);
}

console.log(`${target}: verified ${tag}`);
