#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dartCwd = path.join(root, 'sdk', 'dart');

const suites = [
  {
    name: 'Python',
    command: process.env.PYTHON || 'python3',
    args: ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
    cwd: path.join(root, 'sdk', 'python'),
    env: { PYTHONPATH: 'src' },
  },
  {
    name: 'Go (race detector)',
    command: 'go',
    args: ['test', '-race', './...'],
    cwd: path.join(root, 'sdk', 'go'),
  },
  {
    name: 'Rust',
    command: 'cargo',
    args: ['test', '--locked'],
    cwd: path.join(root, 'sdk', 'rust'),
  },
  {
    name: 'Rust context format',
    command: 'cargo',
    args: ['fmt', '--', '--check'],
    cwd: path.join(root, 'sdk', 'rust-context'),
  },
  {
    name: 'Rust thread/Tokio context',
    command: 'cargo',
    args: ['test', '--features', 'tokio'],
    cwd: path.join(root, 'sdk', 'rust-context'),
  },
  {
    name: 'Gleam',
    command: 'gleam',
    args: ['test'],
    cwd: path.join(root, 'sdk', 'gleam'),
  },
  {
    name: 'Java',
    command: 'bash',
    args: ['test.sh'],
    cwd: path.join(root, 'sdk', 'java'),
  },
  {
    name: 'Dart dependencies',
    command: 'dart',
    args: ['pub', 'get'],
    cwd: dartCwd,
  },
  {
    name: 'Dart format',
    command: 'dart',
    args: ['format', '--output=none', '--set-exit-if-changed', 'lib', 'test'],
    cwd: dartCwd,
  },
  {
    name: 'Dart/Flutter wire conformance',
    command: 'dart',
    args: ['--enable-asserts', 'run', 'test/conformance.dart'],
    cwd: dartCwd,
  },
  {
    name: 'Dart/Flutter context and shutdown',
    command: 'dart',
    args: ['--enable-asserts', 'run', 'test/context_shutdown.dart'],
    cwd: dartCwd,
  },
  {
    name: 'Ruby',
    command: process.env.RUBY || 'ruby',
    args: ['test/next_loggers_test.rb'],
    cwd: path.join(root, 'sdk', 'ruby'),
  },
  {
    name: 'Erlang',
    command: 'bash',
    args: ['test.sh'],
    cwd: path.join(root, 'sdk', 'erlang'),
  },
  {
    name: 'Elixir',
    command: 'bash',
    args: ['test.sh'],
    cwd: path.join(root, 'sdk', 'elixir'),
  },
  {
    name: 'WASM',
    command: 'bash',
    args: ['test.sh'],
    cwd: path.join(root, 'sdk', 'wasm'),
  },
];

const failures = [];

for (const suite of suites) {
  process.stdout.write(`\n=== ${suite.name} SDK ===\n`);
  const result = spawnSync(suite.command, suite.args, {
    cwd: suite.cwd,
    env: { ...process.env, ...suite.env },
    stdio: 'inherit',
  });
  if (result.error?.code === 'ENOENT') {
    process.stderr.write(`${suite.name} toolchain is not installed.\n`);
    failures.push(`${suite.name}: toolchain is not installed`);
    continue;
  }
  if (result.error) {
    process.stderr.write(`${suite.name} could not start: ${result.error.message}\n`);
    failures.push(`${suite.name}: could not start`);
    continue;
  }
  if (result.status !== 0) {
    failures.push(`${suite.name}: exited with ${result.status ?? 1}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`\nPolyglot failures:\n${failures.map(value => `- ${value}`).join('\n')}\n`);
  process.exitCode = failures.some(value => value.includes('not installed') || value.includes('127'))
    ? 127
    : 1;
}
