#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildSuites({ rootDir = defaultRoot, fileExists = existsSync } = {}) {
  const dartCwd = path.join(rootDir, 'sdk', 'dart');
  const canonicalDartTest = path.join(dartCwd, 'test', 'conformance_test.dart');
  const legacyDartWireTest = path.join(dartCwd, 'test', 'conformance.dart');
  const legacyDartContextTest = path.join(dartCwd, 'test', 'context_shutdown.dart');
  const dartSuites = [
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
  ];

  if (fileExists(canonicalDartTest)) {
    dartSuites.push({
      name: 'Dart/Flutter package conformance',
      command: 'dart',
      args: ['test', 'test/conformance_test.dart'],
      cwd: dartCwd,
    });
    if (fileExists(legacyDartContextTest)) {
      dartSuites.push({
        name: 'Dart/Flutter context and shutdown',
        command: 'dart',
        args: ['--enable-asserts', 'run', 'test/context_shutdown.dart'],
        cwd: dartCwd,
      });
    }
  } else {
    if (!fileExists(legacyDartWireTest)) {
      throw new Error(
        'Dart conformance entrypoint is missing: expected test/conformance_test.dart or test/conformance.dart',
      );
    }
    dartSuites.push({
      name: 'Dart/Flutter wire conformance',
      command: 'dart',
      args: ['--enable-asserts', 'run', 'test/conformance.dart'],
      cwd: dartCwd,
    });
    if (fileExists(legacyDartContextTest)) {
      dartSuites.push({
        name: 'Dart/Flutter context and shutdown',
        command: 'dart',
        args: ['--enable-asserts', 'run', 'test/context_shutdown.dart'],
        cwd: dartCwd,
      });
    }
  }

  return [
    {
      name: 'Python',
      command: process.env.PYTHON || 'python3',
      args: ['-m', 'unittest', 'discover', '-s', 'tests', '-v'],
      cwd: path.join(rootDir, 'sdk', 'python'),
      env: { PYTHONPATH: 'src' },
    },
    {
      name: 'Go (race detector)',
      command: 'go',
      args: ['test', '-race', './...'],
      cwd: path.join(rootDir, 'sdk', 'go'),
    },
    {
      name: 'Rust',
      command: 'cargo',
      args: ['test', '--locked'],
      cwd: path.join(rootDir, 'sdk', 'rust'),
    },
    {
      name: 'Rust context format',
      command: 'cargo',
      args: ['fmt', '--', '--check'],
      cwd: path.join(rootDir, 'sdk', 'rust-context'),
    },
    {
      name: 'Rust context',
      command: 'cargo',
      args: ['test', '--features', 'tokio'],
      cwd: path.join(rootDir, 'sdk', 'rust-context'),
    },
    {
      name: 'Rust OpenTelemetry companion',
      command: 'cargo',
      args: ['test'],
      cwd: path.join(rootDir, 'sdk', 'rust-otel'),
    },
    {
      name: 'Gleam',
      command: 'gleam',
      args: ['test'],
      cwd: path.join(rootDir, 'sdk', 'gleam'),
    },
    {
      name: 'Java',
      command: 'bash',
      args: ['test.sh'],
      cwd: path.join(rootDir, 'sdk', 'java'),
    },
    ...dartSuites,
    {
      name: 'Ruby',
      command: process.env.RUBY || 'ruby',
      args: ['test/next_loggers_test.rb'],
      cwd: path.join(rootDir, 'sdk', 'ruby'),
    },
    {
      name: 'Erlang',
      command: 'bash',
      args: ['test.sh'],
      cwd: path.join(rootDir, 'sdk', 'erlang'),
    },
    {
      name: 'Elixir',
      command: 'bash',
      args: ['test.sh'],
      cwd: path.join(rootDir, 'sdk', 'elixir'),
    },
    {
      name: 'WASM',
      command: 'bash',
      args: ['test.sh'],
      cwd: path.join(rootDir, 'sdk', 'wasm'),
    },
  ];
}

export function runSuites(suites) {
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
    return failures.some(value => value.includes('not installed') || value.includes('127')) ? 127 : 1;
  }
  return 0;
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  try {
    process.exitCode = runSuites(buildSuites());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
