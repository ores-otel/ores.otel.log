import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runLint } from '../dist/cli/commands/lint.js';

test('lint returns exit 2 and a diagnostic when an input path cannot be read', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'next-loggers-lint-error-'));
  const errors = [];
  const output = [];

  try {
    const result = await runLint({
      positionals: [path.join(directory, 'does-not-exist')],
      json: false,
      list(key) {
        assert.equal(key, 'logger_name');
        return [];
      },
      bool(key) {
        assert.equal(key, 'all');
        return false;
      },
      print(line) {
        output.push(line);
      },
      printErr(line) {
        errors.push(line);
      },
    });

    assert.equal(result.exitCode, 2);
    assert.deepEqual(output, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^lint: /);
    assert.match(errors[0], /does-not-exist/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
