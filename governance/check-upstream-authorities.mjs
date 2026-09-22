#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const snapshotsRoot = resolve(here, 'upstream-snapshots');
const fail = (message) => { console.error(`[upstream-authority] ${message}`); process.exitCode = 1; };
const hex40 = /^[0-9a-f]{40}$/;
const hex64 = /^[0-9a-f]{64}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function within(base, target) {
  const r = relative(base, target);
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}

function repoRelative(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value)) throw new Error(`${label} must be a non-empty repository-relative path`);
  const absolute = resolve(root, value);
  if (!within(root, absolute)) throw new Error(`${label} escapes repository root`);
  return absolute;
}

async function realFile(base, value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0') || isAbsolute(value)) throw new Error(`${label} must be relative`);
  const absolute = resolve(base, value);
  if (!within(base, absolute)) throw new Error(`${label} escapes snapshot root`);
  const rel = relative(base, absolute);
  let cursor = base;
  for (const part of rel.split(sep)) {
    if (!part) continue;
    cursor = resolve(cursor, part);
    const st = await lstat(cursor);
    if (st.isSymbolicLink()) throw new Error(`${label} traverses symlink: ${value}`);
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

try {
  const registry = JSON.parse(await readFile(repoRelative('governance/upstream-authorities.v1.json', 'upstream registry'), 'utf8'));
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
    if (!hex40.test(authority.revision)) throw new Error(`authority revision must be immutable 40-hex: ${authority.id}`);
    for (const key of ['typespec_blob_sha', 'json_schema_blob_sha']) if (!hex40.test(authority[key])) throw new Error(`${key} must be 40-hex: ${authority.id}`);
    for (const key of ['contracts_sha256', 'corpus_sha256', 'conformance_spec_sha256']) if (!hex64.test(authority[key])) throw new Error(`${key} must be sha256: ${authority.id}`);
    if (!Array.isArray(authority.conformance_case_ids) || authority.conformance_case_ids.length === 0) throw new Error(`authority must declare behavior case ids: ${authority.id}`);

    const snapshotDir = resolve(snapshotsRoot, authority.repository.replace('/', '__'));
    if (!within(snapshotsRoot, snapshotDir)) throw new Error(`invalid snapshot directory for ${authority.repository}`);
    const dirStat = await lstat(snapshotDir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(`missing real snapshot directory for ${authority.repository}`);
    const snapshot = JSON.parse(await readFile(await realFile(snapshotDir, 'snapshot.v1.json', 'snapshot manifest'), 'utf8'));
    if (snapshot.schema !== 'ores.governance.upstream-snapshot/v1') throw new Error(`invalid snapshot schema for ${authority.id}`);
    if (snapshot.repository !== authority.repository || snapshot.revision !== authority.revision) throw new Error(`snapshot source identity drift for ${authority.id}`);
    if (snapshot.source_receipt?.contracts_sha256 !== authority.contracts_sha256 || snapshot.source_receipt?.corpus_sha256 !== authority.corpus_sha256 || snapshot.source_receipt?.conformance_spec_sha256 !== authority.conformance_spec_sha256) throw new Error(`snapshot source receipt drift for ${authority.id}`);
    if (!Array.isArray(snapshot.files) || snapshot.files.length === 0) throw new Error(`snapshot files must be non-empty for ${authority.id}`);

    const upstreamPaths = new Set();
    const localPaths = new Set();
    const observed = new Map();
    for (const file of snapshot.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`invalid snapshot file entry for ${authority.id}`);
      if (typeof file.upstream_path !== 'string' || !file.upstream_path || upstreamPaths.has(file.upstream_path)) throw new Error(`duplicate/invalid upstream path for ${authority.id}`);
      if (typeof file.local_path !== 'string' || !file.local_path || localPaths.has(file.local_path)) throw new Error(`duplicate/invalid local snapshot path for ${authority.id}`);
      if (!hex40.test(file.git_blob_sha)) throw new Error(`invalid git blob sha for ${file.local_path}`);
      upstreamPaths.add(file.upstream_path);
      localPaths.add(file.local_path);
      const local = await realFile(snapshotDir, file.local_path, `snapshot file ${file.local_path}`);
      const bytes = await readFile(local);
      const actualBlob = gitBlobSha(bytes);
      if (actualBlob !== file.git_blob_sha) throw new Error(`snapshot byte drift for ${file.upstream_path}`);
      observed.set(file.upstream_path, { file, bytes });
    }

    const typeSpec = observed.get(authority.typespec_path);
    const schema = observed.get(authority.json_schema_path);
    if (!typeSpec || typeSpec.file.git_blob_sha !== authority.typespec_blob_sha) throw new Error(`TypeSpec snapshot missing or drifted for ${authority.id}`);
    if (!schema || schema.file.git_blob_sha !== authority.json_schema_blob_sha) throw new Error(`JSON Schema snapshot missing or drifted for ${authority.id}`);

    const caseIds = new Set();
    for (const { file, bytes } of observed.values()) {
      if (!file.upstream_path.startsWith('conformance/cases/') || !file.upstream_path.endsWith('.json')) continue;
      const value = JSON.parse(bytes.toString('utf8'));
      if (value?.schema !== 'ores.conformance.case/v1' || value?.kind !== 'behavior' || typeof value.id !== 'string' || !value.id) throw new Error(`malformed vendored behavior case: ${file.upstream_path}`);
      if (caseIds.has(value.id)) throw new Error(`duplicate vendored behavior case id: ${value.id}`);
      caseIds.add(value.id);
    }
    const declared = new Set(authority.conformance_case_ids);
    if (declared.size !== authority.conformance_case_ids.length) throw new Error(`duplicate declared conformance case id for ${authority.id}`);
    const missing = [...declared].filter((id) => !caseIds.has(id));
    const extra = [...caseIds].filter((id) => !declared.has(id));
    if (missing.length || extra.length) throw new Error(`snapshot case-set drift for ${authority.id}; missing=${missing.join(',')} extra=${extra.join(',')}`);

    receipts.push({
      id: authority.id,
      repository: authority.repository,
      revision: authority.revision,
      snapshot_file_count: snapshot.files.length,
      typespec_blob_sha: typeSpec.file.git_blob_sha,
      json_schema_blob_sha: schema.file.git_blob_sha,
      contracts_sha256: authority.contracts_sha256,
      corpus_sha256: authority.corpus_sha256,
      conformance_spec_sha256: authority.conformance_spec_sha256,
      conformance_case_ids: [...caseIds].sort()
    });
  }

  console.log(JSON.stringify({
    schema: 'ores.governance.upstream-authority-check/v1',
    repository: registry.repository,
    mode: 'vendored-immutable-lock',
    authority_count: receipts.length,
    authorities: receipts
  }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
