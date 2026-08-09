import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { CommandContext, CommandResult } from '../context.js';

/**
 * Walks this package's own `exports` map for a condition set.
 *
 * Resolution is reimplemented rather than delegated to import.meta.resolve so
 * a Node host can answer for workerd, browser and edge-light too — the whole
 * point is predicting what OTHER runtimes will load. docs/AUDIT.md records a
 * shipped bug of exactly this class: ./context had no workerd condition, so a
 * Worker without nodejs_als crashed at module evaluation.
 */

/** Condition sets each runtime presents, in the order resolvers apply them. */
const RUNTIME_CONDITIONS: Record<string, string[]> = {
  node: ['node', 'import', 'default'],
  bun: ['bun', 'node', 'import', 'default'],
  deno: ['deno', 'import', 'default'],
  browser: ['browser', 'import', 'default'],
  workerd: ['workerd', 'worker', 'import', 'default'],
  'edge-light': ['edge-light', 'worker', 'import', 'default'],
};

type ExportsNode = string | { [condition: string]: ExportsNode } | null;

/**
 * First matching key wins, in declaration order — which is why the order of
 * conditions inside package.json matters and why `workerd` must precede
 * `worker` there.
 */
function resolveNode(node: ExportsNode, conditions: ReadonlySet<string>): string | undefined {
  if (node === null) {
    return undefined;
  }
  if (typeof node === 'string') {
    return node;
  }
  for (const [condition, child] of Object.entries(node)) {
    if (condition === 'types') {
      continue;
    }
    if (condition === 'default' || conditions.has(condition)) {
      const resolved = resolveNode(child, conditions);
      if (resolved !== undefined) {
        return resolved;
      }
    }
  }
  return undefined;
}

export async function runResolve(ctx: CommandContext): Promise<CommandResult> {
  let manifest: { exports?: Record<string, ExportsNode> };
  try {
    manifest = JSON.parse(
      await readFile(join(ctx.packageRoot, 'package.json'), 'utf8'),
    ) as typeof manifest;
  } catch (error) {
    ctx.printErr(`next-loggers resolve: cannot read package.json — ${String(error)}`);
    return { exitCode: 1 };
  }

  const explicit = ctx.list('condition');
  const runtime = ctx.flag('runtime');
  let conditions: string[];
  if (explicit.length > 0) {
    conditions = explicit;
  } else if (runtime) {
    const known = RUNTIME_CONDITIONS[runtime];
    if (!known) {
      ctx.printErr(
        `next-loggers resolve: unknown runtime "${runtime}"; expected one of ${Object.keys(RUNTIME_CONDITIONS).join(', ')}`,
      );
      return { exitCode: 2 };
    }
    conditions = known;
  } else {
    conditions = RUNTIME_CONDITIONS.node as string[];
  }

  const conditionSet = new Set(conditions);
  const exportsMap = manifest.exports ?? {};
  const wanted = ctx.flag('subpath');
  const subpaths = wanted ? [wanted] : Object.keys(exportsMap);

  const rows: Array<{ subpath: string; file: string | null }> = [];
  for (const subpath of subpaths) {
    const node = exportsMap[subpath];
    if (node === undefined) {
      ctx.printErr(`next-loggers resolve: no export declared for "${subpath}"`);
      return { exitCode: 1 };
    }
    rows.push({ subpath, file: resolveNode(node, conditionSet) ?? null });
  }

  if (ctx.json) {
    ctx.print(
      JSON.stringify({
        command: 'resolve',
        conditions,
        resolved: Object.fromEntries(rows.map((row) => [row.subpath, row.file])),
      }),
    );
    return { exitCode: 0 };
  }

  ctx.print(`conditions: ${conditions.join(', ')}`);
  const width = Math.max(...rows.map((row) => row.subpath.length));
  for (const row of rows) {
    ctx.print(`  ${row.subpath.padEnd(width)}  →  ${row.file ?? '(unresolved)'}`);
  }
  return { exitCode: rows.some((row) => row.file === null) ? 1 : 0 };
}
