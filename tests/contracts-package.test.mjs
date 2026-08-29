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
  'contracts/schemas/internal-diagnostic.schema.json',
  'contracts/schemas/internal-diagnostic-batch.schema.json',
  'contracts/schemas/internal-diagnostic-upload-grant.schema.json',
  'contracts/migration/test-repository-matrix.json',
  'contracts/fixtures/manifest.json',
  'formal/InternalDiagnostics.tla',
  'formal/InternalDiagnostics.cfg',
  'docs/internal-diagnostics.md',
  'dist/internal-diagnostics.js',
  'dist/internal-diagnostics.d.ts',
  'dist/internal-diagnostics-backend.js',
  'dist/internal-diagnostics-backend.d.ts',
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
    assert.deepEqual(manifest.exports['./internal-diagnostics'], {
      types: './dist/internal-diagnostics.d.ts',
      default: './dist/internal-diagnostics.js',
    });
    assert.deepEqual(manifest.exports['./internal-diagnostics/backend'], {
      types: './dist/internal-diagnostics-backend.d.ts',
      default: './dist/internal-diagnostics-backend.js',
    });
  }
});

test('browser-safe internal diagnostics cannot pull in backend or cloud runtimes', async () => {
  const browserSource = await readFile(
    join(repositoryRoot, 'dist/internal-diagnostics.js'),
    'utf8',
  );
  for (const forbidden of [
    'process.',
    'node:',
    'internal-diagnostics-backend',
    '@aws-sdk',
    '@google-cloud',
    '@azure/',
  ]) {
    assert.doesNotMatch(browserSource, new RegExp(forbidden.replace('.', '\\.')));
  }

  const backendSource = await readFile(
    join(repositoryRoot, 'dist/internal-diagnostics-backend.js'),
    'utf8',
  );
  assert.match(backendSource, /process\.stderr/);
  assert.doesNotMatch(backendSource, /@aws-sdk|@google-cloud|@azure\//);
});

test('the built Node tarball contains canonical contract artifacts', async () => {
  const { stdout } = await execFileAsync(
    'npm',
    ['pack', '.', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: repositoryRoot, maxBuffer: 20 * 1024 * 1024 },
  );
  const [pack] = JSON.parse(stdout);
  const packedPaths = new Set(pack.files.map(({ path }) => path));

  for (const required of requiredContractFiles) {
    assert.ok(packedPaths.has(required), `packed artifact is missing ${required}`);
  }
});
