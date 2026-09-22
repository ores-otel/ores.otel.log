#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const upstreamRoot = resolve(root, '.upstream');
const fail = (message) => { console.error(`[upstream-authority] ${message}`); process.exitCode = 1; };
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function within(base, target) {
  const r = relative(base, target);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}

function repoRelative(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const absolute = resolve(root, value);
  if (!within(root, absolute)) throw new Error(`${label} escapes repository root`);
  return absolute;
}

async function realFile(base, value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value)) {
    throw new Error(`${label} must be relative`);
  }
  const absolute = resolve(base, value);
  if (!within(base, absolute)) throw new Error(`${label} escapes authority checkout`);
  const r = relative(base, absolute);
  let cursor = base;
  for (const part of r.split(sep)) {
    if (!part) continue;
    cursor = resolve(cursor, part);
    const st = await lstat(cursor);
    if (st.isSymbolicLink()) throw new Error(`${label} traverses a symlink: ${value}`);
  }
  const st = await lstat(absolute);
  if (!st.isFile()) throw new Error(`${label} must be a real file: ${value}`);
  return absolute;
}

function gitBlobSha(bytes) {
  const h = createHash('sha1');
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest('hex');
}

function exactGitHead(checkout) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim();
}

function runJsonNode(checkout, script) {
  const stdout = execFileSync(process.execPath, [script], {
    cwd: checkout,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: undefined },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  return JSON.parse(stdout);
}

async function behaviorCaseIds(checkout) {
  const dir = resolve(checkout, 'conformance/cases');
  const ids = new Set();
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`upstream conformance/cases may contain only real files: ${entry.name}`);
    if (!entry.name.endsWith('.json')) throw new Error(`unexpected upstream conformance case file: ${entry.name}`);
    const value = JSON.parse(await readFile(resolve(dir, entry.name), 'utf8'));
    if (value?.schema === 'ores.conformance.case/v1' && value?.kind === 'behavior') {
      if (typeof value.id !== 'string' || !value.id || ids.has(value.id)) throw new Error(`invalid or duplicate upstream behavior case id: ${value?.id}`);
      ids.add(value.id);
    }
  }
  return ids;
}

try {
  const registryPath = repoRelative('governance/upstream-authorities.v1.json', 'upstream authority registry');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  if (registry.schema !== 'ores.governance.upstream-authorities/v1') throw new Error('invalid upstream authority registry schema');
  if (registry.repository !== 'ores-otel/ores.otel.log') throw new Error('upstream authority registry repository mismatch');
  if (!Array.isArray(registry.authorities) || registry.authorities.length === 0) throw new Error('upstream authorities must be non-empty');

  const seenIds = new Set();
  const seenRepos = new Set();
  const receipts = [];
  for (const authority of registry.authorities) {
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) throw new Error('authority entry must be an object');
    if (typeof authority.id !== 'string' || !authority.id || seenIds.has(authority.id)) throw new Error(`invalid or duplicate authority id: ${authority.id}`);
    seenIds.add(authority.id);
    if (typeof authority.repository !== 'string' || !repoPattern.test(authority.repository) || seenRepos.has(authority.repository)) throw new Error(`invalid or duplicate authority repository: ${authority.repository}`);
    seenRepos.add(authority.repository);
    if (!hex40.test(authority.revision)) throw new Error(`authority revision must be an immutable 40-hex commit: ${authority.id}`);
    for (const key of ['typespec_blob_sha','json_schema_blob_sha']) if (!hex40.test(authority[key])) throw new Error(`${key} must be a 40-hex git blob id: ${authority.id}`);
    for (const key of ['contracts_sha256','corpus_sha256','conformance_spec_sha256']) if (!hex64.test(authority[key])) throw new Error(`${key} must be a sha256 digest: ${authority.id}`);
    if (!Array.isArray(authority.conformance_case_ids) || authority.conformance_case_ids.length === 0) throw new Error(`authority must declare behavior case ids: ${authority.id}`);

    const checkoutName = authority.repository.replace('/', '__');
    const checkout = resolve(upstreamRoot, checkoutName);
    if (!within(upstreamRoot, checkout)) throw new Error(`invalid checkout path for ${authority.repository}`);
    const st = await lstat(checkout);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`missing real upstream checkout: ${checkoutName}`);

    const head = exactGitHead(checkout);
    if (head !== authority.revision) throw new Error(`upstream checkout revision mismatch for ${authority.id}: ${head}`);

    const typeSpec = await realFile(checkout, authority.typespec_path, `${authority.id}.typespec_path`);
    const schema = await realFile(checkout, authority.json_schema_path, `${authority.id}.json_schema_path`);
    const typeSpecBytes = await readFile(typeSpec);
    const schemaBytes = await readFile(schema);
    const actualTypeSpecBlob = gitBlobSha(typeSpecBytes);
    const actualSchemaBlob = gitBlobSha(schemaBytes);
    if (actualTypeSpecBlob !== authority.typespec_blob_sha) throw new Error(`TypeSpec blob drift for ${authority.id}`);
    if (actualSchemaBlob !== authority.json_schema_blob_sha) throw new Error(`JSON Schema blob drift for ${authority.id}`);

    const conformance = runJsonNode(checkout, 'conformance/check.mjs');
    if (conformance.contractsSha256 !== authority.contracts_sha256) throw new Error(`contracts digest drift for ${authority.id}`);
    if (conformance.corpusSha256 !== authority.corpus_sha256) throw new Error(`corpus digest drift for ${authority.id}`);
    if (conformance.conformanceSpecSha256 !== authority.conformance_spec_sha256) throw new Error(`conformance spec digest drift for ${authority.id}`);

    const governance = runJsonNode(checkout, 'governance/check.mjs');
    if (!Array.isArray(governance.authorities) || !governance.authorities.includes('ores-context-propagation-v1')) {
      throw new Error(`upstream governance does not admit context propagation authority: ${authority.id}`);
    }

    const cases = await behaviorCaseIds(checkout);
    const declared = new Set(authority.conformance_case_ids);
    if (declared.size !== authority.conformance_case_ids.length) throw new Error(`duplicate declared conformance case id for ${authority.id}`);
    const missing = [...declared].filter((id) => !cases.has(id));
    if (missing.length) throw new Error(`upstream behavior cases missing for ${authority.id}: ${missing.join(', ')}`);

    receipts.push({
      id: authority.id,
      repository: authority.repository,
      revision: head,
      contract_path: authority.contract_path,
      typespec_blob_sha: actualTypeSpecBlob,
      json_schema_blob_sha: actualSchemaBlob,
      contracts_sha256: conformance.contractsSha256,
      corpus_sha256: conformance.corpusSha256,
      conformance_spec_sha256: conformance.conformanceSpecSha256,
      conformance_case_ids: [...declared].sort()
    });
  }

  console.log(JSON.stringify({
    schema: 'ores.governance.upstream-authority-check/v1',
    repository: registry.repository,
    authority_count: receipts.length,
    authorities: receipts
  }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
