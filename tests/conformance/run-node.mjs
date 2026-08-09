#!/usr/bin/env node
// Node / Bun / Deno driver. All three resolve `node:*` and the package's
// export conditions natively, so one entry point covers them; the expected
// runtime label differs and is asserted below.
import { formatResult, runConformance } from './runtime-conformance.mjs';

const isBun = typeof globalThis.Bun !== 'undefined';
const isDeno = typeof globalThis.Deno !== 'undefined';
const runtime = isBun ? 'bun' : isDeno ? 'deno' : 'node';

// Node, Bun and Deno all implement node:async_hooks AsyncLocalStorage, so the
// context entry point must report real async tracking on every one of them.
const result = await runConformance({ runtime, expectAsyncContext: true });

if (result.detectedRuntime !== runtime) {
  result.failures.push(
    `root export resolved to "${result.detectedRuntime}", expected "${runtime}" — check package.json export conditions`,
  );
}

console.log(formatResult(result));

if (result.failures.length > 0) {
  console.error(`[conformance:${runtime}] FAILED with ${result.failures.length} failure(s)`);
  const exit = globalThis.Deno?.exit ?? process.exit;
  exit(1);
}
