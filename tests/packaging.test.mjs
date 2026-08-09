/**
 * Packaging guard — the package must stay ESM-only and every declared export
 * target must exist in the built dist/.
 *
 * The spec is explicit: "esm and mjs compatible, we do not need to support
 * commonjs". These tests fail the suite if anyone reintroduces a `require`
 * condition, a CJS `main` field, or an exports entry that points at a file
 * the build no longer produces.
 */

import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Recursively collect every [conditionPath, target] leaf of the exports map. */
function collectLeaves(node, trail = []) {
  if (typeof node === 'string') {
    return [[trail, node]];
  }
  if (node === null || typeof node !== 'object') {
    return [];
  }
  return Object.entries(node).flatMap(([key, value]) => collectLeaves(value, [...trail, key]));
}

const leaves = collectLeaves(pkg.exports);

test('the package is ESM-only', () => {
  assert.equal(pkg.type, 'module', 'package.json "type" must be "module"');
  assert.equal(pkg.main, undefined, 'a "main" field would invite CJS resolution');
  assert.equal(pkg.module, undefined, '"module" is a bundler-only legacy field');
  for (const [trail] of leaves) {
    assert.ok(
      !trail.includes('require'),
      `exports must not declare a "require" condition (found at ${trail.join(' > ')})`,
    );
  }
});

test('no export target is a CommonJS file', () => {
  for (const [trail, target] of leaves) {
    assert.ok(
      !target.endsWith('.cjs') && !target.endsWith('.cts'),
      `${trail.join(' > ')} -> ${target} looks like CommonJS`,
    );
  }
});

test('every exports entry resolves to a file the build produced', () => {
  assert.ok(leaves.length > 0, 'exports map should not be empty');
  for (const [trail, target] of leaves) {
    assert.doesNotThrow(
      () => accessSync(path.join(root, target), constants.R_OK),
      `${trail.join(' > ')} -> ${target} does not exist on disk`,
    );
  }
});

test('every runtime subpath declares both types and a default target', () => {
  for (const [subpath, node] of Object.entries(pkg.exports)) {
    if (typeof node === 'string') continue; // e.g. "./package.json"
    const conditions = collectLeaves(node).map(([trail]) => trail);
    assert.ok(
      conditions.some((trail) => trail.includes('types')),
      `${subpath} is missing a "types" condition`,
    );
    assert.ok(
      conditions.some((trail) => trail.includes('default')),
      `${subpath} is missing a "default" condition`,
    );
  }
});

test('every runtime entry point named in the spec is exported', () => {
  const wanted = ['./base', './browser', './edge', './cloudflare', './node', './bun', './deno'];
  for (const subpath of wanted) {
    assert.ok(pkg.exports[subpath], `spec requires an exports entry for ${subpath}`);
  }
});

test('the bin entry exists and dist ships in the tarball', () => {
  for (const target of Object.values(pkg.bin ?? {})) {
    accessSync(path.join(root, target), constants.R_OK);
  }
  assert.ok(pkg.files.includes('dist'), 'the "files" allowlist must ship dist/');
});
