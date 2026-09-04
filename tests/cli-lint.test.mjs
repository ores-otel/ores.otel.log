import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  blankNonCode,
  checkSource,
  languageForPath,
  lintSource,
} from '../dist/cli/commands/lint.js';
import { main } from '../dist/cli/main.js';

const lines = (findings) => findings.map((finding) => finding.line);

const CLI_ENV_KEYS = [
  'NEXT_LOGGER_CLI_COMMAND',
  'NEXT_LOGGER_CLI_JSON',
  'NEXT_LOGGER_CLI_COLOR',
  'NEXT_LOGGER_CLI_QUIET',
  'NEXT_LOGGER_CLI_LINT_ALL',
  'NEXT_LOGGER_CLI_LINT_LOGGER_NAMES',
  'NEXT_LOGGER_NAME',
];

function captureEnvironment(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

test('JavaScript and TypeScript report only dropped bare event chains', () => {
  const source = [
    "import '@oresoftware/next-loggers';",
    "logger.info('delivered').send();",
    "logger.warn('dropped');",
    "const event = logger.error('assigned');",
    'event.send();',
    "return logger.fatal('returned');",
  ].join('\n');

  const findings = checkSource(source, 'typescript', { file: 'sample.ts' });
  assert.deepEqual(lines(findings), [3]);
  assert.deepEqual(
    findings.map(({ code, file, language }) => ({ code, file, language })),
    [{ code: 'NL100', file: 'sample.ts', language: 'typescript' }],
  );
});

test('multiline method chains and optional chaining retain statement boundaries', () => {
  const source = [
    "import '@oresoftware/next-loggers';",
    'logger',
    "  ?.error('sent')",
    "  .addTags('a')",
    '  .send();',
    'logger',
    "  .warn('dropped')",
    "  .addTags('a');",
  ].join('\n');

  assert.deepEqual(lines(checkSource(source, 'javascript')), [6]);
});

test('factory aliases, named logger aliases, and default logger imports are discovered', () => {
  const aliased = [
    "import { createLogger as makeLogger, logger as shared } from '@oresoftware/next-loggers/node';",
    "const audit = makeLogger({ appName: 'audit' });",
    "audit.error('factory alias dropped');",
    "shared.warn('named alias dropped');",
  ].join('\n');
  assert.deepEqual(lines(lintSource(aliased, 'aliases.mts')), [3, 4]);

  const defaultImport = [
    "import appLog from '@oresoftware/next-loggers';",
    "appLog.fatal('default import dropped');",
  ].join('\n');
  assert.deepEqual(lines(lintSource(defaultImport, 'default.ts')), [2]);
});

test('Gleam pipelines recognize terminal send and report an unfinished pipeline', () => {
  const source = [
    'import oresoftware_next_loggers as logging',
    '',
    'pub fn handle(logger: logging.Logger) -> Nil {',
    '  logging.info(logger, "sent", [])',
    '  |> logging.add_tags(["a"])',
    '  |> logging.send',
    '',
    '  logging.warn(logger, "dropped", [])',
    '  |> logging.add_tags(["a"])',
    '  Nil',
    '}',
  ].join('\n');

  assert.deepEqual(lines(checkSource(source, 'gleam')), [8]);
});

test('Go, Rust, and Python use their native terminal-send spellings', () => {
  const go = [
    'package main',
    'import (',
    '  "fmt"',
    '  nextloggers "github.com/ores-otel/ores.otel.log/sdk/go"',
    ')',
    'func run() {',
    '  logger := nextloggers.NewLogger(nextloggers.Options{})',
    '  logger.Info("sent").Send()',
    '  logger.Warn("dropped").AddFields(nil)',
    '  _ = fmt.Sprintf("ok")',
    '}',
  ].join('\n');
  assert.deepEqual(lines(checkSource(go, 'go')), [9]);

  const rust = [
    'use oresoftware_next_loggers::{Logger, Options};',
    'fn run(logger: &Logger) {',
    '  let _sample = r#"logger.error(\\"not code\\")"#;',
    '  logger.info(vec![]).send().unwrap();',
    '  logger.warn(vec![]).add_tag("dropped");',
    '}',
  ].join('\n');
  assert.deepEqual(lines(checkSource(rust, 'rust')), [5]);

  const python = [
    'from next_loggers import Logger',
    'logger = Logger(app_name="checkout")',
    'sample = """logger.error("not code")"""',
    'logger.info("sent").send()',
    'logger.warn("dropped").add_tag("a")',
  ].join('\n');
  assert.deepEqual(lines(checkSource(python, 'python')), [5]);
});

test('comments and string bodies are blanked without changing line or column offsets', () => {
  const source = [
    "import '@oresoftware/next-loggers';",
    "const url = 'https://example.test/logger.info(\\'not code\\')';",
    "// logger.warn('comment');",
    "/* logger.error('block comment'); */",
    "logger.info('real drop');",
  ].join('\n');

  const blanked = blankNonCode(source, 'typescript');
  assert.equal(blanked.length, source.length);
  assert.equal(blanked.split('\n').length, source.split('\n').length);
  assert.deepEqual(lines(checkSource(source, 'typescript')), [5]);
});

test('import gating avoids other logger libraries unless explicitly overridden', () => {
  const source = [
    'const logger = pino();',
    "logger.info('another library');",
    "ctx.audit.warn('explicit property path');",
  ].join('\n');

  assert.deepEqual(checkSource(source, 'javascript'), []);
  assert.deepEqual(
    lines(checkSource(source, 'javascript', { loggerNames: ['ctx.audit'] })),
    [2, 3],
  );
  assert.deepEqual(lines(lintSource("logger.info('all mode');", 'all.js', { all: true })), [1]);
});

test('supported extensions map deterministically and unsupported files are ignored', () => {
  assert.equal(languageForPath('service.ts'), 'typescript');
  assert.equal(languageForPath('service.mjs'), 'javascript');
  assert.equal(languageForPath('service.go'), 'go');
  assert.equal(languageForPath('service.rs'), 'rust');
  assert.equal(languageForPath('service.py'), 'python');
  assert.equal(languageForPath('service.gleam'), 'gleam');
  assert.equal(languageForPath('README.md'), undefined);
});

test('the lint command walks deterministically, skips ignored trees, and emits one JSON receipt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'next-loggers-lint-'));
  const snapshot = captureEnvironment(CLI_ENV_KEYS);
  const originalStdout = process.stdout.write.bind(process.stdout);
  const originalStderr = process.stderr.write.bind(process.stderr);
  const output = [];
  const errors = [];

  try {
    for (const key of CLI_ENV_KEYS) {
      delete process.env[key];
    }

    await mkdir(path.join(directory, 'node_modules'), { recursive: true });
    await mkdir(path.join(directory, '.hidden'), { recursive: true });
    await writeFile(
      path.join(directory, 'node_modules', 'ignored.js'),
      "import '@oresoftware/next-loggers';\nlogger.info('ignored');\n",
    );
    await writeFile(
      path.join(directory, '.hidden', 'ignored.ts'),
      "import '@oresoftware/next-loggers';\nlogger.info('ignored');\n",
    );
    await writeFile(
      path.join(directory, 'clean.ts'),
      "import '@oresoftware/next-loggers';\nlogger.info('sent').send();\n",
    );
    await writeFile(
      path.join(directory, 'broken.ts'),
      "import '@oresoftware/next-loggers';\nlogger.info('missing');\n",
    );
    await writeFile(
      path.join(directory, 'custom.ts'),
      "const audit = externalLogger();\naudit.warn('missing');\n",
    );

    process.stdout.write = (chunk) => {
      output.push(String(chunk));
      return true;
    };
    process.stderr.write = (chunk) => {
      errors.push(String(chunk));
      return true;
    };

    const exitCode = await main([
      'lint',
      '--json',
      '--logger-name',
      'audit',
      directory,
    ]);
    assert.equal(exitCode, 1);
    assert.deepEqual(errors, []);

    const receipt = JSON.parse(output.join('').trim());
    assert.equal(receipt.schema, 'next-loggers/lint/v1');
    assert.equal(receipt.passed, false);
    assert.equal(receipt.filesChecked, 3);
    assert.equal(receipt.findings.length, 2);
    assert.deepEqual(
      receipt.findings.map((finding) => path.basename(finding.file)),
      ['broken.ts', 'custom.ts'],
    );
    assert.equal(receipt.findings.every((finding) => finding.code === 'NL100'), true);
    assert.equal(output.length, 1, 'JSON mode must emit one receipt, not mixed human output');
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    restoreEnvironment(snapshot);
    await rm(directory, { recursive: true, force: true });
  }
});
