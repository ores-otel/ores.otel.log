import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const requiredContractFiles = [
  'contracts/log-record.schema.json',
  'contracts/sdk-manifests.json',
  'contracts/schemas/sdk-manifest.schema.json',
  'contracts/migration/test-repository-matrix.json',
  'contracts/fixtures/manifest.json',
];

test('package manifests expose the complete contracts tree', async () => {
  for (const relative of ['package.json', 'sdk/nodejs/package.json']) {
    const manifest = await readJson(join(repositoryRoot, relative));
    assert.ok(manifest.files.includes('contracts'), `${relative} must publish contracts`);
    assert.equal(
      manifest.exports['./contracts/*'],
      './contracts/*',
      `${relative} must expose contract subpaths`,
    );
  }
});

test('the staged Node tarball contains canonical contract artifacts', async () => {
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '--dry-run', '--json', '--prefix', 'sdk/nodejs'],
    { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 },
  );
  const [pack] = JSON.parse(stdout);
  const packedPaths = new Set(pack.files.map(({ path }) => path));

  for (const required of requiredContractFiles) {
    assert.ok(packedPaths.has(required), `packed artifact is missing ${required}`);
  }
});
