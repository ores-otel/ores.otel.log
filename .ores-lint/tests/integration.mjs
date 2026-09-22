#!/usr/bin/env node
/**
 * ores-lint :: require-send end-to-end fixture
 *
 * The unit fixtures in ../require-send.test.mjs call analyzeSource() directly.
 * This one exercises the scanner the way lint.sh does: as a CLI pointed at a
 * repository root, walking real files on disk and printing the capped report.
 * It catches the failures a pure unit test cannot - file discovery, language
 * selection by extension, skipped directories, test-file exclusion and the
 * report format that rust.sh / js.sh share.
 *
 * Plain `node` (selftest.sh runs it without --test) and dependency-free.
 * Exits non-zero on the first broken expectation.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scanner = path.join(here, '..', 'require-send.mjs');

const FIXTURE = {
  'src/handler.rs': [
    'pub fn handle(logger: &Logger) {',
    '  logger.info("undelivered");',
    '  logger.warn("delivered").send();',
    '}',
    '',
  ].join('\n'),
  'lib/telemetry.dart': [
    'void emit(Telemetry telemetry) {',
    "  telemetry.error('undelivered');",
    "  telemetry.error('delivered').send();",
    '}',
    '',
  ].join('\n'),
  'src/report.gleam': [
    'fn emit() {',
    '  logging.info("undelivered")',
    '  Nil',
    '}',
    '',
  ].join('\n'),
  // Excluded by SKIP_DIR: a finding here would mean the walker ignores prunes.
  'target/generated.rs': 'pub fn g(logger: &Logger) { logger.info("ignored"); }\n',
  'node_modules/dep/dep.rs': 'pub fn d(logger: &Logger) { logger.info("ignored"); }\n',
  // Excluded as a test file unless ORES_LINT_REQUIRE_SEND_INCLUDE_TESTS=1.
  'src/handler_test.rs': 'pub fn t(logger: &Logger) { logger.info("ignored"); }\n',
  // Not a scanned language.
  'README.md': 'logger.info("not source");\n',
};

function materialize() {
  const root = mkdtempSync(path.join(tmpdir(), 'ores-lint-require-send-'));
  for (const [rel, contents] of Object.entries(FIXTURE)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  return root;
}

function scan(root, env = {}) {
  return execFileSync(process.execPath, [scanner, root], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

const root = materialize();
let checked = 0;
const check = (label, fn) => {
  fn();
  checked += 1;
  console.log(`  ok   - ${label}`);
};

try {
  const report = scan(root);

  check('reports one finding per undelivered chain, one per language', () => {
    assert.match(report, /3 finding\(s\) across 1 rule\(s\) in 3 file\(s\)/);
  });

  check('names the offending file, line and column', () => {
    assert.match(report, /src\/handler\.rs:2:3/);
    assert.match(report, /lib\/telemetry\.dart:2:3/);
    assert.match(report, /src\/report\.gleam:2:11/);
  });

  check('delivered chains are not reported', () => {
    assert.equal((report.match(/handler\.rs:3:/g) || []).length, 0);
    assert.equal((report.match(/telemetry\.dart:3:/g) || []).length, 0);
  });

  check('pruned directories and non-source files are never scanned', () => {
    assert.doesNotMatch(report, /target\//);
    assert.doesNotMatch(report, /node_modules/);
    assert.doesNotMatch(report, /README\.md/);
  });

  check('test sources are excluded by default', () => {
    assert.doesNotMatch(report, /handler_test\.rs/);
  });

  check('ORES_LINT_REQUIRE_SEND_INCLUDE_TESTS=1 brings test sources back', () => {
    const withTests = scan(root, { ORES_LINT_REQUIRE_SEND_INCLUDE_TESTS: '1' });
    assert.match(withTests, /src\/handler_test\.rs:1:/);
  });

  check('ORES_LINT_MAX_EXAMPLES caps the example list without losing the count', () => {
    const capped = scan(root, { ORES_LINT_MAX_EXAMPLES: '1' });
    assert.match(capped, /3 finding\(s\)/);
    assert.match(capped, /showing 1:/);
    assert.match(capped, /\.\.\. and 2 more/);
  });

  check('ORES_LINT_SKIP_REQUIRE_SEND=1 is an explicit, quiet skip', () => {
    const skipped = scan(root, { ORES_LINT_SKIP_REQUIRE_SEND: '1' });
    assert.match(skipped, /skipped \(ORES_LINT_SKIP_REQUIRE_SEND=1\)/);
    assert.doesNotMatch(skipped, /finding\(s\)/);
  });

  check('a repository with nothing to deliver reports clean', () => {
    const cleanRoot = mkdtempSync(path.join(tmpdir(), 'ores-lint-require-send-clean-'));
    try {
      mkdirSync(path.join(cleanRoot, 'src'), { recursive: true });
      writeFileSync(
        path.join(cleanRoot, 'src/ok.rs'),
        'pub fn ok(logger: &Logger) { logger.info("delivered").send(); }\n',
      );
      assert.match(scan(cleanRoot), /clean \(1 file scanned\)/);
    } finally {
      rmSync(cleanRoot, { recursive: true, force: true });
    }
  });

  console.log(`require-send integration fixture: ${checked} check(s) passed`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
