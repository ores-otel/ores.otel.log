import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestDir = path.join(repoRoot, 'contracts', 'sdk-manifests');
const manifests = readdirSync(manifestDir)
  .filter((entry) => entry.endsWith('.json'))
  .map((entry) => [entry, JSON.parse(readFileSync(path.join(manifestDir, entry), 'utf8'))]);

test('every SDK declares its shutdown contract', () => {
  assert.equal(manifests.length, 11, 'expected one manifest per SDK');
  for (const [file, manifest] of manifests) {
    assert.ok(manifest.shutdown, `${file} is missing a shutdown block`);
    for (const key of [
      'processHooks',
      'autoRegistered',
      'gracePeriodMillis',
      'flushDeadlineMillis',
      'idempotentFlush',
      'doubleSignalForces',
      'hooksRemovable',
      'symbols',
    ]) {
      assert.ok(key in manifest.shutdown, `${file} shutdown is missing ${key}`);
    }
  }
});

/**
 * The manifest is only worth anything if it describes the code. Nothing checked
 * the declared symbols against the sources before this, so a manifest could
 * claim an API the SDK had never implemented -- which is exactly how several of
 * them came to declare flush, flush_on_exit and close while implementing none.
 */
test('every declared shutdown symbol appears in that SDK sources', () => {
  for (const [file, manifest] of manifests) {
    const sources = (manifest.conformance?.sourceFiles ?? [])
      .map((relative) => {
        try {
          return readFileSync(path.join(repoRoot, relative), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    assert.notEqual(sources, '', `${file} declares no readable sourceFiles`);
    for (const symbol of manifest.shutdown.symbols) {
      // Strip the language's namespacing so one check works across all of them:
      // Logger.close, Logger#close, Logger::close and close/1 all name `close`.
      const bare = symbol.split(/[.#]|::/).pop().replace(/\/\d+$/u, '');
      assert.ok(
        sources.includes(bare),
        `${file} declares shutdown symbol "${symbol}" but "${bare}" is absent from its sourceFiles`,
      );
    }
  }
});

/**
 * An SDK that cannot drain on exit is not "done pending polish" -- records are
 * being lost. If the manifest admits the gap, promotion has to admit it too.
 */
test('an SDK with no process hooks is blocked from promotion', () => {
  for (const [file, manifest] of manifests) {
    if (manifest.shutdown.processHooks.length > 0) {
      continue;
    }
    const blockers = manifest.promotion?.blockers ?? [];
    assert.ok(
      blockers.length > 0,
      `${file} declares no shutdown hooks yet lists no promotion blockers`,
    );
  }
});

test('an SDK claiming automatic registration also claims removable hooks', () => {
  for (const [file, manifest] of manifests) {
    if (!manifest.shutdown.autoRegistered) {
      continue;
    }
    // Hooks attached at import must be detachable, or every test run and every
    // embedded use leaks listeners for the life of the process.
    assert.equal(
      manifest.shutdown.hooksRemovable,
      true,
      `${file} auto-registers hooks that cannot be removed`,
    );
  }
});
