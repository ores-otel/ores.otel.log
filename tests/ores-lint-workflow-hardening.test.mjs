import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const workflowPath = path.join(root, '.github/workflows/ores-lint.yml');
const toolsPath = path.join(root, '.ores-lint/required-tools.json');

async function loadInputs() {
  const [workflow, toolsText] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(toolsPath, 'utf8'),
  ]);
  return { workflow, tools: JSON.parse(toolsText) };
}

test('ores-lint workflow uses immutable action revisions and a fixed runner', async () => {
  const { workflow } = await loadInputs();
  const actionUses = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map(
    (match) => match[1],
  );

  assert.deepEqual(actionUses, [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'dart-lang/setup-dart@6afc89df92d6eb3834022f73cd65adc8cdfcb92d',
  ]);
  assert.equal(actionUses.every((entry) => /@[0-9a-f]{40}$/.test(entry)), true);
  assert.doesNotMatch(workflow, /uses:\s*[^\n]+@v\d+/);
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /ubuntu-latest/);
});

test('ores-lint workflow is read-only, bounded, and credential-minimal', async () => {
  const { workflow } = await loadInputs();

  assert.match(workflow, /permissions:\n\s+contents:\s+read/);
  assert.match(workflow, /timeout-minutes:\s+15/);
  assert.match(workflow, /persist-credentials:\s+false/);
  assert.match(workflow, /concurrency:[\s\S]*cancel-in-progress:\s+true/);
  assert.match(workflow, /set -euo pipefail/g);
});

test('lint host versions have one machine-readable exact authority', async () => {
  const { workflow, tools } = await loadInputs();
  const exactSemver = /^\d+\.\d+\.\d+$/;

  assert.match(tools.eslint.ciVersion, exactSemver);
  assert.match(tools['typescript-eslint'].ciVersion, exactSemver);
  assert.equal(tools.eslint.install, `npm i -g eslint@${tools.eslint.ciVersion}`);
  assert.equal(
    tools['typescript-eslint'].install,
    `npm i -g typescript-eslint@${tools['typescript-eslint'].ciVersion}`,
  );

  assert.match(workflow, /required-tools\.json'\)\.eslint\.ciVersion/);
  assert.match(workflow, /required-tools\.json'\)\['typescript-eslint'\]\.ciVersion/);
  assert.match(workflow, /"eslint@\$\{ESLINT_VERSION\}"/);
  assert.match(workflow, /"typescript-eslint@\$\{TYPESCRIPT_ESLINT_VERSION\}"/);
  assert.match(workflow, /npm i -g --ignore-scripts --no-audit --no-fund/);
  assert.doesNotMatch(workflow, /npm i -g eslint typescript-eslint/);
  assert.doesNotMatch(workflow, /@latest/);
});

test('tool installation is verified and Rust setup fails closed', async () => {
  const { workflow } = await loadInputs();

  assert.match(workflow, /test "\$\(eslint --version\)" = "v\$\{ESLINT_VERSION\}"/);
  assert.match(workflow, /typescript-eslint\/package\.json/);
  assert.match(workflow, /test "\$actual_typescript_eslint" = "\$TYPESCRIPT_ESLINT_VERSION"/);
  assert.match(workflow, /run:\s+rustup component add clippy/);
  assert.doesNotMatch(workflow, /rustup component add clippy\s*\|\|\s*true/);
});
