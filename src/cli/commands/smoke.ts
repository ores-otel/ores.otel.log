import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import type { CommandContext, CommandResult } from '../context.js';

/**
 * Verifies an INSTALLED build, not the working tree.
 *
 * This is what `.zpkg.toml`'s publish.smoke_test runs under `zed r2g`, where
 * ZED_PKG_TEST_TARGET points at the package as a real consumer would have it.
 * Because it imports from dist/, it is also the only automatic guard against
 * publishing a stale or missing build — `zed publish` itself only warns.
 */
export async function runSmoke(ctx: CommandContext): Promise<CommandResult> {
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const record = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
  };

  const target =
    ctx.flag('package') ?? ctx.env.ZED_PKG_TEST_TARGET ?? ctx.packageRoot;
  const depth = ctx.flag('depth') ?? 'basic';
  const expected = ctx.flag('expect_runtime');
  const started = Date.now();

  const importFrom = async (relative: string): Promise<Record<string, unknown>> => {
    // pathToFileURL, not a bare absolute path: import() of a plain path is not
    // portable to Windows.
    const url = pathToFileURL(join(target, relative)).href;
    return (await import(url)) as Record<string, unknown>;
  };

  let base: Record<string, unknown>;
  try {
    base = await importFrom('dist/base-logger.js');
    record('import dist/base-logger.js', true);
  } catch (error) {
    record('import dist/base-logger.js', false, String(error));
    return finish(ctx, checks, target, depth, started);
  }

  try {
    const smoke = base.r2gSmokeTest as (() => Promise<boolean>) | undefined;
    if (typeof smoke !== 'function') {
      record('r2gSmokeTest export', false, 'not a function');
    } else {
      const passed = await smoke();
      record('r2gSmokeTest delivers a record', passed === true);
    }
  } catch (error) {
    record('r2gSmokeTest delivers a record', false, String(error));
  }

  let rootRuntime: string | undefined;
  try {
    const root = await importFrom('dist/node-logger.js');
    const logger = root.logger as { runtime?: string } | undefined;
    rootRuntime = logger?.runtime;
    record('node entry exposes a logger', typeof rootRuntime === 'string', rootRuntime);
    if (expected) {
      record(`runtime is "${expected}"`, rootRuntime === expected, rootRuntime);
    }
  } catch (error) {
    record('node entry exposes a logger', false, String(error));
  }

  if (depth === 'full') {
    // The assertions .r2g/tests/runtime-consumer.mjs already makes, run
    // against the installed artifact instead of the source tree.
    try {
      const createLogger = base.createLogger as (options: unknown) => {
        warn: (...values: unknown[]) => { send: () => Promise<void> };
        close: () => Promise<void>;
      };
      const records: Array<Record<string, unknown>> = [];
      const logger = createLogger({
        console: false,
        transports: { write: (r: Record<string, unknown>) => void records.push(r) },
      });
      await logger.warn('smoke', { password: 'hunter2', attempt: 1 }).send();
      const values = records[0]?.values as Array<Record<string, unknown>> | undefined;
      record('redaction masks password', values?.[1]?.password === '[REDACTED]');
      record('non-secret fields survive redaction', values?.[1]?.attempt === 1);
      await logger.close();
    } catch (error) {
      record('redaction masks password', false, String(error));
    }

    try {
      const serialize = base.serializeLogValue as (
        value: unknown,
        limits?: unknown,
      ) => unknown;
      const truncated = serialize('z'.repeat(200), { maxStringLength: 10 }) as string;
      record('serializer honours limits', truncated.startsWith('zzzzzzzzzz…[truncated'));
    } catch (error) {
      record('serializer honours limits', false, String(error));
    }

    try {
      const context = await importFrom('dist/context.js');
      const runWith = context.runWithLogContext as <T>(c: unknown, fn: () => T) => T;
      const get = context.getLogContext as () => { traceId?: string } | undefined;
      const seen = runWith({ traceId: 'smoke-trace' }, () => get()?.traceId);
      record('ambient context propagates', seen === 'smoke-trace');
      record('context frame is restored', get() === undefined);
    } catch (error) {
      record('ambient context propagates', false, String(error));
    }
  }

  return finish(ctx, checks, target, depth, started);
}

function finish(
  ctx: CommandContext,
  checks: Array<{ name: string; ok: boolean; detail?: string }>,
  target: string,
  depth: string,
  started: number,
): CommandResult {
  const failures = checks.filter((check) => !check.ok);
  const elapsed = Date.now() - started;

  if (ctx.json) {
    ctx.print(
      JSON.stringify({
        command: 'smoke',
        ok: failures.length === 0,
        target,
        depth,
        elapsedMs: elapsed,
        checks,
      }),
    );
    return { exitCode: failures.length === 0 ? 0 : 1 };
  }

  if (failures.length === 0) {
    ctx.print(
      `next-loggers smoke: PASS (depth=${depth}, ${checks.length} checks, ${elapsed}ms)`,
    );
    return { exitCode: 0 };
  }

  ctx.printErr(`next-loggers smoke: FAIL (${failures.length}/${checks.length} checks)`);
  failures.forEach((failure, index) => {
    ctx.printErr(`  ${index + 1}. ${failure.name}${failure.detail ? ` — ${failure.detail}` : ''}`);
  });
  ctx.printErr(`  target: ${target}`);
  return { exitCode: 1 };
}
