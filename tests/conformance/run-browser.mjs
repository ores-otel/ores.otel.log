#!/usr/bin/env node
/**
 * Browser driver: bundles the conformance suite with esbuild (forcing the
 * `browser` export condition, exactly as a real app bundler would), serves it
 * on a throwaway page, and drives a headless Chromium through Playwright.
 *
 * This is the only runtime that cannot import the package directly from the
 * test process, so the bundling step is part of what is under test: it proves
 * the browser condition resolves and that nothing drags node:async_hooks into
 * a client bundle.
 */
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The generated entry must live INSIDE the package: esbuild resolves bare
// specifiers relative to the importing file, so Node's package self-reference
// (`@oresoftware/next-loggers/...` from within the package itself) only works
// when the entry sits under this directory. An entry in os.tmpdir() fails to
// resolve even with absWorkingDir set.
const SCRATCH_DIR = '.conformance-tmp';

const ENTRY = `
import { formatResult, runConformance } from '../tests/conformance/runtime-conformance.mjs';
import { createBrowserLogger } from '@oresoftware/next-loggers/browser';
import { BrowserStreamTransport } from '@oresoftware/next-loggers/browser-stream';

window.__conformance = (async () => {
  // Browsers have no AsyncLocalStorage; the context entry must say so.
  const result = await runConformance({ runtime: 'browser', expectAsyncContext: false });

  if (result.detectedRuntime !== 'browser') {
    result.failures.push('root export resolved to "' + result.detectedRuntime + '", expected "browser"');
  }

  // The browser logger streams over a real WebSocket to the echo server.
  const streamed = [];
  const transport = new BrowserStreamTransport({
    url: window.__wsUrl,
    batchSize: 10,
    flushOnPageHide: false,
    onError: (e) => result.failures.push('stream error: ' + String(e)),
  });
  const log = createBrowserLogger({
    console: false,
    flushOnUnload: false,
    includeDeviceContext: true,
    transports: { write: (r) => void streamed.push(r) },
    stream: {
      url: window.__wsUrl,
      batchSize: 10,
      flushOnPageHide: false,
    },
  });

  await log.error('browser stream probe').send();
  await log.flush({ timeoutMillis: 3000 });
  await log.streamTransport.flush();

  if (streamed.length !== 1) {
    result.failures.push('expected 1 record via transports, got ' + streamed.length);
  }
  if (typeof streamed[0]?.fields?.screenWidth !== 'number') {
    result.failures.push('includeDeviceContext did not attach screenWidth');
  }
  if (typeof streamed[0]?.fields?.url !== 'string') {
    result.failures.push('page context did not attach url');
  }

  transport.write(streamed[0]);
  await transport.flush();
  await transport.close();
  await log.close();

  return { text: formatResult(result), failures: result.failures };
})();
`;

async function main() {
  const [{ build }, { chromium }] = await Promise.all([
    import('esbuild'),
    import('playwright'),
  ]);

  await mkdir(SCRATCH_DIR, { recursive: true });
  const entryPath = join(SCRATCH_DIR, 'browser-entry.mjs');
  await writeFile(entryPath, ENTRY, 'utf8');

  const bundle = await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    // The condition under test: a client bundle must never pull in node:*.
    conditions: ['browser', 'import'],
    absWorkingDir: process.cwd(),
    write: false,
    logLevel: 'silent',
  });
  const code = bundle.outputFiles[0].text;

  if (/node:async_hooks/.test(code)) {
    console.error('[conformance:browser] FAILED — node:async_hooks leaked into the browser bundle');
    process.exit(1);
  }

  // Minimal WebSocket echo endpoint so the stream transport talks to a real socket.
  const { WebSocketServer } = await import('ws');
  const received = [];
  const httpServer = createServer((req, res) => {
    if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(code);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset="utf-8"><title>conformance</title>');
  });
  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (socket) => {
    socket.on('message', (data) => received.push(String(data)));
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  const browser = await chromium.launch();
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));

    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate((wsUrl) => {
      window.__wsUrl = wsUrl;
    }, `ws://127.0.0.1:${port}/`);
    await page.addScriptTag({ url: '/app.js', type: 'module' });
    await page.waitForFunction(() => window.__conformance !== undefined);

    const result = await page.evaluate(() => window.__conformance);
    console.log(result.text);

    for (const error of consoleErrors) {
      console.error(`  ✗ uncaught page error: ${error}`);
    }

    // Give the socket a moment to deliver the last frames.
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (received.length === 0) {
      console.error('  ✗ no log batches arrived over the WebSocket');
      exitCode = 1;
    } else {
      const batch = JSON.parse(received[0]);
      console.log(
        `[conformance:browser] WebSocket received ${received.length} batch(es), ` +
          `first carried ${batch.records?.length} record(s)`,
      );
    }

    if (result.failures.length > 0 || consoleErrors.length > 0) {
      exitCode = 1;
    }
  } finally {
    await browser.close();
    wss.close();
    httpServer.close();
    await rm(SCRATCH_DIR, { recursive: true, force: true });
  }

  if (exitCode !== 0) {
    console.error('[conformance:browser] FAILED');
  }
  process.exit(exitCode);
}

await main();
