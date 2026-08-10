#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const roots = process.argv.slice(2);
if (roots.length === 0) roots.push(process.cwd());

const ignored = new Set([
  '.git', 'node_modules', 'dist', 'build', 'target', '.dart_tool',
  '.gleam', 'vendor', '.next', 'coverage',
]);
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.go', '.rs', '.gleam']);

const rules = [
  {
    runtime: 'node',
    extension: /\.(?:[cm]?js|tsx?)$/,
    server: /\b(?:createServer|\.listen\s*\(|fastify\s*\(|express\s*\()/,
    shutdown: /(?:createNodeHttpShutdown|ShutdownCoordinator|closeAllConnections|SIGTERM)/,
  },
  {
    runtime: 'go',
    extension: /\.go$/,
    server: /(?:http\.Server|ListenAndServe|Serve\s*\()/,
    shutdown: /(?:ServeHTTPWithShutdown|\.Shutdown\s*\(|signal\.Notify(?:Context)?)/,
  },
  {
    runtime: 'rust',
    extension: /\.rs$/,
    server: /(?:axum::serve|hyper::|HttpServer::new|Server::bind)/,
    shutdown: /(?:ShutdownCoordinator|graceful_shutdown|with_graceful_shutdown|ctrl_c\s*\()/,
  },
  {
    runtime: 'gleam',
    extension: /\.gleam$/,
    server: /(?:mist\.|wisp\.|start_http|start_https)/,
    shutdown: /(?:oresoftware_next_loggers\/shutdown|graceful|supervisor|application_stop)/,
  },
];

async function* walk(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (entry.isFile() && extensions.has(path.extname(entry.name))) yield file;
  }
}

const findings = [];
const thisScript = path.resolve(new URL(import.meta.url).pathname);
for (const root of roots) {
  const absoluteRoot = path.resolve(root);
  for await (const file of walk(absoluteRoot)) {
    const normalized = file.split(path.sep).join('/');
    if (path.resolve(file) === thisScript || /\/(?:test|tests|fixtures)\//.test(normalized) || /(?:_test\.go|\.test\.[cm]?[jt]sx?)$/.test(file)) continue;
    const source = await fs.readFile(file, 'utf8');
    for (const rule of rules) {
      if (!rule.extension.test(file) || !rule.server.test(source)) continue;
      findings.push({
        repositoryRoot: absoluteRoot,
        file: path.relative(absoluteRoot, file),
        runtime: rule.runtime,
        status: rule.shutdown.test(source) ? 'candidate-compliant' : 'needs-review',
      });
      break;
    }
  }
}

const summary = {
  schema: 'next-loggers/server-shutdown-audit/v1',
  roots: roots.map((root) => path.resolve(root)),
  candidates: findings.length,
  needsReview: findings.filter((finding) => finding.status === 'needs-review').length,
  findings,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = summary.needsReview === 0 ? 0 : 1;
