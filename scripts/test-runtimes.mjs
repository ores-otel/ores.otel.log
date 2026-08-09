#!/usr/bin/env node
/**
 * Local cross-runtime conformance driver.
 *
 * CI runs the conformance suite in real Bun / Deno / workerd / Chromium jobs
 * (see .github/workflows/ci.yml). This script gives developers the same
 * signal locally: it runs tests/conformance/run-node.mjs under every runtime
 * binary found on PATH and *skips gracefully* — without failing — when a
 * runtime is not installed, so `npm run test:runtimes` is safe on any machine
 * and in any CI container.
 *
 * Exit code is non-zero only when an installed runtime fails the suite, or
 * when NEXT_LOGGERS_REQUIRE_RUNTIMES=1 and a listed runtime is missing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const driver = path.join('tests', 'conformance', 'run-node.mjs');

if (!existsSync(path.join(root, 'dist', 'base-logger.js'))) {
  console.error('dist/ is missing — run `npm run build` first.');
  process.exit(1);
}

const runtimes = [
  {
    name: 'node',
    command: process.execPath,
    args: [driver],
  },
  {
    name: 'bun',
    command: 'bun',
    args: ['run', driver],
  },
  {
    name: 'deno',
    command: 'deno',
    // Explicit allow-list: the suite needs module reads and timers only, plus
    // env/net for the transport probes. Mirrors the flags used in CI.
    args: ['run', '--allow-read', '--allow-env', '--allow-net', driver],
  },
];

const requireAll = process.env.NEXT_LOGGERS_REQUIRE_RUNTIMES === '1';
const summary = [];
let failed = false;

for (const runtime of runtimes) {
  process.stdout.write(`\n=== conformance under ${runtime.name} ===\n`);
  const result = spawnSync(runtime.command, runtime.args, {
    cwd: root,
    stdio: 'inherit',
  });

  if (result.error?.code === 'ENOENT') {
    if (requireAll) {
      summary.push(`${runtime.name}: MISSING (required)`);
      failed = true;
    } else {
      summary.push(`${runtime.name}: skipped (not installed)`);
      process.stdout.write(`${runtime.name} is not installed — skipping.\n`);
    }
    continue;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    summary.push(`${runtime.name}: FAILED (exit ${result.status})`);
    failed = true;
  } else {
    summary.push(`${runtime.name}: passed`);
  }
}

process.stdout.write(`\n--- runtime summary ---\n${summary.join('\n')}\n`);
process.exit(failed ? 1 : 0);
