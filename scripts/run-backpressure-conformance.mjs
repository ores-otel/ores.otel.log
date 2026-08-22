#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BACKPRESSURE_CONTRACT,
  runBackpressureVectorSet,
  sha256,
} from './backpressure-conformance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vectorPath = path.join(
  root,
  'contracts',
  'fixtures',
  'valid',
  'backpressure-conformance-vectors.json',
);
const vectorBytes = await readFile(vectorPath);
const vectorSet = JSON.parse(vectorBytes);
const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
let sourceSha = process.env.ORES_OTEL_SOURCE_SHA;
if (sourceSha === undefined) {
  const sourceStatus = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=no'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  if (sourceStatus !== '') {
    throw new Error('refusing to report conformance for a dirty source tree');
  }
  sourceSha = execFileSync(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
}

if (!/^(?!0{40}$)[0-9a-f]{40}$/.test(sourceSha)) {
  throw new TypeError('source SHA must be a non-zero, lowercase 40-character Git object id');
}

const results = runBackpressureVectorSet(vectorSet);
const report = {
  reportVersion: 'ores.otel.log/conformance-report/v1',
  contract: BACKPRESSURE_CONTRACT,
  schemaVersion: 1,
  vectorSet: vectorSet.vectorSet,
  vectorDigest: `sha256:${sha256(vectorBytes)}`,
  implementation: {
    language: 'nodejs',
    version: packageMetadata.version,
    sourceSha,
  },
  runtime: {
    name: 'node',
    version: process.versions.node,
  },
  results,
};

// Reports contain identities, counts, and stable rule IDs only. In particular,
// failure output never embeds the input receipt or any of its values.
process.stdout.write(`${JSON.stringify(report)}\n`);
if (results.failed !== 0) process.exitCode = 1;
