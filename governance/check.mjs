#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const fail = (message) => { console.error(`[governance] ${message}`); process.exitCode = 1; };
const pathSafe = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;

function repoPath(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || value.includes('\0')) throw new Error(`${label} must be repository-relative`);
  const absolute = resolve(root, value);
  const r = relative(root, absolute);
  if (r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) throw new Error(`${label} escapes repository root`);
  return absolute;
}

async function realFile(value, label) {
  const absolute = repoPath(value, label);
  const st = await lstat(absolute);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`${label} must be a real file: ${value}`);
  return absolute;
}

async function realDirectory(value, label) {
  const absolute = repoPath(value, label);
  const st = await lstat(absolute);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${label} must be a real directory: ${value}`);
  return absolute;
}

function zpkgSdkTargets(source) {
  const targets = new Map();
  let current = null;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const top = line.match(/^\[targets\.([A-Za-z0-9_-]+)\]$/);
    if (top) { current = top[1]; continue; }
    if (/^\[/.test(line)) { current = null; continue; }
    if (!current) continue;
    const dir = line.match(/^dir\s*=\s*"([^"]+)"\s*$/);
    if (dir && dir[1].startsWith('sdk/')) targets.set(current, dir[1]);
  }
  return targets;
}

function cargoSdkMembers(source) {
  const members = new Set();
  let inWorkspace = false;
  let inMembers = false;
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '[workspace]') { inWorkspace = true; continue; }
    if (inWorkspace && /^\[/.test(line)) break;
    if (!inWorkspace) continue;
    if (line.startsWith('members')) { inMembers = true; }
    if (!inMembers) continue;
    for (const match of line.matchAll(/"(sdk\/[^"]+)"/g)) members.add(match[1]);
    if (line.includes(']')) inMembers = false;
  }
  return members;
}

try {
  const registry = JSON.parse(await readFile(await realFile('governance/polyglot-participants.v1.json', 'participant registry'), 'utf8'));
  if (registry.schema !== 'ores.governance.polyglot-participants/v1') throw new Error('invalid participant registry schema');
  if (registry.repository !== 'ores-otel/ores.otel.log') throw new Error('participant registry repository mismatch');
  if (!Array.isArray(registry.participants) || registry.participants.length === 0) throw new Error('participants must be non-empty');
  for (const [key, value] of Object.entries(registry.policy ?? {})) if (value !== true && !(key === 'runtime_specific_goldens_allowed' && value === false)) throw new Error(`unsafe governance policy: ${key}`);
  if (registry.policy?.runtime_specific_goldens_allowed !== false) throw new Error('runtime-specific goldens must remain forbidden');

  const sdkRoot = await realDirectory('sdk', 'sdk root');
  const sdkPaths = [];
  for (const entry of (await readdir(sdkRoot, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`sdk/ may contain only real participant directories: ${entry.name}`);
    sdkPaths.push(`sdk/${entry.name}`);
  }

  const ids = new Set();
  const paths = new Set();
  const zpkgDeclared = new Map();
  const cargoDeclared = new Set();
  for (const participant of registry.participants) {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) throw new Error('participant entry must be an object');
    if (typeof participant.id !== 'string' || !pathSafe.test(participant.id) || ids.has(participant.id)) throw new Error(`invalid or duplicate participant id: ${participant.id}`);
    ids.add(participant.id);
    if (typeof participant.path !== 'string' || paths.has(participant.path)) throw new Error(`invalid or duplicate participant path: ${participant.path}`);
    paths.add(participant.path);
    const dir = await realDirectory(participant.path, `participant ${participant.id}`);
    if (!relative(root, dir).split(sep).join('/').startsWith('sdk/')) throw new Error(`participant must live under sdk/: ${participant.id}`);
    if (!['portable-runtime','specialized-runtime','internal-support'].includes(participant.role)) throw new Error(`invalid role for ${participant.id}`);
    if (participant.zpkg_target !== null) {
      if (typeof participant.zpkg_target !== 'string' || !participant.zpkg_target) throw new Error(`invalid zpkg_target for ${participant.id}`);
      if (zpkgDeclared.has(participant.zpkg_target)) throw new Error(`duplicate zpkg target declaration: ${participant.zpkg_target}`);
      zpkgDeclared.set(participant.zpkg_target, participant.path);
    } else if (!['git-workspace','internal'].includes(participant.release_surface)) {
      throw new Error(`non-Zed participant requires an explicit release_surface: ${participant.id}`);
    }
    if (participant.cargo_workspace === true) cargoDeclared.add(participant.path);
    else if (participant.cargo_workspace !== false) throw new Error(`cargo_workspace must be boolean: ${participant.id}`);
  }

  const missing = sdkPaths.filter((path) => !paths.has(path));
  const stale = [...paths].filter((path) => !sdkPaths.includes(path));
  if (missing.length) throw new Error(`ungoverned sdk directories: ${missing.join(', ')}`);
  if (stale.length) throw new Error(`registry references missing sdk directories: ${stale.join(', ')}`);

  const actualZpkg = zpkgSdkTargets(await readFile(await realFile('.zpkg.toml', 'Zed manifest'), 'utf8'));
  for (const [target, path] of actualZpkg) if (zpkgDeclared.get(target) !== path) throw new Error(`Zed target ${target} -> ${path} is not governed exactly`);
  for (const [target, path] of zpkgDeclared) if (actualZpkg.get(target) !== path) throw new Error(`governed Zed target ${target} -> ${path} is missing or drifted`);

  const actualCargo = cargoSdkMembers(await readFile(await realFile('Cargo.toml', 'Cargo workspace'), 'utf8'));
  const cargoMissing = [...actualCargo].filter((path) => !cargoDeclared.has(path));
  const cargoStale = [...cargoDeclared].filter((path) => !actualCargo.has(path));
  if (cargoMissing.length || cargoStale.length) throw new Error(`Cargo workspace governance drift; missing=${cargoMissing.join(',')} stale=${cargoStale.join(',')}`);

  const manifest = JSON.parse(await readFile(await realFile('conformance/manifest.v1.json', 'conformance manifest'), 'utf8'));
  for (const required of manifest.requiredParticipants ?? []) {
    if (!required || typeof required.id !== 'string' || !ids.has(required.id)) throw new Error(`unknown required conformance participant: ${required?.id}`);
  }

  console.log(JSON.stringify({
    schema: 'ores.governance.polyglot-check/v1',
    participant_count: ids.size,
    participants: [...ids].sort(),
    zpkg_sdk_targets: [...actualZpkg.keys()].sort(),
    cargo_workspace_members: [...actualCargo].sort()
  }, null, 2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
