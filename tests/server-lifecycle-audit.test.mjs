import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const auditScript = fileURLToPath(
  new URL('../scripts/audit-server-lifecycle.mjs', import.meta.url),
);

async function temporaryRepository(name) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'next-loggers-audit-'));
  const root = path.join(parent, name);
  await fs.mkdir(root, { recursive: true });
  return root;
}

function auditJson(root, ...extraArgs) {
  const stdout = execFileSync(
    process.execPath,
    [auditScript, '--format=json', ...extraArgs, root],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

test('reports a complete Node server lifecycle as low risk', async (t) => {
  const root = await temporaryRepository('node-complete');
  t.after(() => fs.rm(path.dirname(root), { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}\n');
  await fs.writeFile(
    path.join(root, 'server.ts'),
    `
      import { createServer } from 'node:http';
      import { AsyncLocalStorage } from 'node:async_hooks';
      const storage = new AsyncLocalStorage();
      const server = createServer((_request, response) => response.end('ok'));
      process.on('SIGINT', beginShutdown);
      process.on('SIGTERM', beginShutdown);
      process.stdin.once('end', forceShutdown);
      const interactive = process.stdin.isTTY;
      const timer = setTimeout(forceShutdown, 5000);
      function beginShutdown() {
        server.close();
        server.closeIdleConnections();
        logger.flush();
      }
      function forceShutdown() {
        clearTimeout(timer);
        server.closeAllConnections();
      }
      void storage;
      void interactive;
    `,
  );

  const report = auditJson(root);
  assert.equal(report.summary.scanned, 1);
  assert.equal(report.summary.servers, 1);
  assert.equal(report.repositories[0].risk, 'low');
  assert.deepEqual(report.repositories[0].languages.node.missing, []);
});

test('reports an uncoordinated Go server as high risk', async (t) => {
  const root = await temporaryRepository('go-incomplete');
  t.after(() => fs.rm(path.dirname(root), { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'go.mod'), 'module example.test/server\n\ngo 1.22\n');
  await fs.writeFile(
    path.join(root, 'main.go'),
    `package main

import "net/http"

func main() {
  _ = http.ListenAndServe(":8080", nil)
}
`,
  );

  const report = auditJson(root);
  const repository = report.repositories[0];
  assert.equal(repository.serverDetected, true);
  assert.equal(repository.risk, 'high');
  assert.ok(repository.missing.includes('graceful'));
  assert.ok(repository.missing.includes('force'));
  assert.ok(repository.missing.includes('context'));
});

test('--strict returns exit code 2 when a high-risk server is found', async (t) => {
  const root = await temporaryRepository('strict-incomplete');
  t.after(() => fs.rm(path.dirname(root), { recursive: true, force: true }));

  await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  await fs.writeFile(
    path.join(root, 'server.js'),
    "require('node:http').createServer((_req, res) => res.end()).listen(8080);\n",
  );

  const result = spawnSync(
    process.execPath,
    [auditScript, '--strict', '--format=json', root],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.highRisk, 1);
});
