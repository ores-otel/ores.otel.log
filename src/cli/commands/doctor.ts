import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import type { CommandContext, CommandResult } from '../context.js';

type Status = 'PASS' | 'WARN' | 'FAIL';

interface Check {
  name: string;
  status: Status;
  detail: string;
  remedy?: string;
}

/**
 * Answers "will logging actually behave correctly here?".
 *
 * The check that justifies the command is async context tracking: when the
 * single-frame fallback is active, concurrent requests can observe each
 * other's context and one request's user id can be stamped on another's logs.
 * Nothing surfaces that at runtime, and no application calls
 * isAsyncContextTracked() by hand.
 */
export async function runDoctor(ctx: CommandContext): Promise<CommandResult> {
  const checks: Check[] = [];
  const add = (check: Check): void => void checks.push(check);

  const runtime =
    typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
      ? 'bun'
      : typeof (globalThis as { Deno?: unknown }).Deno !== 'undefined'
        ? 'deno'
        : 'node';
  add({ name: 'runtime', status: 'PASS', detail: runtime });

  const importFrom = async (relative: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(join(ctx.packageRoot, relative)).href)) as Record<
      string,
      unknown
    >;

  // ── Async context ───────────────────────────────────────────────────────
  try {
    const context = await importFrom('dist/context.js');
    const tracked = (context.isAsyncContextTracked as () => boolean)();
    add(
      tracked
        ? {
            name: 'async context',
            status: 'PASS',
            detail: 'AsyncLocalStorage active — concurrent flows are isolated',
          }
        : {
            name: 'async context',
            status: 'WARN',
            detail: 'single-frame fallback — concurrent requests can see each other\'s context',
            remedy:
              'On Cloudflare Workers set compatibility_flags = ["nodejs_als"]; in browsers attach a store via logger.setALS().',
          },
    );
  } catch (error) {
    add({
      name: 'async context',
      status: 'FAIL',
      detail: String(error),
      remedy: 'Build the package (npm run build) before running doctor.',
    });
  }

  // ── Config discovery ────────────────────────────────────────────────────
  try {
    const config = await importFrom('dist/config.js');
    const load = config.loadNextLoggerConfig as (options?: unknown) => Promise<{
      filepath?: string;
      options?: Record<string, unknown>;
    }>;
    const loaded = await load({});
    add(
      loaded.filepath
        ? { name: 'config file', status: 'PASS', detail: loaded.filepath }
        : {
            name: 'config file',
            status: 'PASS',
            detail: 'none found; using environment and defaults',
          },
    );
    const maxLevel = loaded.options?.maxLevel;
    add({
      name: 'effective maxLevel',
      status: 'PASS',
      detail: typeof maxLevel === 'string' ? maxLevel : 'INFO (default)',
    });
  } catch (error) {
    add({ name: 'config file', status: 'WARN', detail: String(error) });
  }

  // ── Level sanity ────────────────────────────────────────────────────────
  const rawLevel = ctx.env.NEXT_LOGGER_MAX_LEVEL;
  if (rawLevel) {
    const known = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
    const ok = known.includes(rawLevel.toUpperCase());
    add({
      name: 'NEXT_LOGGER_MAX_LEVEL',
      status: ok ? 'PASS' : 'WARN',
      detail: ok ? rawLevel : `unrecognized "${rawLevel}" — silently ignored, falls back to INFO`,
      ...(ok ? {} : { remedy: `Use one of: ${known.join(', ').toLowerCase()}.` }),
    });
  }

  // Supabase needs both halves; config.ts drops the whole block otherwise.
  if (ctx.env.NEXT_LOGGER_SUPABASE_URL && !ctx.env.NEXT_LOGGER_SUPABASE_ANON_KEY) {
    add({
      name: 'supabase transport',
      status: 'WARN',
      detail: 'NEXT_LOGGER_SUPABASE_URL set without NEXT_LOGGER_SUPABASE_ANON_KEY',
      remedy: 'Set both, or neither — the transport is dropped silently without the key.',
    });
  }

  // ── Platform capabilities ───────────────────────────────────────────────
  const capability = (name: string, present: boolean, remedy: string): void => {
    add({
      name,
      status: present ? 'PASS' : 'WARN',
      detail: present ? 'available' : 'missing',
      ...(present ? {} : { remedy }),
    });
  };
  capability(
    'fetch',
    typeof globalThis.fetch === 'function',
    'HttpTransport and error tracking need fetch; pass options.fetch on older runtimes.',
  );
  capability(
    'WebSocket',
    typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function',
    'Supabase Realtime and the browser stream need a WebSocket; pass a factory otherwise.',
  );

  const failures = checks.filter((check) => check.status === 'FAIL');
  const warnings = checks.filter((check) => check.status === 'WARN');
  const strict = ctx.bool('strict');

  if (ctx.json) {
    ctx.print(
      JSON.stringify({
        command: 'doctor',
        ok: failures.length === 0 && (!strict || warnings.length === 0),
        runtime,
        checks,
      }),
    );
  } else {
    const width = Math.max(...checks.map((check) => check.name.length));
    for (const check of checks) {
      ctx.print(`  ${check.status.padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`);
      if (check.remedy) {
        ctx.print(`        ${' '.repeat(width)}  → ${check.remedy}`);
      }
    }
    ctx.print(
      `\nnext-loggers doctor: ${failures.length} failed, ${warnings.length} warned, ` +
        `${checks.length - failures.length - warnings.length} passed`,
    );
  }

  if (failures.length > 0) {
    return { exitCode: 1 };
  }
  return { exitCode: strict && warnings.length > 0 ? 1 : 0 };
}
