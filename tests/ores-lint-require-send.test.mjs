import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { analyzeSource } from '../.ores-lint/require-send.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const lines = (findings) => findings.map((finding) => finding.line);

test('a terminal wrapper send consumes a directly transferred Rust event', () => {
  const source = [
    'use oresoftware_next_loggers::{Logger, Options};',
    'fn run(logger: &Logger, record_context: &LogContext) {',
    '  let event = logger.info(vec!["sent"]);',
    '  let _ = next_loggers::apply_log_context(event, &record_context).send();',
    '}',
  ].join('\n');

  assert.deepEqual(analyzeSource(source, 'rust'), []);
});

test('a terminal wrapper send consumes a directly transferred Dart event', () => {
  const source = [
    'void run(Logger logger, LogContext context) {',
    "  final event = logger.info('sent');",
    '  decorate(event, context).send();',
    '}',
  ].join('\n');

  assert.deepEqual(analyzeSource(source, 'dart'), []);
});

test('a borrowed Rust event is not treated as transferred', () => {
  const source = [
    'fn run(logger: &Logger, record_context: &LogContext) {',
    '  let event = logger.info(vec!["still pending"]);',
    '  let _ = inspect(&event, record_context).send();',
    '}',
  ].join('\n');

  assert.deepEqual(lines(analyzeSource(source, 'rust')), [2]);
});

test('a nested or cloned event argument is not treated as transferred', () => {
  const nested = [
    'fn run(logger: &Logger) {',
    '  let event = logger.info(vec!["still pending"]);',
    '  decorate(identity(event)).send();',
    '}',
  ].join('\n');
  const cloned = [
    'fn run(logger: &Logger) {',
    '  let event = logger.info(vec!["still pending"]);',
    '  decorate(event.clone()).send();',
    '}',
  ].join('\n');

  assert.deepEqual(lines(analyzeSource(nested, 'rust')), [2]);
  assert.deepEqual(lines(analyzeSource(cloned, 'rust')), [2]);
});

test('only the first direct wrapper argument is considered transferred', () => {
  const source = [
    'fn run(logger: &Logger, context: &LogContext) {',
    '  let event = logger.info(vec!["still pending"]);',
    '  decorate(context, event).send();',
    '}',
  ].join('\n');

  assert.deepEqual(lines(analyzeSource(source, 'rust')), [2]);
});

test('a wrapper without a terminal send leaves the assigned event pending', () => {
  const source = [
    'fn run(logger: &Logger, context: &LogContext) {',
    '  let event = logger.info(vec!["still pending"]);',
    '  let _ = next_loggers::apply_log_context(event, context);',
    '}',
  ].join('\n');

  assert.deepEqual(lines(analyzeSource(source, 'rust')), [2]);
});

test('the rust-web server has no require-send false positive', async () => {
  const source = await readFile(path.join(root, 'sdk/rust-web/src/server.rs'), 'utf8');
  assert.deepEqual(analyzeSource(source, 'rust'), []);
});
